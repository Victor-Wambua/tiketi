import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalisePhone } from '../src/server/bookings.ts';
import { all, one } from '../src/server/db.ts';
import { SIGNATURE_HEADER } from '../src/server/paymentCallbacks.ts';
import { buildCallbackBody, signCallback } from '../src/server/payments/mockMpesa.ts';
import { seatStates } from '../src/server/inventory.ts';
import { Client, DEP, MIN, deliverCallback, makeEnv, pay, startPurchase } from './helpers.ts';

const booking = (env: ReturnType<typeof makeEnv>, id: string) =>
  one<any>(env.ctx.db, `SELECT * FROM bookings WHERE id = ?`, id);
const payment = (env: ReturnType<typeof makeEnv>, bookingId: string) =>
  one<any>(env.ctx.db, `SELECT * FROM payments WHERE booking_id = ? ORDER BY rowid DESC`, bookingId);
const refunds = (env: ReturnType<typeof makeEnv>) =>
  all<any>(env.ctx.db, `SELECT * FROM refunds ORDER BY rowid`);
const tickets = (env: ReturnType<typeof makeEnv>) =>
  all<any>(env.ctx.db, `SELECT * FROM tickets ORDER BY rowid`);

test('phone numbers are normalised to 254 format and junk is rejected', () => {
  for (const ok of [
    '0700 000 001',
    '0700-000-001',
    '+254700000001',
    '254700000001',
    '700000001',
    '0112 345 678',
  ]) {
    assert.match(normalisePhone(ok)!, /^254[17]\d{8}$/, ok);
  }
  for (const bad of ['', '12345', '0800 000 001', '07000000011', 'abc', '+1 555 000 1111']) {
    assert.equal(normalisePhone(bad), null, bad);
  }
});

test('happy path: hold -> STK prompt -> verified callback -> confirmed booking and one ticket per seat', async () => {
  const env = makeEnv();
  const c = new Client(env.app);
  const p = await startPurchase(env, c, ['2', '3']);
  assert.equal(booking(env, p.bookingId).status, 'pending_payment');
  assert.equal(payment(env, p.bookingId).status, 'pending');
  assert.equal(env.mock.pending().length, 1);
  assert.equal(tickets(env).length, 0, 'nothing is issued before payment is confirmed');

  await pay(env, p.providerRef);
  assert.equal(booking(env, p.bookingId).status, 'confirmed');
  assert.equal(payment(env, p.bookingId).status, 'succeeded');
  assert.match(payment(env, p.bookingId).receipt, /^SYN[0-9A-F]{8}$/);
  assert.equal(payment(env, p.bookingId).paid_amount_kes, 1400);
  assert.equal(tickets(env).length, 2);
  assert.deepEqual(
    tickets(env)
      .map((t) => t.seat_id)
      .sort(),
    ['2', '3'],
  );
  const claims = all<any>(env.ctx.db, `SELECT * FROM seat_claims`);
  assert.ok(claims.every((x) => x.kind === 'booked' && x.expires_at === null));
  assert.equal(seatStates(env.ctx, DEP, null).states['2'], 'sold');
  // booked seats stay sold long after any hold would have expired
  env.clock.advance(60 * MIN);
  assert.equal(seatStates(env.ctx, DEP, null).states['2'], 'sold');
});

test('the customer can see the booking and the ticket links once paid', async () => {
  const env = makeEnv();
  const c = new Client(env.app);
  const p = await startPurchase(env, c, ['4']);
  await pay(env, p.providerRef);
  const r = await c.get(`/api/bookings/${p.bookingId}`);
  assert.equal(r.json.booking.status, 'confirmed');
  assert.equal(r.json.booking.tickets.length, 1);
  const t = await new Client(env.app).get(r.json.booking.tickets[0].link.replace('/t/', '/api/tickets/'));
  assert.equal(t.status, 200);
  assert.equal(t.json.ticket.seatLabel, '4');
  assert.ok(t.json.ticket.qrSvg.startsWith('<svg'));
  // a stranger without the session or the token cannot read the booking
  assert.equal((await new Client(env.app).get(`/api/bookings/${p.bookingId}`)).status, 404);
  assert.equal(
    (await new Client(env.app).get(`/api/bookings/${p.bookingId}?k=${r.json.booking.token}`)).status,
    200,
  );
});

