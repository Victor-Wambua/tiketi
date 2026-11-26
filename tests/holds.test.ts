import assert from 'node:assert/strict';
import { test } from 'node:test';
import { all, one } from '../src/server/db.ts';
import { AppError } from '../src/server/errors.ts';
import { createHold, expireDueHolds, extendHold, releaseHold, seatStates } from '../src/server/inventory.ts';
import { DEP, MIN, makeEnv, startPurchase, Client, pay } from './helpers.ts';

const hold = (env: ReturnType<typeof makeEnv>, session: string, seatIds: string[]) =>
  createHold(env.ctx, { departureId: DEP, sessionId: session, seatIds });

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    if (e instanceof AppError) return e.code;
    throw e;
  }
  return 'ok';
};

test('a hold lasts 10 minutes and shows as held to everyone else, mine to its owner', () => {
  const env = makeEnv();
  const h = hold(env, 's1', ['2', '3']);
  assert.equal(h.expiresAt - env.clock.now(), 10 * MIN);
  assert.equal(h.totalKes, 1400);
  const mine = seatStates(env.ctx, DEP, 's1').states;
  const theirs = seatStates(env.ctx, DEP, 's2').states;
  assert.equal(mine['2'], 'mine');
  assert.equal(theirs['2'], 'held');
  assert.equal(theirs['4'], 'available');
});

test('a second customer cannot take a held seat, and a failed multi-seat hold takes nothing', () => {
  const env = makeEnv();
  hold(env, 's1', ['5']);
  assert.equal(
    code(() => hold(env, 's2', ['4', '5', '6'])),
    'seat_unavailable',
  );
  const states = seatStates(env.ctx, DEP, 's3').states;
  assert.equal(states['4'], 'available', 'all-or-nothing: seat 4 must not stay held');
  assert.equal(states['6'], 'available');
  assert.equal(
    one<{ n: number }>(env.ctx.db, `SELECT COUNT(*) AS n FROM holds WHERE session_id = 's2'`)!.n,
    0,
  );
});

test('an expired hold frees the seat lazily, with no sweeper involved', () => {
  const env = makeEnv();
  hold(env, 's1', ['7']);
  env.clock.advance(10 * MIN - 1);
  assert.equal(
    code(() => hold(env, 's2', ['7'])),
    'seat_unavailable',
  );
  env.clock.advance(1);
  assert.equal(seatStates(env.ctx, DEP, 's2').states['7'], 'available', 'reads treat overdue holds as free');
  const taken = hold(env, 's2', ['7']);
  assert.equal(taken.seats[0]!.seatId, '7');
  const old = one<{ status: string }>(env.ctx.db, `SELECT status FROM holds WHERE session_id = 's1'`)!;
  assert.equal(old.status, 'expired');
});

test('the sweeper expires overdue holds and deletes their claims', () => {
  const env = makeEnv();
  hold(env, 's1', ['1', '2']);
  hold(env, 's2', ['3']);
  env.clock.advance(11 * MIN);
  assert.equal(expireDueHolds(env.ctx), 2);
  assert.equal(all(env.ctx.db, `SELECT * FROM seat_claims`).length, 0);
  assert.equal(expireDueHolds(env.ctx), 0, 'idempotent');
});

test('extension: once, +5 minutes, owner only, never after expiry', () => {
  const env = makeEnv();
  const h = hold(env, 's1', ['8']);
  assert.equal(h.canExtend, true);
  assert.equal(
    code(() => extendHold(env.ctx, { holdId: h.id, sessionId: 'someone-else' })),
    'not_found',
  );
  env.clock.advance(8 * MIN);
  const ext = extendHold(env.ctx, { holdId: h.id, sessionId: 's1' });
  assert.equal(ext.expiresAt - env.clock.now(), 2 * MIN + 5 * MIN);
  assert.equal(ext.canExtend, false);
  assert.equal(
    code(() => extendHold(env.ctx, { holdId: h.id, sessionId: 's1' })),
    'extension_limit',
  );
  // claims moved with the hold: the seat is still held at the old expiry time
  env.clock.advance(3 * MIN);
  assert.equal(seatStates(env.ctx, DEP, 's2').states['8'], 'held');
  env.clock.advance(5 * MIN);
  assert.equal(seatStates(env.ctx, DEP, 's2').states['8'], 'available');
  assert.equal(
    code(() => extendHold(env.ctx, { holdId: h.id, sessionId: 's1' })),
    'hold_expired',
  );
});

test('release frees the seats at once and is safe to repeat', () => {
  const env = makeEnv();
  const h = hold(env, 's1', ['9', '10']);
  releaseHold(env.ctx, { holdId: h.id, sessionId: 's1' });
  releaseHold(env.ctx, { holdId: h.id, sessionId: 's1' });
  assert.equal(seatStates(env.ctx, DEP, 's2').states['9'], 'available');
  assert.equal(
    code(() => releaseHold(env.ctx, { holdId: h.id, sessionId: 'thief' })),
    'not_found',
  );
  assert.equal(
    code(() => hold(env, 's2', ['9'])),
    'ok',
  );
});

test('choosing again replaces your previous hold instead of stacking holds', () => {
  const env = makeEnv();
  hold(env, 's1', ['1']);
  hold(env, 's1', ['2']);
  const s = seatStates(env.ctx, DEP, 's2').states;
  assert.equal(s['1'], 'available');
  assert.equal(s['2'], 'held');
});

test('limits: seat count, unknown seats, past departures', () => {
  const env = makeEnv();
  assert.equal(
    code(() => hold(env, 's1', ['1', '2', '3', '4', '5', '6', '7'])),
    'too_many_seats',
  );
  assert.equal(
    code(() => hold(env, 's1', [])),
    'no_seats',
  );
  assert.equal(
    code(() => hold(env, 's1', ['ZZ'])),
    'unknown_seat',
  );
  assert.equal(
    code(() => createHold(env.ctx, { departureId: 'nope', sessionId: 's1', seatIds: ['1'] })),
    'not_found',
  );
  env.clock.advance(49 * 60 * MIN);
  assert.equal(
    code(() => hold(env, 's1', ['1'])),
    'departure_closed',
  );
});

test('a hold that is being paid for cannot be swapped or released out from under the payment', async () => {
  const env = makeEnv();
  const c = new Client(env.app);
  const p = await startPurchase(env, c, ['1']);
  assert.equal(
    code(() =>
      hold(
        env,
        one<{ session_id: string }>(env.ctx.db, `SELECT session_id FROM holds WHERE id = ?`, p.holdId)!
          .session_id,
        ['2'],
      ),
    ),
    'hold_in_checkout',
  );
  await pay(env, p.providerRef);
  const del = await c.del(`/api/holds/${p.holdId}`);
  assert.equal(del.status, 409);
  assert.equal(del.json.error.code, 'already_booked');
});

test('claims can never be inserted twice for the same seat, whatever the application does (DB constraint)', () => {
  const env = makeEnv();
  const h = hold(env, 's1', ['1']);
  assert.throws(() =>
    env.ctx.db
      .prepare(
        `INSERT INTO seat_claims (departure_id, seat_id, kind, hold_id, expires_at) VALUES (?, '1', 'hold', ?, 1)`,
      )
      .run(DEP, h.id),
  );
  assert.throws(() =>
    env.ctx.db
      .prepare(
        `INSERT INTO seat_claims (departure_id, seat_id, kind, hold_id, expires_at) VALUES (?, '2', 'booked', ?, 5)`,
      )
      .run(DEP, h.id),
  );
});
