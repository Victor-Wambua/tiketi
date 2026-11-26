import { createHash } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { createSession, resolveSession, type Role, type SessionInfo } from '../auth.ts';
import type { Ctx } from '../context.ts';
import { one, run, tx } from '../db.ts';
import { AppError, forbidden, unauthorized } from '../errors.ts';

export type Env = { Variables: { session: SessionInfo | null } };
export const COOKIE = 'tk_sid';

export function setSessionCookie(c: Context, token: string, maxAgeMs: number): void {
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    secure: c.req.url.startsWith('https:'),
    maxAge: Math.floor(maxAgeMs / 1000),
  });
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, COOKIE, { path: '/' });
}

/** Resolves the cookie to a session (if any). Never creates one. */
export const sessionMiddleware =
  (ctx: Ctx): MiddlewareHandler<Env> =>
  async (c, next) => {
    c.set('session', resolveSession(ctx, getCookie(c, COOKIE)));
    await next();
  };

/** Returns the caller's session, creating an anonymous customer session on first use. */
export function ensureSession(ctx: Ctx, c: Context<Env>): SessionInfo {
  const existing = c.get('session');
  if (existing) return existing;
  const { token, id, maxAgeMs } = createSession(ctx, null);
  setSessionCookie(c, token, maxAgeMs);
  const created: SessionInfo = { id, userId: null, role: null, username: null, displayName: null };
  c.set('session', created);
  return created;
}

export const requireRole =
  (...roles: Role[]): MiddlewareHandler<Env> =>
  async (c, next) => {
    const s = c.get('session');
    if (!s?.role) throw unauthorized();
    if (!roles.includes(s.role)) throw forbidden('Your role cannot do that');
    await next();
  };

export const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  const h = c.res.headers;
  h.set(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; media-src 'self' blob:; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  );
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('X-Frame-Options', 'DENY');
  h.set('Referrer-Policy', 'no-referrer');
  h.set('Permissions-Policy', 'camera=(self), geolocation=(), microphone=()');
  if (c.req.path.startsWith('/api/')) h.set('Cache-Control', 'no-store');
};

const KEY_RE = /^[A-Za-z0-9_-]{8,64}$/;
const SKIP = [/^\/api\/auth\//, /^\/api\/webhooks\//, /^\/api\/mock\//];

/**
 * Idempotency for every mutating endpoint (webhooks, sign-in/out and the mock phone are exempt:
 * the webhook has its own de-duplication). The client sends `Idempotency-Key`; the first request
 * with a key runs and its response is stored, a retry with the same key and body replays that
 * response, the same key with a different body is rejected, and a retry that arrives while the
 * first is still running gets 409.
 */
export const idempotency =
  (ctx: Ctx): MiddlewareHandler<Env> =>
  async (c, next) => {
    const m = c.req.method;
    if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS' || SKIP.some((r) => r.test(c.req.path))) return next();
    const key = c.req.header('idempotency-key');
    if (!key || !KEY_RE.test(key)) {
      throw new AppError(
        400,
        'idempotency_key_required',
        'Send an Idempotency-Key header (8-64 letters, digits, - or _)',
      );
    }
    const session = ensureSession(ctx, c);
    const body = await c.req.text();
    const hash = createHash('sha256').update(`${m} ${c.req.path}\n${body}`).digest('hex');

    const state = tx(ctx.db, () => {
      const row = one<{ request_hash: string; status: number | null; body: string | null }>(
        ctx.db,
        `SELECT request_hash, status, body FROM idempotency_keys WHERE scope = ? AND key = ?`,
        session.id,
        key,
      );
      if (!row) {
        run(
          ctx.db,
          `INSERT INTO idempotency_keys (scope, key, request_hash, created_at) VALUES (?, ?, ?, ?)`,
          session.id,
          key,
          hash,
          ctx.clock.now(),
        );
        return { kind: 'run' as const };
      }
      if (row.request_hash !== hash) return { kind: 'mismatch' as const };
      if (row.status === null) return { kind: 'busy' as const };
      return { kind: 'replay' as const, status: row.status, body: row.body ?? '' };
    });

    if (state.kind === 'mismatch') {
      throw new AppError(
        422,
        'idempotency_key_reuse',
        'That Idempotency-Key was already used for a different request',
      );
    }
    if (state.kind === 'busy')
      throw new AppError(409, 'request_in_progress', 'The first request with this key is still running');
    if (state.kind === 'replay') {
      return new Response(state.body, {
        status: state.status,
        headers: { 'content-type': 'application/json', 'idempotent-replay': 'true' },
      });
    }

    await next();
    const status = c.res.status;
    if (status >= 500) {
      run(ctx.db, `DELETE FROM idempotency_keys WHERE scope = ? AND key = ?`, session.id, key); // safe to retry
    } else {
      const text = await c.res.clone().text();
      run(
        ctx.db,
        `UPDATE idempotency_keys SET status = ?, body = ? WHERE scope = ? AND key = ?`,
        status,
        text,
        session.id,
        key,
      );
    }
    return undefined;
  };
