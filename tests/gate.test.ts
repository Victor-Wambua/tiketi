import assert from 'node:assert/strict';
import { test } from 'node:test';
import { all, one } from '../src/server/db.ts';
import { processScan } from '../src/server/gate.ts';
import { Client, DEP, MIN, addStaff, buy, makeEnv, startServer, staffClient } from './helpers.ts';

const scan = (
  env: ReturnType<typeof makeEnv>,
  code: string,
  gate = 'Gate A',
  extra: Record<string, unknown> = {},
) => processScan(env.ctx, { code, gate, staffId: null, ...extra });

test('a valid ticket is admitted once; the second scan says when and where it was first used', async () => {
  const env = makeEnv();
  const b = await buy(env, new Client(env.app), ['1']);
  const code = b.tickets[0]!.code;
  const first = scan(env, code, 'Gate B');
  assert.equal(first.result, 'admitted');
  assert.match(first.message, /seat 1/);
  env.clock.advance(5 * MIN);
  const second = scan(env, code, 'Gate A');
  assert.equal(second.result, 'duplicate');
  assert.match(second.message, /Already scanned at \d\d:\d\d at Gate B\./);
  assert.equal(second.firstScan?.gate, 'Gate B');
  assert.equal(all(env.ctx.db, `SELECT * FROM scans WHERE result = 'admitted'`).length, 1);
});

test('forged, altered, foreign and garbage codes are all rejected and logged', async () => {
  const env = makeEnv();
  const b = await buy(env, new Client(env.app), ['2']);
  const code = b.tickets[0]!.code;
  const parts = code.split('.');
  const tampered = [...parts.slice(0, 3), '3', ...parts.slice(4)].join('.'); // another seat, same signature
  assert.equal(scan(env, tampered).result, 'invalid');
  assert.equal(scan(env, 'TK1.nonsense').result, 'invalid');
  assert.equal(scan(env, 'https://example.com/ticket').result, 'invalid');
  assert.match(scan(env, tampered).message, /Fake or altered/);
  const other = makeEnv();
  const foreign = (await buy(other, new Client(other.app), ['2'])).tickets[0]!.code;
  assert.equal(scan(env, foreign).result, 'invalid');
  assert.equal(
    one<{ n: number }>(env.ctx.db, `SELECT COUNT(*) AS n FROM tickets WHERE admitted_at IS NOT NULL`)!.n,
    0,
  );
});

test('a ticket for another departure is refused at this gate', async () => {
  const env = makeEnv();
  const b = await buy(env, new Client(env.app), ['3']);
  const r = scan(env, b.tickets[0]!.code, 'Gate A', { departureId: 'dep-other' });
  assert.equal(r.result, 'wrong_departure');
  assert.equal(scan(env, b.tickets[0]!.code, 'Gate A', { departureId: DEP }).result, 'admitted');
});

test('transfer re-issues with a new version: the old QR dies, the new one works', async () => {
  const env = makeEnv();
  const c = new Client(env.app);
  const b = await buy(env, c, ['4']);
  const oldCode = b.tickets[0]!.code;
  const t = await c.post(`/api/tickets/${b.tickets[0]!.id}/transfer`, { newHolderName: 'Joy Wambui' });
  assert.equal(t.status, 200);
  assert.equal(t.json.ticket.version, 2);
  assert.equal(t.json.ticket.holderName, 'Joy Wambui');
  assert.notEqual(t.json.ticket.code, oldCode);
  assert.equal(scan(env, oldCode).result, 'stale_version');
  assert.equal(scan(env, t.json.ticket.code).result, 'admitted');
  // the old link no longer shows the (new) QR
  const old = await new Client(env.app).get(b.tickets[0]!.link.replace('/t/', '/api/tickets/'));
  assert.equal(old.status, 409);
  assert.equal(old.json.error.code, 'ticket_link_expired');
});

test('only the buyer can transfer, and not after use', async () => {
  const env = makeEnv();
  const c = new Client(env.app);
  const b = await buy(env, c, ['5']);
  const stranger = await new Client(env.app).post(`/api/tickets/${b.tickets[0]!.id}/transfer`, {
    newHolderName: 'Mallory',
  });
  assert.equal(stranger.status, 403);
  scan(env, b.tickets[0]!.code);
  const used = await c.post(`/api/tickets/${b.tickets[0]!.id}/transfer`, { newHolderName: 'Joy Wambui' });
  assert.equal(used.status, 409);
  assert.equal(used.json.error.code, 'ticket_used');
});

