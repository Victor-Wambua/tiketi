/** Generates the three shipped seat-map layouts into layouts/*.json (run: npm run layouts). */
import { mkdirSync, writeFileSync } from 'node:fs';
import { LayoutSchema, flattenSeats, type Layout, type LayoutSeat } from '../src/shared/layout.ts';

const P = 44; // seat pitch
const S = 36; // seat size

type SeatRows = LayoutSeat[][];
const seat = (
  id: string,
  label: string,
  x: number,
  y: number,
  tier: string,
  accessible = false,
): LayoutSeat => (accessible ? { id, label, x, y, tier, accessible } : { id, label, x, y, tier });

/** 14-seater matatu: driver + front passenger, three rows of 2+1, back bench of 4. */
function matatu14(): Layout {
  const rows: SeatRows = [];
  const left = 24;
  rows.push([seat('1', '1', left + 2 * P + 20, 96, 'front')]);
  const labels = ['A', 'B', 'C'];
  let n = 2;
  labels.forEach((_l, i) => {
    const y = 96 + (i + 1) * P + 24;
    rows.push([
      seat(String(n), String(n), left, y, 'std'),
      seat(String(n + 1), String(n + 1), left + P, y, 'std'),
      seat(String(n + 2), String(n + 2), left + 2 * P + 20, y, 'std'),
    ]);
    n += 3;
  });
  const yBack = 96 + 4 * P + 48;
  rows.push(
    [0, 1, 2, 3].map((c) => seat(String(n + c), String(n + c), left + c * P + (c > 1 ? 4 : 0), yBack, 'std')),
  );
  return {
    id: 'matatu-14',
    name: '14-seater matatu',
    kind: 'vehicle',
    width: 24 * 2 + 3 * P + 20 + 4,
    height: yBack + P + 24,
    seatSize: S,
    tiers: [
      { id: 'front', name: 'Front seat', priceKes: 800 },
      { id: 'std', name: 'Standard', priceKes: 700 },
    ],
    sections: [
      {
        id: 'cabin',
        name: 'Cabin',
        rows: rows.map((seats, i) => ({ id: `r${i + 1}`, label: String(i + 1), seats })),
      },
    ],
    decor: [
      { kind: 'driver', x: left, y: 96, w: S + 4, h: S, label: 'Driver' },
      { kind: 'door', x: left + 3 * P + 20, y: 96 + P + 24, w: 6, h: 2 * P, label: 'Door' },
    ],
  };
}

/** 49-seater coach, 2+2: 11 rows of four, a back row of five. Rows 1-3 premium. */
function coach49(): Layout {
  const left = 28;
  const aisle = 34;
  const top = 100;
  const rows: Layout['sections'][number]['rows'] = [];
  const colX = (c: number) => left + c * P + (c >= 2 ? aisle : 0);
  const letters = ['A', 'B', 'C', 'D', 'E'];
  for (let r = 1; r <= 11; r += 1) {
    const y = top + (r - 1) * P;
    const tier = r <= 3 ? 'premium' : 'std';
    rows.push({
      id: `r${r}`,
      label: String(r),
      seats: [0, 1, 2, 3].map((c) =>
        seat(`${r}${letters[c]}`, `${r}${letters[c]}`, colX(c), y, tier, r === 1 && c <= 1),
      ),
    });
  }
  const yBack = top + 11 * P + 4;
  const backX = (c: number) => left + c * (P - 1.5) + 0;
  rows.push({
    id: 'r12',
    label: '12',
    seats: [0, 1, 2, 3, 4].map((c) => seat(`12${letters[c]}`, `12${letters[c]}`, backX(c) + 3, yBack, 'std')),
  });
  return {
    id: 'coach-49',
    name: '49-seater coach (2+2)',
    kind: 'vehicle',
    width: left * 2 + 4 * P + aisle,
    height: yBack + P + 20,
    seatSize: S,
    tiers: [
      { id: 'premium', name: 'Premium (rows 1-3)', priceKes: 2200 },
      { id: 'std', name: 'Standard', priceKes: 1600 },
    ],
    sections: [{ id: 'cabin', name: 'Cabin', rows }],
    decor: [
      { kind: 'driver', x: left, y: 36, w: S + 6, h: S, label: 'Driver' },
      { kind: 'door', x: left + 4 * P + aisle - 8, y: 40, w: 36, h: 6, label: 'Door' },
    ],
  };
}

/** Small theatre: 10 rows of 12 in the stalls (6 | 6), 3 rows of 10 in the balcony = 150 seats. */
function hall150(): Layout {
  const left = 30;
  const aisle = 40;
  const stageH = 56;
  const colX = (c: number, perSide: number) => left + c * P + (c >= perSide ? aisle : 0);
  const stallRows = 'ABCDEFGHIJ'.split('');
  const stalls: Layout['sections'][number]['rows'] = stallRows.map((letter, ri) => {
    const y = 20 + stageH + 24 + ri * P;
    const tier = ri < 3 ? 'premium' : 'std';
    return {
      id: letter,
      label: letter,
      seats: Array.from({ length: 12 }, (_, c) =>
        seat(
          `${letter}${c + 1}`,
          `${letter}${c + 1}`,
          colX(c, 6) + P,
          y,
          tier,
          ri === 9 && (c === 0 || c === 11),
        ),
      ),
    };
  });
  const balconyY = 20 + stageH + 24 + 10 * P + 48;
  const balcony: Layout['sections'][number]['rows'] = ['K', 'L', 'M'].map((letter, ri) => ({
    id: letter,
    label: letter,
    seats: Array.from({ length: 10 }, (_, c) =>
      seat(`${letter}${c + 1}`, `${letter}${c + 1}`, colX(c, 5) + P * 2, balconyY + ri * P, 'balcony'),
    ),
  }));
  const width = left * 2 + P * 14 + aisle;
  return {
    id: 'hall-150',
    name: 'Small theatre (150 seats)',
    kind: 'hall',
    width,
    height: balconyY + 3 * P + 24,
    seatSize: S,
    tiers: [
      { id: 'premium', name: 'Premium stalls (A-C)', priceKes: 3500 },
      { id: 'std', name: 'Standard stalls (D-J)', priceKes: 2500 },
      { id: 'balcony', name: 'Balcony', priceKes: 1500 },
    ],
    sections: [
      { id: 'stalls', name: 'Stalls', rows: stalls },
      { id: 'balcony', name: 'Balcony', rows: balcony },
    ],
    decor: [
      { kind: 'stage', x: left + P, y: 20, w: width - 2 * (left + P), h: stageH, label: 'STAGE' },
      { kind: 'label', x: left + P, y: balconyY - 28, w: 120, h: 16, label: 'Balcony' },
    ],
  };
}

mkdirSync('layouts', { recursive: true });
for (const [layout, expected] of [
  [matatu14(), 14],
  [coach49(), 49],
  [hall150(), 150],
] as const) {
  const parsed = LayoutSchema.parse(layout);
  const count = flattenSeats(parsed).length;
  if (count !== expected) throw new Error(`${layout.id}: expected ${expected} seats, got ${count}`);
  writeFileSync(`layouts/${layout.id}.json`, `${JSON.stringify(parsed, null, 1)}\n`);
  console.log(`${layout.id}: ${count} seats`);
}
