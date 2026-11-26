import assert from 'node:assert/strict';
import { test } from 'node:test';
import { all, one } from '../src/server/db.ts';
import { Client, DEP, addStaff, buy, makeEnv, staffClient } from './helpers.ts';

const STAFF_ENDPOINTS: [string, string, unknown?][] = [
  ['GET', '/api/gate/config'],
  ['GET', `/api/gate/manifest/${DEP}`],
  ['POST', '/api/gate/scans', { code: 'x', gate: 'A' }],
  ['POST', '/api/gate/scans/batch', { scans: [{ code: 'x', gate: 'A' }] }],
  ['GET', '/api/admin/departures'],
  ['GET', `/api/admin/departures/${DEP}/dashboard`],
  ['GET', `/api/admin/departures/${DEP}/export.csv`],
  ['POST', '/api/admin/refunds/rfd_x/process'],
];

test('anonymous visitors get 401 on every staff endpoint', async () => {
  const env = makeEnv();
  const c = new Client(env.app);
  for (const [m, p, body] of STAFF_ENDPOINTS) {
    const r = await c.call(m, p, body);
    assert.equal(r.status, 401, `${m} ${p}`);
  }
});

test('gate staff can scan but are forbidden from the organiser endpoints; organisers can do both', async () => {
  const env = makeEnv();
  await addStaff(env);
  const gate = await staffClient(env, 'gatey');
  const boss = await staffClient(env, 'boss');
  for (const [m, p, body] of STAFF_ENDPOINTS) {
    const isAdmin = p.startsWith('/api/admin');
    const g = await gate.call(m, p, body);
    if (isAdmin) assert.equal(g.status, 403, `gate ${m} ${p}`);
    else assert.notEqual(g.status, 403, `gate ${m} ${p}`);
    const b = await boss.call(m, p, body);
    assert.ok(![401, 403].includes(b.status), `organiser ${m} ${p} -> ${b.status}`);
  }
});

test('login: wrong password and unknown user look the same, success sets an HttpOnly cookie, logout ends the session', async () => {
  const env = makeEnv();
  await addStaff(env);
  const c = new Client(env.app);
  const bad = await c.login('boss', 'nope');
  const unknown = await c.login('nobody', 'nope');
  assert.equal(bad.status, 401);
  assert.deepEqual(bad.json, unknown.json);
  const ok = await c.login('boss', 'organiser-test-pass');
  assert.equal(ok.status, 200);
  assert.equal(ok.json.user.role, 'organiser');
  const cookie = ok.headers.getSetCookie().join(';');
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/i);
  assert.equal((await c.get('/api/auth/me')).json.user.username, 'boss');
  await c.call('POST', '/api/auth/logout', {}, { key: null });
  assert.equal((await c.get('/api/auth/me')).json.user, null);
  assert.equal((await c.get('/api/admin/departures')).status, 401);
});

test('repeated failed sign-ins are throttled', async () => {
  const env = makeEnv();
  await addStaff(env);
  const c = new Client(env.app);
  let last = 0;
  for (let i = 0; i < 10; i += 1) last = (await c.login('throttle-me', 'wrong')).status;
  assert.equal(last, 429);
});

test('passwords are stored as salted scrypt hashes, never in clear', async () => {
  const env = makeEnv();
  await addStaff(env);
  const rows = all<{ password_hash: string }>(env.ctx.db, `SELECT password_hash FROM users`);
  assert.equal(rows.length, 2);
  for (const r of rows) assert.match(r.password_hash, /^scrypt\$/);
  assert.ok(!rows.some((r) => r.password_hash.includes('organiser-test-pass')));
});

test('customers cannot read, extend, release, check out, cancel or transfer anything that is not theirs', async () => {
  const env = makeEnv();
  const owner = new Client(env.app);
  const h = await owner.post('/api/holds', { departureId: DEP, seatIds: ['1'] });
  const holdId = h.json.hold.id;
  const thief = new Client(env.app);
  await thief.post('/api/holds', { departureId: DEP, seatIds: ['2'] }); // gives the thief a session
  assert.equal((await thief.get(`/api/holds/${holdId}`)).status, 404);
  assert.equal((await thief.post(`/api/holds/${holdId}/extend`)).status, 404);
  assert.equal((await thief.del(`/api/holds/${holdId}`)).status, 404);
  assert.equal(
    (await thief.post(`/api/holds/${holdId}/checkout`, { name: 'Mallory', phone: '0700 000 009' })).status,
    404,
  );

  const b = await buy(env, owner, ['3']);
  assert.equal((await thief.post(`/api/bookings/${b.bookingId}/cancel`)).status, 404);
  assert.equal(
    (await thief.post(`/api/tickets/${b.tickets[0]!.id}/transfer`, { newHolderName: 'Mallory' })).status,
    403,
  );
  assert.equal(
    one<{ status: string }>(env.ctx.db, `SELECT status FROM bookings WHERE id = ?`, b.bookingId)!.status,
    'confirmed',
  );
});

test('a ticket link with the wrong token is refused; the signing key never leaves the server', async () => {
  const env = makeEnv();
  const b = await buy(env, new Client(env.app), ['4']);
  const anon = new Client(env.app);
  assert.equal((await anon.get(`/api/tickets/${b.tickets[0]!.id}?k=wrong`)).status, 409);
  assert.equal((await anon.get(`/api/tickets/${b.tickets[0]!.id}`)).status, 409);
  assert.equal((await anon.get('/api/tickets/tkt_unknown?k=x')).status, 404);
  const pub = (await anon.get('/api/public-key')).json;
  assert.equal(pub.alg, 'Ed25519');
  assert.ok(!JSON.stringify(pub).includes('PRIVATE'));
});