test('cancelling a paid booking voids the QR, frees the seats and records a processed refund', async () => {
  const env = makeEnv();
  const c = new Client(env.app);
  const b = await buy(env, c, ['6', '7']);
  const res = await c.post(`/api/bookings/${b.bookingId}/cancel`);
  assert.equal(res.status, 200);
  assert.equal(res.json.booking.status, 'cancelled');
  assert.deepEqual(
    [res.json.booking.refund.status, res.json.booking.refund.amountKes, res.json.booking.refund.reason],
    ['processed', 1400, 'customer_cancelled'],
  );
  assert.equal(scan(env, b.tickets[0]!.code).result, 'stale_version');
  const states = (await new Client(env.app).get(`/api/departures/${DEP}/seats`)).json.states;
  assert.equal(states['6'], 'available');
  assert.equal(
    (await new Client(env.app).post('/api/holds', { departureId: DEP, seatIds: ['6'] })).status,
    201,
    'seat can be sold again',
  );
  assert.equal(
    (await c.post(`/api/bookings/${b.bookingId}/cancel`)).status,
    200,
    'cancelling twice is harmless',
  );
  assert.equal(all(env.ctx.db, `SELECT * FROM refunds`).length, 1);
});

test('a booking cannot be cancelled once a ticket on it has been used, or after departure', async () => {
  const env = makeEnv();
  const c = new Client(env.app);
  const b = await buy(env, c, ['8']);
  scan(env, b.tickets[0]!.code);
  assert.equal((await c.post(`/api/bookings/${b.bookingId}/cancel`)).json.error.code, 'ticket_used');
  const c2 = new Client(env.app);
  const b2 = await buy(env, c2, ['9']);
  env.clock.advance(49 * 60 * MIN);
  assert.equal((await c2.post(`/api/bookings/${b2.bookingId}/cancel`)).json.error.code, 'departure_started');
});

test('cancelling before paying releases the hold', async () => {
  const env = makeEnv();
  const c = new Client(env.app);
  const h = await c.post('/api/holds', { departureId: DEP, seatIds: ['10'] });
  const co = await c.post(`/api/holds/${h.json.hold.id}/checkout`, {
    name: 'Test Buyer',
    phone: '0700 000 002',
  });
  const res = await c.post(`/api/bookings/${co.json.booking.id}/cancel`);
  assert.equal(res.json.booking.status, 'cancelled');
  assert.equal(
    (await new Client(env.app).get(`/api/departures/${DEP}/seats`)).json.states['10'],
    'available',
  );
});

test('two gates scanning the same ticket at the same instant over real HTTP: exactly one admission', async () => {
  const env = makeEnv();
  await addStaff(env);
  const server = await startServer(env.app);
  try {
    const b = await buy(env, new Client(env.app), ['11']);
    const gates = await Promise.all(
      ['Gate A', 'Gate B', 'Gate C', 'Gate D'].map(async (g) => {
        const c = server.client();
        await c.login('gatey', 'gate-test-pass');
        return { g, c };
      }),
    );
    const results = await Promise.all(
      gates.flatMap(({ g, c }) =>
        Array.from({ length: 5 }, () => c.post('/api/gate/scans', { code: b.tickets[0]!.code, gate: g })),
      ),
    );
    const verdicts = results.map((r) => r.json.scan.result);
    assert.equal(verdicts.filter((v) => v === 'admitted').length, 1, JSON.stringify(verdicts));
    assert.equal(verdicts.filter((v) => v === 'duplicate').length, 19);
    const winner = results.find((r) => r.json.scan.result === 'admitted')!.json.scan;
    const dup = results.find((r) => r.json.scan.result === 'duplicate')!.json.scan;
    assert.equal(
      dup.firstScan.gate,
      winner.firstScan?.gate ??
        one<{ admitted_gate: string }>(env.ctx.db, `SELECT admitted_gate FROM tickets`)!.admitted_gate,
    );
    assert.equal(
      one<{ n: number }>(env.ctx.db, `SELECT COUNT(*) AS n FROM scans`)!.n,
      20,
      'every attempt is logged',
    );
  } finally {
    await server.close();
  }
});