test('a callback with a bad signature is rejected and changes nothing', async () => {
  const env = makeEnv();
  const p = await startPurchase(env, new Client(env.app), ['1']);
  const res = await deliverCallback(env, p.providerRef, 'success', {
    amountKes: 800,
    secret: 'not-the-secret',
  });
  assert.equal(res.status, 401);
  const noHeader = await env.app.request('/api/webhooks/mpesa', {
    method: 'POST',
    body: buildCallbackBody({ providerRef: p.providerRef, phone: '254700000001', amountKes: 800 }, 'success'),
  });
  assert.equal(noHeader.status, 401);
  // a valid signature over a different body does not authorise this body
  const good = buildCallbackBody(
    { providerRef: p.providerRef, phone: '254700000001', amountKes: 1 },
    'cancelled',
  );
  const forged = buildCallbackBody(
    { providerRef: p.providerRef, phone: '254700000001', amountKes: 800 },
    'success',
  );
  const swapped = await env.app.request('/api/webhooks/mpesa', {
    method: 'POST',
    body: forged,
    headers: { [SIGNATURE_HEADER]: signCallback(env.ctx.config.callbackSecret, good) },
  });
  assert.equal(swapped.status, 401);
  assert.equal(booking(env, p.bookingId).status, 'pending_payment');
  assert.equal(payment(env, p.bookingId).status, 'pending');
  assert.equal(tickets(env).length, 0);
});

test('malformed or unknown callbacks are refused', async () => {
  const env = makeEnv();
  const send = (body: string) =>
    env.app.request('/api/webhooks/mpesa', {
      method: 'POST',
      body,
      headers: { [SIGNATURE_HEADER]: signCallback(env.ctx.config.callbackSecret, body) },
    });
  assert.equal((await send('not json')).status, 400);
  assert.equal((await send('{"Body":{}}')).status, 400);
  assert.equal((await deliverCallback(env, 'ws_CO_unknown', 'success', { amountKes: 5 })).status, 404);
});

test('the same callback delivered twice is applied once', async () => {
  const env = makeEnv();
  const p = await startPurchase(env, new Client(env.app), ['1']);
  const first = await deliverCallback(env, p.providerRef, 'success', {
    amountKes: 800,
    receipt: 'SYNAAAA1111',
  });
  const second = await deliverCallback(env, p.providerRef, 'success', {
    amountKes: 800,
    receipt: 'SYNAAAA1111',
  });
  assert.equal((await first.json()).outcome, 'confirmed');
  assert.equal((await second.json()).outcome, 'duplicate');
  assert.equal(second.status, 200);
  assert.equal(tickets(env).length, 1);
  assert.equal(refunds(env).length, 0);
  assert.equal(all<any>(env.ctx.db, `SELECT * FROM payment_callbacks`).length, 1);
});

test('wrong amount: not confirmed, refund recorded for what was actually paid', async () => {
  const env = makeEnv();
  const p = await startPurchase(env, new Client(env.app), ['1']); // 800 KES
  const res = await deliverCallback(env, p.providerRef, 'success', { amountKes: 100 });
  assert.equal((await res.json()).outcome, 'amount_mismatch');
  assert.equal(booking(env, p.bookingId).status, 'pending_payment');
  assert.equal(tickets(env).length, 0);
  const [r] = refunds(env);
  assert.equal(r.amount_kes, 100);
  assert.equal(r.reason, 'wrong_amount');
  assert.equal(r.status, 'needed');
});

test('payment after the hold expired: no ticket, a refund-needed record, the seat is free for others', async () => {
  const env = makeEnv({ config: { paymentGraceMs: 1000 } });
  const c = new Client(env.app);
  const p = await startPurchase(env, c, ['5']);
  env.clock.advance(11 * MIN);
  const { expireDueHolds } = await import('../src/server/inventory.ts');
  expireDueHolds(env.ctx);
  assert.equal(booking(env, p.bookingId).status, 'expired');
  await pay(env, p.providerRef);
  assert.equal(tickets(env).length, 0);
  assert.equal(payment(env, p.bookingId).status, 'refund_needed');
  const [r] = refunds(env);
  assert.deepEqual([r.reason, r.amount_kes, r.status], ['late_payment', 700, 'needed']);
  assert.equal(seatStates(env.ctx, DEP, null).states['5'], 'available');
});

test('late payment cannot steal a seat that someone else has since taken', async () => {
  const env = makeEnv({ config: { paymentGraceMs: 1000 } });
  const p = await startPurchase(env, new Client(env.app), ['6']);
  env.clock.advance(11 * MIN);
  const other = new Client(env.app);
  assert.equal((await other.post('/api/holds', { departureId: DEP, seatIds: ['6'] })).status, 201);
  await pay(env, p.providerRef);
  assert.equal(tickets(env).length, 0);
  assert.equal(refunds(env).length, 1);
  assert.equal(seatStates(env.ctx, DEP, null).states['6'], 'held', 'the new holder keeps the seat');
});

test('the lazy path is enough: a late payment is refunded even if the sweeper never ran', async () => {
  const env = makeEnv({ config: { paymentGraceMs: 1000 } });
  const p = await startPurchase(env, new Client(env.app), ['7']);
  env.clock.advance(11 * MIN);
  await pay(env, p.providerRef);
  assert.equal(tickets(env).length, 0);
  assert.equal(refunds(env)[0]!.reason, 'late_payment');
});

