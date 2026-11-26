import type { Ctx } from './context.ts';
import { all, one } from './db.ts';
import { notFound } from './errors.ts';

const BUCKET_MS = 15 * 60_000;

export function dashboard(ctx: Ctx, departureId: string) {
  const now = ctx.clock.now();
  const dep = one<{ id: string; starts_at: number; title: string; venue: string }>(
    ctx.db,
    `SELECT d.id, d.starts_at, e.title, e.venue FROM departures d JOIN events e ON e.id = d.event_id WHERE d.id = ?`,
    departureId,
  );
  if (!dep) throw notFound('Departure not found');

  const seats = all<{
    seat_id: string;
    label: string;
    section: string;
    row_label: string;
    tier_id: string;
    price_kes: number;
    claim: string | null;
    scanned: number | null;
  }>(
    ctx.db,
    `SELECT ds.seat_id, ds.label, ds.section, ds.row_label, ds.tier_id, ds.price_kes,
            CASE WHEN sc.kind = 'booked' THEN 'booked' WHEN sc.kind = 'hold' AND sc.expires_at > ? THEN 'hold' END AS claim,
            (SELECT 1 FROM tickets t WHERE t.departure_id = ds.departure_id AND t.seat_id = ds.seat_id AND t.status = 'valid' AND t.admitted_at IS NOT NULL) AS scanned
       FROM departure_seats ds
  LEFT JOIN seat_claims sc ON sc.departure_id = ds.departure_id AND sc.seat_id = ds.seat_id
      WHERE ds.departure_id = ? ORDER BY ds.rowid`,
    now,
    departureId,
  );
  const states: Record<string, 'available' | 'held' | 'sold' | 'scanned'> = {};
  const counts = { available: 0, held: 0, sold: 0, scanned: 0 };
  for (const s of seats) {
    const st =
      s.claim === 'booked' ? (s.scanned ? 'scanned' : 'sold') : s.claim === 'hold' ? 'held' : 'available';
    states[s.seat_id] = st;
    counts[st] += 1;
  }

  const tiers = all<{ tier_id: string; capacity: number; sold: number; revenue: number }>(
    ctx.db,
    `SELECT ds.tier_id, COUNT(*) AS capacity,
            SUM(CASE WHEN sc.kind = 'booked' THEN 1 ELSE 0 END) AS sold,
            COALESCE(SUM(CASE WHEN sc.kind = 'booked' THEN ds.price_kes ELSE 0 END), 0) AS revenue
       FROM departure_seats ds LEFT JOIN seat_claims sc ON sc.departure_id = ds.departure_id AND sc.seat_id = ds.seat_id
      WHERE ds.departure_id = ? GROUP BY ds.tier_id`,
    departureId,
  );
  const layoutRow = one<{ json: string }>(
    ctx.db,
    `SELECT l.json FROM departures d JOIN events e ON e.id = d.event_id JOIN layouts l ON l.id = e.layout_id WHERE d.id = ?`,
    departureId,
  )!;
  const tierNames = new Map(
    (JSON.parse(layoutRow.json) as { tiers: { id: string; name: string }[] }).tiers.map((t) => [
      t.id,
      t.name,
    ]),
  );

  // Occupancy over time: +1 when a ticket is issued, -1 when it is voided.
  const events = all<{ at: number; delta: number }>(
    ctx.db,
    `SELECT issued_at AS at, 1 AS delta FROM tickets WHERE departure_id = ?
     UNION ALL SELECT void_at AS at, -1 AS delta FROM tickets WHERE departure_id = ? AND void_at IS NOT NULL ORDER BY at`,
    departureId,
    departureId,
  );
  const occupancy: { at: number; sold: number }[] = [];
  let running = 0;
  for (const e of events) {
    running += e.delta;
    const bucket = Math.floor(e.at / BUCKET_MS) * BUCKET_MS;
    const last = occupancy[occupancy.length - 1];
    if (last && last.at === bucket) last.sold = running;
    else occupancy.push({ at: bucket, sold: running });
  }

  const throughputRows = all<{ gate: string; at: number }>(
    ctx.db,
    `SELECT admitted_gate AS gate, admitted_at AS at FROM tickets WHERE departure_id = ? AND admitted_at IS NOT NULL AND status = 'valid'`,
    departureId,
  );
  const gateBuckets = new Map<string, Map<number, number>>();
  for (const r of throughputRows) {
    const g = r.gate ?? 'Unknown';
    const b = Math.floor(r.at / BUCKET_MS) * BUCKET_MS;
    const m = gateBuckets.get(g) ?? new Map<number, number>();
    m.set(b, (m.get(b) ?? 0) + 1);
    gateBuckets.set(g, m);
  }

  const conflicts = all<{
    ticket_id: string;
    seat: string;
    gate: string;
    at: number;
    offline: number;
    result: string;
  }>(
    ctx.db,
    `SELECT s.ticket_id, ds.label AS seat, s.gate, COALESCE(s.client_scanned_at, s.received_at) AS at, s.offline, s.result
       FROM scans s JOIN tickets t ON t.id = s.ticket_id
       JOIN departure_seats ds ON ds.departure_id = t.departure_id AND ds.seat_id = t.seat_id
      WHERE s.departure_id = ? AND s.conflict = 1 ORDER BY s.ticket_id, at`,
    departureId,
  );

  const refunds = all<{
    id: string;
    amount_kes: number;
    reason: string;
    status: string;
    created_at: number;
    customer_name: string;
    booking_id: string;
  }>(
    ctx.db,
    `SELECT r.id, r.amount_kes, r.reason, r.status, r.created_at, b.customer_name, b.id AS booking_id
       FROM refunds r JOIN bookings b ON b.id = r.booking_id WHERE b.departure_id = ? ORDER BY r.created_at DESC`,
    departureId,
  );

  const revenue = tiers.reduce((sum, t) => sum + t.revenue, 0);
  const refunded = refunds.filter((r) => r.status === 'processed').reduce((sum, r) => sum + r.amount_kes, 0);
  return {
    departure: { id: dep.id, title: dep.title, venue: dep.venue, startsAt: dep.starts_at },
    totals: { capacity: seats.length, ...counts, revenueKes: revenue, refundedKes: refunded },
    byTier: tiers.map((t) => ({
      tierId: t.tier_id,
      name: tierNames.get(t.tier_id) ?? t.tier_id,
      capacity: t.capacity,
      sold: t.sold,
      revenueKes: t.revenue,
    })),
    seats: seats.map((s) => ({
      seatId: s.seat_id,
      label: s.label,
      section: s.section,
      row: s.row_label,
      tierId: s.tier_id,
      state: states[s.seat_id]!,
    })),
    occupancy,
    throughput: [...gateBuckets.entries()].map(([gate, m]) => ({
      gate,
      buckets: [...m.entries()].sort((a, b) => a[0] - b[0]).map(([at, count]) => ({ at, count })),
    })),
    conflicts: conflicts.map((c) => ({
      ticketId: c.ticket_id,
      seat: c.seat,
      gate: c.gate,
      at: c.at,
      offline: c.offline === 1,
      result: c.result,
    })),
    refunds: refunds.map((r) => ({
      id: r.id,
      bookingId: r.booking_id,
      customerName: r.customer_name,
      amountKes: r.amount_kes,
      reason: r.reason,
      status: r.status,
      createdAt: r.created_at,
    })),
  };
}

