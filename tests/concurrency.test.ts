import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';
import { createDeparture, createEvent, saveLayout } from '../src/server/catalog.ts';
import { FakeClock } from '../src/server/clock.ts';
import { all, openDb, one, type DB } from '../src/server/db.ts';
import { loadShippedLayouts } from '../src/server/layouts.ts';
import { Client, DEP, HOUR, makeEnv, pay, startServer } from './helpers.ts';

/** The global invariant: every seat has at most one active claim, and claims agree with holds/bookings. */
function assertInvariant(db: DB, now: number) {
  const dupes = all<{ departure_id: string; seat_id: string; n: number }>(
    db,
    `SELECT departure_id, seat_id, COUNT(*) AS n FROM seat_claims GROUP BY departure_id, seat_id HAVING n > 1`,
  );
  assert.deepEqual(dupes, [], 'a seat has more than one claim');
  // no seat appears in two live holds
  const live = all<{ seat_id: string; n: number }>(
    db,
    `SELECT hs.seat_id, COUNT(DISTINCT h.id) AS n FROM hold_seats hs JOIN holds h ON h.id = hs.hold_id
      WHERE h.status = 'active' AND h.expires_at > ? GROUP BY h.departure_id, hs.seat_id HAVING n > 1`,
    now,
  );
  assert.deepEqual(live, [], 'a seat is in two live holds');
  // no seat has two valid tickets
  const tix = all(
    db,
    `SELECT departure_id, seat_id FROM tickets WHERE status = 'valid' GROUP BY departure_id, seat_id HAVING COUNT(*) > 1`,
  );
  assert.deepEqual(tix, [], 'a seat has two valid tickets');
  // every claim belongs to a live hold or a confirmed booking
  const orphans = all(
    db,
    `SELECT sc.* FROM seat_claims sc JOIN holds h ON h.id = sc.hold_id
      WHERE (sc.kind = 'hold' AND (h.status != 'active' OR h.expires_at != sc.expires_at))
         OR (sc.kind = 'booked' AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.hold_id = h.id AND b.status = 'confirmed'))`,
  );
  assert.deepEqual(orphans, [], 'orphaned claims');
  // every valid ticket's seat is booked
  const unbooked = all(
    db,
    `SELECT t.id FROM tickets t LEFT JOIN seat_claims sc ON sc.departure_id = t.departure_id AND sc.seat_id = t.seat_id AND sc.kind = 'booked'
      WHERE t.status = 'valid' AND sc.seat_id IS NULL`,
  );
  assert.deepEqual(unbooked, [], 'valid ticket without a booked seat');
}

test('200 simultaneous in-process requests for one seat: exactly one winner', async () => {
  const env = makeEnv();
  const results = await Promise.all(
    Array.from({ length: 200 }, () =>
      new Client(env.app).post('/api/holds', { departureId: DEP, seatIds: ['5'] }),
    ),
  );
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  assert.equal(results.filter((r) => r.status === 409).length, 199);
  assertInvariant(env.ctx.db, env.clock.now());
});

test('200 concurrent hold attempts on one seat over real HTTP: exactly one winner', async () => {
  const env = makeEnv();
  const server = await startServer(env.app);
  try {
    const clients = Array.from({ length: 200 }, () => server.client());
    const results = await Promise.all(
      clients.map((c) => c.post('/api/holds', { departureId: DEP, seatIds: ['5'] })),
    );
    const winners = results.filter((r) => r.status === 201);
    const losers = results.filter((r) => r.status === 409);
    assert.equal(winners.length, 1, `winners: ${winners.length}`);
    assert.equal(losers.length, 199);
    assert.ok(
      losers.every(
        (r) => r.json.error.code === 'seat_unavailable' && r.json.error.details.seatIds[0] === '5',
      ),
    );
    assert.equal(all(env.ctx.db, `SELECT * FROM seat_claims`).length, 1);
    assertInvariant(env.ctx.db, env.clock.now());
  } finally {
    await server.close();
  }
});