test('cancelled, timed out and insufficient-funds outcomes keep the hold so the customer can retry, then pay', async () => {
  const env = makeEnv();
  const c = new Client(env.app);
  const p = await startPurchase(env, c, ['1']);
  await pay(env, p.providerRef, 'cancelled');
  assert.equal(payment(env, p.bookingId).status, 'cancelled');
  assert.equal(booking(env, p.bookingId).status, 'pending_payment');

  const retry = await c.post(`/api/holds/${p.holdId}/checkout`, {
    name: 'Test Buyer',
    phone: '0700 000 001',
  });
  assert.equal(retry.status, 201);
  assert.equal(env.mock.pending().length, 1);
  await pay(env, env.mock.pending()[0]!.providerRef, 'insufficient_funds');
  assert.equal(payment(env, p.bookingId).status, 'insufficient_funds');

  await c.post(`/api/holds/${p.holdId}/checkout`, { name: 'Test Buyer', phone: '0700 000 001' });
  await pay(env, env.mock.pending()[0]!.providerRef, 'timeout');
  assert.equal(payment(env, p.bookingId).status, 'timeout');

  await c.post(`/api/holds/${p.holdId}/checkout`, { name: 'Test Buyer', phone: '0700 000 001' });
  await pay(env, env.mock.pending()[0]!.providerRef, 'success');
  assert.equal(booking(env, p.bookingId).status, 'confirmed');
  assert.equal(tickets(env).length, 1);
});

test('a second prompt cannot be sent while one is already on the phone', async () => {
  const env = makeEnv();
  const c = new Client(env.app);
  const p = await startPurchase(env, c, ['1']);
  const again = await c.post(`/api/holds/${p.holdId}/checkout`, {
    name: 'Test Buyer',
    phone: '0700 000 001',
  });
  assert.equal(again.status, 409);
  assert.equal(again.json.error.code, 'payment_in_progress');
});

test('a prompt that times out on the phone reports back through the same signed callback', async () => {
  const env = makeEnv({ config: { mockStkTimeoutMs: 20 } as never });
  const c = new Client(env.app);
  const mod = await import('../src/server/payments/mockMpesa.ts');
  const quick = new mod.MockMpesaProvider({ secret: env.ctx.config.callbackSecret, timeoutMs: 20 });
  quick.setDeliver(async (body, sig) => {
    await env.app.request('/api/webhooks/mpesa', {
      method: 'POST',
      body,
      headers: { [SIGNATURE_HEADER]: sig },
    });
  });
  env.ctx.payments = quick;
  const p = await startPurchase(env, c, ['2']);
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(payment(env, p.bookingId).status, 'timeout');
  quick.close();
});

test('a failure callback never overrides a success that was already recorded', async () => {
  const env = makeEnv();
  const p = await startPurchase(env, new Client(env.app), ['1']);
  await deliverCallback(env, p.providerRef, 'success', { amountKes: 800, receipt: 'SYNBBBB2222' });
  const late = await deliverCallback(env, p.providerRef, 'cancelled');
  assert.equal((await late.json()).outcome, 'ignored');
  assert.equal(payment(env, p.bookingId).status, 'succeeded');
  assert.equal(booking(env, p.bookingId).status, 'confirmed');
});

test('a second, different successful payment for the same prompt is refunded as a duplicate', async () => {
  const env = makeEnv();
  const p = await startPurchase(env, new Client(env.app), ['1']);
  await deliverCallback(env, p.providerRef, 'success', { amountKes: 800, receipt: 'SYNCCCC3333' });
  const dup = await deliverCallback(env, p.providerRef, 'success', {
    amountKes: 800,
    receipt: 'SYNDDDD4444',
  });
  assert.equal((await dup.json()).outcome, 'refund_needed');
  assert.equal(tickets(env).length, 1);
  assert.deepEqual(
    refunds(env).map((r) => r.reason),
    ['duplicate_payment'],
  );
});

test('confirmation needs the hold owner: a booking whose session differs from the hold owner is refunded, not confirmed', async () => {
  const env = makeEnv();
  const p = await startPurchase(env, new Client(env.app), ['8']);
  env.ctx.db.prepare(`UPDATE bookings SET session_id = 'someone-else' WHERE id = ?`).run(p.bookingId);
  await pay(env, p.providerRef);
  assert.equal(tickets(env).length, 0);
  assert.equal(refunds(env)[0]!.reason, 'seat_unavailable');
});

test('refund-needed records are paid out through the provider exactly once', async () => {
  const env = makeEnv();
  const p = await startPurchase(env, new Client(env.app), ['1']);
  await deliverCallback(env, p.providerRef, 'success', { amountKes: 100 });
  const { processRefund } = await import('../src/server/bookings.ts');
  const id = refunds(env)[0]!.id;
  const [a, b] = await Promise.all([processRefund(env.ctx, id, 'boss'), processRefund(env.ctx, id, 'boss')]);
  assert.equal(a.refund_ref, b.refund_ref);
  const after = refunds(env)[0]!;
  assert.equal(after.status, 'processed');
  assert.equal(after.processed_by, 'boss');
});