/** Cells starting with = + - @ (or tab/CR) are prefixed so spreadsheets do not run them as formulas. */
export function csvCell(value: string | number | null): string {
  let s = value === null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function exportCsv(ctx: Ctx, departureId: string): string {
  const rows = all<{
    id: string;
    label: string;
    section: string;
    tier_id: string;
    price_kes: number;
    holder_name: string;
    status: string;
    customer_name: string;
    phone: string;
    issued_at: number;
    admitted_at: number | null;
    admitted_gate: string | null;
    version: number;
  }>(
    ctx.db,
    `SELECT t.id, ds.label, ds.section, ds.tier_id, ds.price_kes, t.holder_name, t.status, b.customer_name, b.phone, t.issued_at, t.admitted_at, t.admitted_gate, t.version
       FROM tickets t JOIN bookings b ON b.id = t.booking_id
       JOIN departure_seats ds ON ds.departure_id = t.departure_id AND ds.seat_id = t.seat_id
      WHERE t.departure_id = ? ORDER BY t.rowid`,
    departureId,
  );
  const iso = (ms: number | null) => (ms === null ? '' : new Date(ms).toISOString());
  const header = [
    'ticket_id',
    'seat',
    'section',
    'tier',
    'price_kes',
    'holder',
    'buyer',
    'buyer_phone',
    'status',
    'version',
    'issued_at',
    'admitted_at',
    'admitted_gate',
  ];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.id,
        r.label,
        r.section,
        r.tier_id,
        r.price_kes,
        r.holder_name,
        r.customer_name,
        r.phone,
        r.status,
        r.version,
        iso(r.issued_at),
        iso(r.admitted_at),
        r.admitted_gate,
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}
