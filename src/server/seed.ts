/**
 * Loads synthetic sample data: three events (a coach, a matatu, a small theatre), their
 * departures, demo staff accounts, and a spread of purchases and gate scans made through the same
 * services the app uses. Everything here is made up. Re-running replaces the database.
 */
import { existsSync, rmSync } from 'node:fs';
import { bootstrap } from './bootstrap.ts';
import { FakeClock } from './clock.ts';
import { createUser } from './auth.ts';
import { createDeparture, createEvent, saveLayout } from './catalog.ts';
import { loadConfig } from './config.ts';
import { checkout } from './bookings.ts';
import { all, one, openDb } from './db.ts';
import { processScan } from './gate.ts';
import { createHold } from './inventory.ts';
import { loadShippedLayouts } from './layouts.ts';
import { TicketKeys } from './ticketKeys.ts';
import type { Layout } from '../shared/layout.ts';

export const DEMO_USERS = [
  {
    username: 'organiser',
    password: 'organiser-demo-pass',
    role: 'organiser',
    displayName: 'Demo Organiser',
  },
  { username: 'gate1', password: 'gate-demo-pass', role: 'gate', displayName: 'Gate Staff (demo)' },
] as const;

const NAMES = [
  'Amina Wanjiru',
  'Brian Otieno',
  'Cynthia Achieng',
  'Daniel Kiprop',
  'Esther Mwende',
  'Felix Mutiso',
  'Grace Njeri',
  'Hassan Abdi',
  'Irene Chebet',
  'James Kamau',
  'Karen Akinyi',
  'Lucy Wairimu',
  'Moses Odhiambo',
  'Naomi Cherono',
  'Peter Mwangi',
  'Rose Atieno',
  'Samuel Kariuki',
  'Tabitha Nduta',
  'Victor Ndungu',
  'Zawadi Mohamed',
];

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function seed(dbPath: string, keyPath: string, log: (s: string) => void = console.log) {
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) if (existsSync(f)) rmSync(f);
  const config = { ...loadConfig({}), databasePath: dbPath, ticketKeyPath: keyPath };
  const clock = new FakeClock(Date.now());
  const { ctx, mock } = bootstrap(config, {
    db: openDb(dbPath),
    clock,
    keys: TicketKeys.loadOrCreate(keyPath),
  });
  const real = Date.now();
  const rand = rng(2026);
  const HOUR = 3600_000;
  const DAY = 24 * HOUR;

  const layouts = new Map<string, Layout>(loadShippedLayouts().map((l) => [l.id, l]));
  for (const l of layouts.values()) saveLayout(ctx, l);

  const nextQuarter = (ms: number) => Math.ceil(ms / (15 * 60_000)) * 15 * 60_000;
  const atEat = (daysAhead: number, hh: number, mm: number) => {
    // East Africa Time is UTC+3 all year.
    const eat = new Date(real + daysAhead * DAY + 3 * HOUR);
    return Date.UTC(eat.getUTCFullYear(), eat.getUTCMonth(), eat.getUTCDate(), hh - 3, mm);
  };

  const events = [
    {
      id: 'evt-mombasa-express',
      title: 'Nairobi to Mombasa Express',
      kind: 'trip' as const,
      venue: 'Nairobi (Machakos Country Bus) to Mombasa',
      description: 'Sample coach service, 49 seats, 2+2. Synthetic data.',
      layoutId: 'coach-49',
      times: [atEat(1, 7, 30), atEat(1, 21, 0), atEat(2, 7, 30)],
    },
    {
      id: 'evt-nakuru-shuttle',
      title: 'Nairobi to Nakuru Shuttle',
      kind: 'trip' as const,
      venue: 'Nairobi (Odeon) to Nakuru',
      description: 'Sample 14-seater matatu shuttle. Synthetic data.',
      layoutId: 'matatu-14',
      times: [nextQuarter(real + 2 * HOUR), atEat(1, 6, 0), atEat(1, 14, 0)],
    },
    {
      id: 'evt-last-matatu',
      title: 'The Last Matatu (stage play)',
      kind: 'event' as const,
      venue: 'Sample Community Theatre, Nairobi',
      description: 'An invented play for demonstration. Stalls and balcony, 150 seats. Synthetic data.',
      layoutId: 'hall-150',
      times: [nextQuarter(real + 3 * HOUR), atEat(1, 19, 0), atEat(2, 15, 0)],
    },
  ];

  const depIds: { id: string; layoutId: string; startsAt: number }[] = [];
  for (const e of events) {
    createEvent(ctx, e);
    e.times.forEach((startsAt, i) => {
      const id = `dep-${e.id.replace('evt-', '')}-${i + 1}`;
      createDeparture(ctx, { id, eventId: e.id, startsAt });
      depIds.push({ id, layoutId: e.layoutId, startsAt });
    });
  }

  for (const u of DEMO_USERS) await createUser(ctx, u);

  // Purchases go through hold -> checkout -> signed callback, spread over the last three days.
  const targets: Record<string, number> = {
    'dep-mombasa-express-1': 31,
    'dep-mombasa-express-2': 12,
    'dep-mombasa-express-3': 4,
    'dep-nakuru-shuttle-1': 9,
    'dep-nakuru-shuttle-2': 5,
    'dep-nakuru-shuttle-3': 2,
    'dep-last-matatu-1': 88,
    'dep-last-matatu-2': 36,
    'dep-last-matatu-3': 10,
  };
  let phoneN = 1;
  let buyer = 0;
  for (const d of depIds) {
    const layout = layouts.get(d.layoutId)!;
    const rows = layout.sections.flatMap((s) => s.rows);
    let remaining = targets[d.id] ?? 0;
    let guard = 0;
    while (remaining > 0 && guard++ < 400) {
      const row = rows[Math.floor(rand() * rows.length)]!;
      const size = Math.min(remaining, 1 + Math.floor(rand() * 4));
      const start = Math.floor(rand() * Math.max(1, row.seats.length - size + 1));
      const seatIds = row.seats.slice(start, start + size).map((s) => s.id);
      const t = real - Math.floor(rand() * 3 * DAY);
      clock.set(Math.min(t, d.startsAt - 60_000));
      const session = `seed-session-${buyer}`;
      try {
        createHold(ctx, { departureId: d.id, sessionId: session, seatIds });
      } catch {
        continue; // seats already sold in an earlier purchase: pick another row
      }
      const hold = one<{ id: string }>(
        ctx.db,
        `SELECT id FROM holds WHERE session_id = ? AND departure_id = ?`,
        session,
        d.id,
      )!;
      const phone = `0700 000 ${String((phoneN++ % 999) + 1).padStart(3, '0')}`;
      await checkout(ctx, { holdId: hold.id, sessionId: session, name: NAMES[buyer % NAMES.length]!, phone });
      const prompt = mock.pending().find((p) => p.phone === `254${phone.replace(/\s/g, '').slice(1)}`)!;
      await mock.resolve(prompt.providerRef, 'success');
      remaining -= seatIds.length;
      buyer += 1;
    }
  }

  // The nearest show has doors open: scan a share of its tickets through two gates.
  const soon = depIds.filter((d) => d.layoutId === 'hall-150').sort((a, b) => a.startsAt - b.startsAt)[0]!;
  const tickets = all<{ id: string; seat_id: string; version: number }>(
    ctx.db,
    `SELECT id, seat_id, version FROM tickets WHERE departure_id = ? ORDER BY rowid`,
    soon.id,
  );
  tickets.slice(0, 26).forEach((t, i) => {
    clock.set(real - (26 - i) * 70_000);
    processScan(ctx, {
      code: ctx.keys.signClaims({
        ticketId: t.id,
        departureId: soon.id,
        seatId: t.seat_id,
        version: t.version,
      }),
      gate: i % 3 === 0 ? 'Gate B' : 'Gate A',
      staffId: null,
    });
  });

  const counts = {
    events: events.length,
    departures: depIds.length,
    tickets: one<{ n: number }>(ctx.db, `SELECT COUNT(*) AS n FROM tickets`)!.n,
  };
  log(
    `Seeded ${counts.events} events, ${counts.departures} departures, ${counts.tickets} synthetic tickets.`,
  );
  log('Demo staff (local sample data only):');
  for (const u of DEMO_USERS) log(`  ${u.role.padEnd(9)} ${u.username} / ${u.password}`);
  mock.close();
  ctx.db.close();
  return counts;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const c = loadConfig();
  await seed(c.databasePath, c.ticketKeyPath);
}
