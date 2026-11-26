import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Ctx } from './context.ts';
import { one, run } from './db.ts';
import { AppError } from './errors.ts';
import { newId } from './ids.ts';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export type Role = 'organiser' | 'gate';

export interface SessionInfo {
  /** sha256 of the cookie token: the session's identity everywhere in the database. */
  id: string;
  userId: string | null;
  role: Role | null;
  username: string | null;
  displayName: string | null;
}

const ANON_TTL_MS = 7 * 24 * 3600_000;
const STAFF_TTL_MS = 12 * 3600_000;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 32);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, saltB64, hashB64] = stored.split('$');
  if (alg !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const got = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length);
  return timingSafeEqual(expected, got);
}

export async function createUser(
  ctx: Ctx,
  u: { username: string; password: string; role: Role; displayName: string },
): Promise<string> {
  const id = newId('usr', 8);
  run(
    ctx.db,
    `INSERT INTO users (id, username, password_hash, role, display_name) VALUES (?, ?, ?, ?, ?)`,
    id,
    u.username,
    await hashPassword(u.password),
    u.role,
    u.displayName,
  );
  return id;
}

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export function createSession(
  ctx: Ctx,
  userId: string | null,
): { token: string; id: string; maxAgeMs: number } {
  const token = randomBytes(32).toString('base64url');
  const maxAgeMs = userId ? STAFF_TTL_MS : ANON_TTL_MS;
  const now = ctx.clock.now();
  run(
    ctx.db,
    `INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`,
    hashToken(token),
    userId,
    now,
    now + maxAgeMs,
  );
  return { token, id: hashToken(token), maxAgeMs };
}

export function resolveSession(ctx: Ctx, token: string | undefined): SessionInfo | null {
  if (!token) return null;
  const row = one<{
    token_hash: string;
    user_id: string | null;
    expires_at: number;
    role: Role | null;
    username: string | null;
    display_name: string | null;
  }>(
    ctx.db,
    `SELECT s.token_hash, s.user_id, s.expires_at, u.role, u.username, u.display_name
       FROM sessions s LEFT JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
    hashToken(token),
  );
  if (!row || row.expires_at <= ctx.clock.now()) return null;
  return {
    id: row.token_hash,
    userId: row.user_id,
    role: row.role,
    username: row.username,
    displayName: row.display_name,
  };
}

export function destroySession(ctx: Ctx, token: string | undefined): void {
  if (token) run(ctx.db, `DELETE FROM sessions WHERE token_hash = ?`, hashToken(token));
}

const failures = new Map<string, { count: number; first: number }>();
const WINDOW_MS = 60_000;
const MAX_FAILURES = 8;

/** Verifies credentials; throttles repeated failures per username. Returns a fresh staff session. */
export async function login(ctx: Ctx, username: string, password: string) {
  const now = ctx.clock.now();
  const f = failures.get(username);
  if (f && now - f.first < WINDOW_MS && f.count >= MAX_FAILURES) {
    throw new AppError(429, 'too_many_attempts', 'Too many sign-in attempts. Wait a minute and try again.');
  }
  const user = one<{ id: string; password_hash: string; role: Role; display_name: string }>(
    ctx.db,
    `SELECT id, password_hash, role, display_name FROM users WHERE username = ?`,
    username,
  );
  // Always run one scrypt, so unknown usernames cost the same as wrong passwords.
  const ok = await verifyPassword(
    password,
    user?.password_hash ?? 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  );
  if (!user || !ok) {
    const cur = f && now - f.first < WINDOW_MS ? f : { count: 0, first: now };
    failures.set(username, { count: cur.count + 1, first: cur.first });
    throw new AppError(401, 'bad_credentials', 'Wrong username or password');
  }
  failures.delete(username);
  const session = createSession(ctx, user.id);
  return { session, user: { username, role: user.role, displayName: user.display_name } };
}
