import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LayoutSchema, flattenSeats } from '../src/shared/layout.ts';
import { loadShippedLayouts } from '../src/server/layouts.ts';

const layouts = new Map(loadShippedLayouts().map((l) => [l.id, l]));

test('ships a 14-seater, a 49-seater (2+2) and a ~150-seat hall', () => {
  assert.equal(flattenSeats(layouts.get('matatu-14')!).length, 14);
  assert.equal(flattenSeats(layouts.get('coach-49')!).length, 49);
  assert.equal(flattenSeats(layouts.get('hall-150')!).length, 150);
});

test('the coach is 2+2: four seats a row (five at the back), with a gap for the aisle', () => {
  const rows = layouts.get('coach-49')!.sections[0]!.rows;
  assert.equal(rows.length, 12);
  for (const row of rows.slice(0, 11)) {
    assert.equal(row.seats.length, 4);
    const [a, b, c, d] = row.seats;
    assert.ok(c!.x - b!.x > b!.x - a!.x + 10, 'aisle between B and C');
    assert.ok(d!.x > c!.x);
  }
});

test('tiers, prices and accessible seats are defined', () => {
  for (const l of layouts.values()) {
    assert.ok(l.tiers.length >= 2);
    for (const t of l.tiers) assert.ok(Number.isInteger(t.priceKes) && t.priceKes > 0);
  }
  assert.ok(flattenSeats(layouts.get('hall-150')!).some((s) => s.accessible));
  assert.ok(flattenSeats(layouts.get('coach-49')!).some((s) => s.accessible));
});

test('no two seats overlap and every seat is inside the drawing', () => {
  for (const l of layouts.values()) {
    const seats = flattenSeats(l);
    for (const s of seats) {
      assert.ok(
        s.x >= 0 && s.y >= 0 && s.x + l.seatSize <= l.width && s.y + l.seatSize <= l.height,
        `${l.id} ${s.id} outside`,
      );
    }
    for (let i = 0; i < seats.length; i += 1) {
      for (let j = i + 1; j < seats.length; j += 1) {
        const a = seats[i]!;
        const b = seats[j]!;
        const overlap = Math.abs(a.x - b.x) < l.seatSize && Math.abs(a.y - b.y) < l.seatSize;
        assert.ok(!overlap, `${l.id}: ${a.id} overlaps ${b.id}`);
      }
    }
  }
});

test('the schema rejects duplicate seat ids and unknown tiers', () => {
  const base = structuredClone(layouts.get('matatu-14')!);
  const dup = structuredClone(base);
  dup.sections[0]!.rows[1]!.seats[0]!.id = dup.sections[0]!.rows[0]!.seats[0]!.id;
  assert.equal(LayoutSchema.safeParse(dup).success, false);
  const badTier = structuredClone(base);
  badTier.sections[0]!.rows[0]!.seats[0]!.tier = 'vip';
  assert.equal(LayoutSchema.safeParse(badTier).success, false);
});