test('scan retries with the same client scan id are idempotent', async () => {
  const env = makeEnv();
  const b = await buy(env, new Client(env.app), ['12']);
  const a = scan(env, b.tickets[0]!.code, 'Gate A', { clientScanId: 'scan-aaaa-1111' });
  const again = scan(env, b.tickets[0]!.code, 'Gate A', { clientScanId: 'scan-aaaa-1111' });
  assert.equal(a.result, 'admitted');
  assert.equal(again.result, 'admitted', 'the retry gets the original answer, not "duplicate"');
  assert.equal(again.scanId, a.scanId);
  assert.equal(all(env.ctx.db, `SELECT * FROM scans`).length, 1);
});

test('offline reconciliation: the earlier claimed entry wins, the collision is flagged for review', async () => {
  const env = makeEnv();
  const b = await buy(env, new Client(env.app), ['13']);
  const code = b.tickets[0]!.code;
  const t0 = env.clock.now();
  env.clock.advance(30 * MIN);
  // Gate B synced first but claims a later entry time than Gate A, whose batch arrives second.
  const late = scan(env, code, 'Gate B', {
    offline: true,
    clientScannedAt: t0 + 20 * MIN,
    clientScanId: 'off-b-0001',
  });
  assert.equal(late.result, 'admitted');
  const early = scan(env, code, 'Gate A', {
    offline: true,
    clientScannedAt: t0 + 10 * MIN,
    clientScanId: 'off-a-0001',
  });
  assert.equal(early.result, 'admitted', 'Gate A was physically first');
  assert.equal(early.conflict, true);
  const t = one<{ admitted_gate: string; admitted_at: number }>(
    env.ctx.db,
    `SELECT admitted_gate, admitted_at FROM tickets`,
  )!;
  assert.equal(t.admitted_gate, 'Gate A');
  assert.equal(t.admitted_at, t0 + 10 * MIN);
  const flagged = all<{ gate: string; result: string }>(
    env.ctx.db,
    `SELECT gate, result FROM scans WHERE conflict = 1 ORDER BY gate`,
  );
  assert.deepEqual(
    flagged.map((s) => [s.gate, s.result]),
    [
      ['Gate A', 'admitted'],
      ['Gate B', 'duplicate'],
    ],
  );
});

test('an offline duplicate that arrives later is a flagged duplicate, never a second admission', async () => {
  const env = makeEnv();
  const b = await buy(env, new Client(env.app), ['14']);
  const code = b.tickets[0]!.code;
  const t0 = env.clock.now();
  env.clock.advance(30 * MIN);
  scan(env, code, 'Gate A', { clientScannedAt: t0 + 5 * MIN, clientScanId: 'on-a-00001' });
  const dup = scan(env, code, 'Gate B', {
    offline: true,
    clientScannedAt: t0 + 9 * MIN,
    clientScanId: 'off-b-0002',
  });
  assert.equal(dup.result, 'duplicate');
  assert.equal(dup.conflict, true);
  assert.equal(all(env.ctx.db, `SELECT * FROM scans WHERE result = 'admitted'`).length, 1);
});

test('claimed offline times are clamped: no future times, none before the ticket existed', async () => {
  const env = makeEnv();
  const b = await buy(env, new Client(env.app), ['1']);
  scan(env, b.tickets[0]!.code, 'Gate A', {
    offline: true,
    clientScannedAt: env.clock.now() + 99 * MIN,
    clientScanId: 'off-fut-01',
  });
  const t = one<{ admitted_at: number }>(env.ctx.db, `SELECT admitted_at FROM tickets`)!;
  assert.ok(t.admitted_at <= env.clock.now());
});

test('gate manifest lists every ticket with its current version and status', async () => {
  const env = makeEnv();
  await addStaff(env);
  const c = new Client(env.app);
  const b = await buy(env, c, ['1', '2']);
  await c.post(`/api/tickets/${b.tickets[1]!.id}/transfer`, { newHolderName: 'Joy Wambui' });
  const gate = await staffClient(env, 'gatey');
  const m = (await gate.get(`/api/gate/manifest/${DEP}`)).json;
  assert.equal(m.tickets.length, 2);
  assert.deepEqual(
    m.tickets.map((t: { version: number }) => t.version),
    [1, 2],
  );
});
