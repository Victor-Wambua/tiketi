import assert from 'node:assert/strict';
import { test } from 'node:test';
import { csvCell } from '../src/server/admin.ts';
import { processScan } from '../src/server/gate.ts';
import {
  Client,
  DEP,
  MIN,
  addStaff,
  buy,
  deliverCallback,
  makeEnv,
  staffClient,
  startPurchase,
} from './helpers.ts';

test('csvCell quotes properly and neutralises spreadsheet formulas', () => {
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('=HYPERLINK("http://x")'), `"'=HYPERLINK(""http://x"")"`);
  for (const f of ['+1', '-1', '@SUM(A1)', '\tx'])
    assert.ok(csvCell(f).startsWith("'") || csvCell(f).startsWith('"\''), f);
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(5), '5');
});

test('dashboard numbers: sales by tier, seat states, revenue, scans, occupancy and gate throughput', async () => {
  const env = makeEnv({ layoutId: 'coach-49' });
  await addStaff(env);
  const a = await buy(env, new Client(env.app), ['1A', '1B']); // premium 2 x 2200
  env.clock.advance(20 * MIN);
  const b = await buy(env, new Client(env.app), ['6C']); // standard 1600
  await new Client(env.app).post('/api/holds', { departureId: DEP, seatIds: ['9A'] }); // held, not sold
  processScan(env.ctx, { code: a.tickets[0]!.code, gate: 'Gate A', staffId: null });
  processScan(env.ctx, { code: b.tickets[0]!.code, gate: 'Gate B', staffId: null });

  const boss = await staffClient(env, 'boss');
  const d = (await boss.get(`/api/admin/departures/${DEP}/dashboard`)).json;
  assert.equal(d.totals.capacity, 49);
  assert.deepEqual([d.totals.sold, d.totals.scanned, d.totals.held, d.totals.available], [1, 2, 1, 45]);
  assert.equal(d.totals.revenueKes, 2200 * 2 + 1600);
  const premium = d.byTier.find((t: { tierId: string }) => t.tierId === 'premium');
  assert.deepEqual([premium.sold, premium.revenueKes], [2, 4400]);
  assert.equal(d.byTier.find((t: { tierId: string }) => t.tierId === 'std').sold, 1);
  assert.equal(d.seats.find((s: { seatId: string }) => s.seatId === '9A').state, 'held');
  assert.equal(d.seats.find((s: { seatId: string }) => s.seatId === '1A').state, 'scanned');
  assert.equal(d.seats.find((s: { seatId: string }) => s.seatId === '1B').state, 'sold');
  assert.deepEqual(
    d.occupancy.map((o: { sold: number }) => o.sold),
    [2, 3],
  );
  assert.deepEqual(d.throughput.map((t: { gate: string }) => t.gate).sort(), ['Gate A', 'Gate B']);
});

test('dashboard lists refund-needed records and offline conflicts', async () => {
  const env = makeEnv();
  await addStaff(env);
  const p = await startPurchase(env, new Client(env.app), ['1']);
  await deliverCallback(env, p.providerRef, 'success', { amountKes: 100 });
  const b = await buy(env, new Client(env.app), ['2']);
  const t0 = env.clock.now();
  env.clock.advance(MIN);
  processScan(env.ctx, {
    code: b.tickets[0]!.code,
    gate: 'Gate A',
    staffId: null,
    offline: true,
    clientScannedAt: t0 + 10_000,
    clientScanId: 'off-a-aaaa1',
  });
  processScan(env.ctx, {
    code: b.tickets[0]!.code,
    gate: 'Gate B',
    staffId: null,
    offline: true,
    clientScannedAt: t0 + 20_000,
    clientScanId: 'off-b-bbbb1',
  });
  const boss = await staffClient(env, 'boss');
  const d = (await boss.get(`/api/admin/departures/${DEP}/dashboard`)).json;
  assert.equal(d.refunds.length, 1);
  assert.equal(d.refunds[0].status, 'needed');
  assert.equal(d.conflicts.length, 1 + 1, 'both sides of the collision are listed');
  const done = await boss.post(`/api/admin/refunds/${d.refunds[0].id}/process`);
  assert.equal(done.json.refund.status, 'processed');
  assert.equal(done.json.refund.processed_by, 'boss');
});

test('CSV export has one row per ticket, with injection-safe names', async () => {
  const env = makeEnv();
  await addStaff(env);
  const c = new Client(env.app);
  const h = await c.post('/api/holds', { departureId: DEP, seatIds: ['1'] });
  const co = await c.post(`/api/holds/${h.json.hold.id}/checkout`, {
    name: '=cmd|calc',
    phone: '0700 000 005',
  });
  await env.mock.resolve(co.json.booking.payment.providerRef, 'success');
  const boss = await staffClient(env, 'boss');
  const r = await boss.get(`/api/admin/departures/${DEP}/export.csv`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type')!, /text\/csv/);
  const lines = (r.json as string).trim().split('\r\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /^ticket_id,seat,section,tier,price_kes,holder,buyer,buyer_phone,status/);
  assert.ok(lines[1]!.includes("'=cmd|calc"), lines[1]);
  assert.ok(!lines[1]!.includes(',=cmd'));
});

test('catalogue: events list shows departures with seats left, and holds reduce them', async () => {
  const env = makeEnv();
  const c = new Client(env.app);
  const before = (await c.get('/api/events')).json.events[0].departures[0];
  assert.equal(before.seatsLeft, 14);
  await c.post('/api/holds', { departureId: DEP, seatIds: ['1', '2'] });
  const after = (await c.get('/api/events')).json.events[0].departures[0];
  assert.equal(after.seatsLeft, 12);
  const dep = (await c.get(`/api/departures/${DEP}`)).json;
  assert.equal(dep.layout.sections[0].rows.flatMap((r: { seats: unknown[] }) => r.seats).length, 14);
});