test('security headers are set and API responses are not cached', async () => {
  const env = makeEnv();
  const r = await new Client(env.app).get('/api/events');
  assert.match(r.headers.get('content-security-policy')!, /default-src 'self'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal(r.headers.get('cache-control'), 'no-store');
});

test('request bodies over 64 KB are rejected', async () => {
  const env = makeEnv();
  const r = await new Client(env.app).post('/api/holds', {
    departureId: DEP,
    seatIds: ['1'],
    pad: 'x'.repeat(70_000),
  });
  assert.equal(r.status, 413);
});

test('validation errors are 400 with field detail; bad JSON is 400', async () => {
  const env = makeEnv();
  const c = new Client(env.app);
  const r = await c.post('/api/holds', { departureId: DEP, seatIds: 'nope' });
  assert.equal(r.status, 400);
  assert.equal(r.json.error.code, 'validation_error');
  assert.equal((await c.call('POST', '/api/holds', undefined, { raw: '{oops' })).status, 400);
});

// ---- idempotency ---------------------------------------------------------------------------

test('every mutating customer endpoint demands an Idempotency-Key', async () => {
  const env = makeEnv();
  const c = new Client(env.app);
  const h = await c.post('/api/holds', { departureId: DEP, seatIds: ['1'] });
  for (const [m, p, body] of [
    ['POST', '/api/holds', { departureId: DEP, seatIds: ['2'] }],
    ['POST', `/api/holds/${h.json.hold.id}/extend`, {}],
    ['POST', `/api/holds/${h.json.hold.id}/checkout`, { name: 'Test Buyer', phone: '0700 000 001' }],
    ['DELETE', `/api/holds/${h.json.hold.id}`, undefined],
    ['POST', '/api/bookings/bkg_x/cancel', {}],
    ['POST', '/api/tickets/tkt_x/transfer', { newHolderName: 'Joy' }],
  ] as const) {
    const r = await c.call(m, p, body, { key: null });
    assert.equal(r.status, 400, `${m} ${p}`);
    assert.equal(r.json.error.code, 'idempotency_key_required');
  }
  assert.equal(
    (await c.call('POST', '/api/holds', { departureId: DEP, seatIds: ['3'] }, { key: 'short' })).status,
    400,
  );
});

test('retrying a hold with the same key replays the first answer and creates nothing new', async () => {
  const env = makeEnv();
  const c = new Client(env.app);
  const first = await c.post('/api/holds', { departureId: DEP, seatIds: ['5'] }, { key: 'retry-key-0001' });
  const again = await c.post('/api/holds', { departureId: DEP, seatIds: ['5'] }, { key: 'retry-key-0001' });
  assert.equal(first.status, 201);
  assert.equal(again.status, 201);
  assert.equal(again.headers.get('idempotent-replay'), 'true');
  assert.deepEqual(again.json, first.json);
  assert.equal(all(env.ctx.db, `SELECT * FROM holds`).length, 1);
});

test('a replayed failure stays a failure; the same key with a different body is rejected', async () => {
  const env = makeEnv();
  await new Client(env.app).post('/api/holds', { departureId: DEP, seatIds: ['6'] });
  const c = new Client(env.app);
  const lost = await c.post('/api/holds', { departureId: DEP, seatIds: ['6'] }, { key: 'retry-key-0002' });
  assert.equal(lost.status, 409);
  const replay = await c.post('/api/holds', { departureId: DEP, seatIds: ['6'] }, { key: 'retry-key-0002' });
  assert.equal(replay.status, 409);
  const other = await c.post('/api/holds', { departureId: DEP, seatIds: ['7'] }, { key: 'retry-key-0002' });
  assert.equal(other.status, 422);
  assert.equal(other.json.error.code, 'idempotency_key_reuse');
});

test('a double-clicked checkout sends exactly one payment prompt', async () => {
  const env = makeEnv();
  const c = new Client(env.app);
  const h = await c.post('/api/holds', { departureId: DEP, seatIds: ['8'] });
  const body = { name: 'Test Buyer', phone: '0700 000 004' };
  const [a, b] = await Promise.all([
    c.post(`/api/holds/${h.json.hold.id}/checkout`, body, { key: 'double-click-1' }),
    c.post(`/api/holds/${h.json.hold.id}/checkout`, body, { key: 'double-click-1' }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [201, 409], 'one runs, the concurrent twin is turned away');
  const again = await c.post(`/api/holds/${h.json.hold.id}/checkout`, body, { key: 'double-click-1' });
  assert.equal(again.status, 201);
  assert.equal(env.mock.pending().length, 1);
  assert.equal(all(env.ctx.db, `SELECT * FROM payments`).length, 1);
});

test('idempotency keys are scoped to the caller: another customer reusing a key gets their own result', async () => {
  const env = makeEnv();
  const a = await new Client(env.app).post(
    '/api/holds',
    { departureId: DEP, seatIds: ['9'] },
    { key: 'shared-key-0001' },
  );
  const b = await new Client(env.app).post(
    '/api/holds',
    { departureId: DEP, seatIds: ['9'] },
    { key: 'shared-key-0001' },
  );
  assert.equal(a.status, 201);
  assert.equal(b.status, 409);
});
