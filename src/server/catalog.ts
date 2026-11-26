import type { Ctx } from './context.ts';
import { all, one, run, tx } from './db.ts';
import { notFound } from './errors.ts';
import { flattenSeats, LayoutSchema, type Layout } from '../shared/layout.ts';

export function saveLayout(ctx: Ctx, layout: Layout): void {
  run(
    ctx.db,
    `INSERT INTO layouts (id, name, kind, json) VALUES (?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET name = excluded.name, kind = excluded.kind, json = excluded.json`,
    layout.id,
    layout.name,
    layout.kind,
    JSON.stringify(layout),
  );
}

export function createEvent(
  ctx: Ctx,
  e: {
    id: string;
    title: string;
    kind: 'event' | 'trip';
    description: string;
    venue: string;
    layoutId: string;
  },
): void {
  run(
    ctx.db,
    `INSERT INTO events (id, title, kind, description, venue, layout_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    e.id,
    e.title,
    e.kind,
    e.description,
    e.venue,
    e.layoutId,
    ctx.clock.now(),
  );
}

/** Creates a departure and materialises one inventory row per seat from the event's layout. */
export function createDeparture(ctx: Ctx, d: { id: string; eventId: string; startsAt: number }): void {
  tx(ctx.db, () => {
    const row = one<{ json: string }>(
      ctx.db,
      `SELECT l.json FROM events e JOIN layouts l ON l.id = e.layout_id WHERE e.id = ?`,
      d.eventId,
    );
    if (!row) throw notFound('Event not found');
    const layout = LayoutSchema.parse(JSON.parse(row.json));
    const price = new Map(layout.tiers.map((t) => [t.id, t.priceKes]));
    run(
      ctx.db,
      `INSERT INTO departures (id, event_id, starts_at, created_at) VALUES (?, ?, ?, ?)`,
      d.id,
      d.eventId,
      d.startsAt,
      ctx.clock.now(),
    );
    for (const s of flattenSeats(layout)) {
      run(
        ctx.db,
        `INSERT INTO departure_seats (departure_id, seat_id, label, section, row_label, tier_id, price_kes, accessible)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        d.id,
        s.id,
        s.label,
        s.section,
        s.rowLabel,
        s.tier,
        price.get(s.tier) ?? 0,
        s.accessible ? 1 : 0,
      );
    }
  });
}

export function listEvents(ctx: Ctx) {
  const now = ctx.clock.now();
  const events = all<{
    id: string;
    title: string;
    kind: string;
    description: string;
    venue: string;
    layout_id: string;
    layout_name: string;
  }>(
    ctx.db,
    `SELECT e.id, e.title, e.kind, e.description, e.venue, e.layout_id, l.name AS layout_name FROM events e JOIN layouts l ON l.id = e.layout_id ORDER BY e.rowid`,
  );
  return events.map((e) => {
    const deps = all<{ id: string; starts_at: number }>(
      ctx.db,
      `SELECT id, starts_at FROM departures WHERE event_id = ? AND status = 'scheduled' AND starts_at > ? ORDER BY starts_at`,
      e.id,
      now,
    );
    const minPrice = one<{ p: number | null }>(
      ctx.db,
      `SELECT MIN(ds.price_kes) AS p FROM departure_seats ds JOIN departures d ON d.id = ds.departure_id WHERE d.event_id = ?`,
      e.id,
    );
    return {
      id: e.id,
      title: e.title,
      kind: e.kind,
      description: e.description,
      venue: e.venue,
      layoutName: e.layout_name,
      fromPriceKes: minPrice?.p ?? 0,
      departures: deps.map((d) => {
        const c = one<{ total: number; taken: number }>(
          ctx.db,
          `SELECT (SELECT COUNT(*) FROM departure_seats WHERE departure_id = ?) AS total,
                  (SELECT COUNT(*) FROM seat_claims WHERE departure_id = ? AND (kind = 'booked' OR expires_at > ?)) AS taken`,
          d.id,
          d.id,
          now,
        )!;
        return { id: d.id, startsAt: d.starts_at, seatsTotal: c.total, seatsLeft: c.total - c.taken };
      }),
    };
  });
}

export function getDeparture(ctx: Ctx, id: string) {
  const row = one<{
    id: string;
    starts_at: number;
    status: string;
    title: string;
    kind: string;
    venue: string;
    description: string;
    json: string;
  }>(
    ctx.db,
    `SELECT d.id, d.starts_at, d.status, e.title, e.kind, e.venue, e.description, l.json
       FROM departures d JOIN events e ON e.id = d.event_id JOIN layouts l ON l.id = e.layout_id WHERE d.id = ?`,
    id,
  );
  if (!row) throw notFound('Departure not found');
  const accessible = all<{ seat_id: string }>(
    ctx.db,
    `SELECT seat_id FROM departure_seats WHERE departure_id = ? AND accessible = 1`,
    id,
  );
  return {
    id: row.id,
    startsAt: row.starts_at,
    status: row.status,
    title: row.title,
    kind: row.kind,
    venue: row.venue,
    description: row.description,
    layout: LayoutSchema.parse(JSON.parse(row.json)),
    accessibleSeatIds: accessible.map((a) => a.seat_id),
  };
}