test('the same 200-way race on a held-then-expired seat still has exactly one winner', async () => {
  const env = makeEnv();
  const first = new Client(env.app);
  await first.post('/api/holds', { departureId: DEP, seatIds: ['5'] });
  env.clock.advance(11 * 60_000);
  const server = await startServer(env.app);
  try {
    const results = await Promise.all(
      Array.from({ length: 200 }, () =>
        server.client().post('/api/holds', { departureId: DEP, seatIds: ['5'] }),
      ),
    );
    assert.equal(results.filter((r) => r.status === 201).length, 1);
    assertInvariant(env.ctx.db, env.clock.now());
  } finally {
    await server.close();
  }
});

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('randomised multi-seat stress over real HTTP keeps the invariant (holds, releases, payments, cancels)', async () => {
  for (const seed of [1, 2, 3]) {
    const env = makeEnv({ layoutId: 'coach-49' });
    const server = await startServer(env.app);
    try {
      const rand = rng(seed);
      const seats = all<{ seat_id: string }>(
        env.ctx.db,
        `SELECT seat_id FROM departure_seats WHERE departure_id = ?`,
        DEP,
      ).map((s) => s.seat_id);
      const clients = Array.from({ length: 120 }, () => server.client());
      const plan = clients.map((c) => {
        const n = 1 + Math.floor(rand() * 3);
        const pick = new Set<string>();
        while (pick.size < n) pick.add(seats[Math.floor(rand() * 20)]!); // 20 hot seats => heavy contention
        return { c, seatIds: [...pick] };
      });
      const results = await Promise.all(
        plan.map(({ c, seatIds }) => c.post('/api/holds', { departureId: DEP, seatIds })),
      );

      // the winning seat sets are pairwise disjoint
      const taken = new Map<string, number>();
      results.forEach((r) => {
        if (r.status !== 201) {
          assert.equal(r.status, 409);
          return;
        }
        for (const s of r.json.hold.seats) taken.set(s.seatId, (taken.get(s.seatId) ?? 0) + 1);
      });
      assert.ok(
        [...taken.values()].every((n) => n === 1),
        'a seat was granted to two holds',
      );
      assert.ok(taken.size >= 10);
      assertInvariant(env.ctx.db, env.clock.now());

      // winners then pay, release or cancel concurrently
      const winners = plan
        .filter((_, i) => results[i]!.status === 201)
        .map((p, i) => ({ ...p, hold: results.filter((r) => r.status === 201)[i]!.json.hold }));
      const paid: { c: Client; bookingId: string }[] = [];
      await Promise.all(
        winners.map(async ({ c, hold }, i) => {
          if (i % 3 === 0) return c.del(`/api/holds/${hold.id}`);
          const co = await c.post(`/api/holds/${hold.id}/checkout`, {
            name: 'Stress Buyer',
            phone: '0700 000 003',
          });
          if (i % 3 === 1) {
            await pay(env, co.json.booking.payment.providerRef);
            paid.push({ c, bookingId: co.json.booking.id });
          }
          return undefined;
        }),
      );
      assert.ok(paid.length > 0);
      assertInvariant(env.ctx.db, env.clock.now());
      // released seats are takeable again; paid ones are not
      const after = await Promise.all(
        plan.map(({ c, seatIds }) => c.post('/api/holds', { departureId: DEP, seatIds })),
      );
      assertInvariant(env.ctx.db, env.clock.now());
      const sold = new Set(
        all<{ seat_id: string }>(env.ctx.db, `SELECT seat_id FROM seat_claims WHERE kind = 'booked'`).map(
          (s) => s.seat_id,
        ),
      );
      for (const r of after)
        if (r.status === 201)
          for (const s of r.json.hold.seats) assert.ok(!sold.has(s.seatId), 'sold seat was held again');

      // cancel every confirmed booking concurrently: all seats come back, invariant holds
      const cancels = await Promise.all(
        paid.map(({ c, bookingId }) => c.post(`/api/bookings/${bookingId}/cancel`)),
      );
      assert.ok(cancels.every((r) => r.status === 200));
      assert.equal(
        one<{ n: number }>(env.ctx.db, `SELECT COUNT(*) AS n FROM seat_claims WHERE kind = 'booked'`)!.n,
        0,
      );
      assert.equal(
        one<{ n: number }>(env.ctx.db, `SELECT COUNT(*) AS n FROM tickets WHERE status = 'valid'`)!.n,
        0,
      );
      assertInvariant(env.ctx.db, env.clock.now());
    } finally {
      await server.close();
    }
  }
});

test('expiry races: holds expiring while new holds arrive never produce a double claim', async () => {
  const env = makeEnv({ layoutId: 'matatu-14' });
  const server = await startServer(env.app);
  try {
    const rand = rng(42);
    const { expireDueHolds } = await import('../src/server/inventory.ts');
    for (let round = 0; round < 6; round += 1) {
      const batch = Array.from({ length: 40 }, () => server.client());
      const reqs = batch.map((c) =>
        c.post('/api/holds', { departureId: DEP, seatIds: [String(1 + Math.floor(rand() * 14))] }),
      );
      env.clock.advance(Math.floor(rand() * 6 * 60_000));
      if (round % 2) expireDueHolds(env.ctx);
      await Promise.all(reqs);
      assertInvariant(env.ctx.db, env.clock.now());
    }
  } finally {
    await server.close();
  }
});

test('four separate SQLite connections (worker threads) racing for one seat: exactly one winner', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tiketi-race-'));
  const path = join(dir, 'race.db');
  try {
    const db = openDb(path);
    const clock = new FakeClock(Date.now());
    const env = makeEnv();
    for (const l of loadShippedLayouts()) saveLayout({ ...env.ctx, db, clock }, l);
    createEvent(
      { ...env.ctx, db, clock },
      { id: 'evt-race', title: 'Race', kind: 'trip', description: '', venue: 'x', layoutId: 'matatu-14' },
    );
    createDeparture(
      { ...env.ctx, db, clock },
      { id: 'dep-race', eventId: 'evt-race', startsAt: Date.now() + 48 * HOUR },
    );
    db.close();

    const run = (id: number) =>
      new Promise<{ won: number; lost: number }>((resolve, reject) => {
        const w = new Worker(new URL('./workers/holdWorker.ts', import.meta.url), {
          execArgv: ['--import', 'tsx'],
          workerData: { path, departureId: 'dep-race', attempts: 100, seatIds: ['3'], id },
        });
        w.once('message', resolve);
        w.once('error', reject);
      });
    const results = await Promise.all([1, 2, 3, 4].map(run));
    assert.equal(
      results.reduce((n, r) => n + r.won, 0),
      1,
    );
    assert.equal(
      results.reduce((n, r) => n + r.lost, 0),
      399,
    );
    const check = openDb(path);
    assert.equal(one<{ n: number }>(check, `SELECT COUNT(*) AS n FROM seat_claims`)!.n, 1);
    check.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
