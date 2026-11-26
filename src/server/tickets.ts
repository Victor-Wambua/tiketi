import { timingSafeEqual } from 'node:crypto';
import type { Ctx } from './context.ts';
import { all, one, run, tx } from './db.ts';
import { badRequest, conflict, forbidden, notFound } from './errors.ts';
import { newId } from './ids.ts';
import { qrSvg } from './qr.ts';

export interface TicketRow {
  id: string;
  booking_id: string;
  departure_id: string;
  seat_id: string;
  holder_name: string;
  version: number;
  status: 'valid' | 'void';
  void_reason: string | null;
  void_at: number | null;
  issued_at: number;
  admitted_at: number | null;
  admitted_gate: string | null;
  admitted_scan_id: number | null;
}

export interface TicketView {
  id: string;
  bookingId: string;
  departureId: string;
  eventTitle: string;
  venue: string;
  kind: 'event' | 'trip';
  startsAt: number;
  seatId: string;
  seatLabel: string;
  section: string;
  rowLabel: string;
  tier: string;
  priceKes: number;
  holderName: string;
  version: number;
  status: 'valid' | 'void' | 'used';
  voidReason: string | null;
  admittedAt: number | null;
  admittedGate: string | null;
  code: string;
  qrSvg: string;
  link: string;
}

/** Called inside the confirmation transaction: one ticket per seat on the booking's hold. */
export function issueTickets(
  ctx: Ctx,
  booking: { id: string; hold_id: string; departure_id: string; customer_name: string },
) {
  const seats = all<{ seat_id: string }>(
    ctx.db,
    `SELECT seat_id FROM hold_seats WHERE hold_id = ? ORDER BY rowid`,
    booking.hold_id,
  );
  const now = ctx.clock.now();
  return seats.map((s) => {
    const id = newId('tkt');
    run(
      ctx.db,
      `INSERT INTO tickets (id, booking_id, departure_id, seat_id, holder_name, version, status, issued_at)
       VALUES (?, ?, ?, ?, ?, 1, 'valid', ?)`,
      id,
      booking.id,
      booking.departure_id,
      s.seat_id,
      booking.customer_name,
      now,
    );
    return id;
  });
}

export function ticketLink(ctx: Ctx, t: Pick<TicketRow, 'id' | 'version'>): string {
  return `/t/${t.id}?k=${ctx.keys.viewToken('ticket', t.id, t.version)}`;
}

export function ticketView(ctx: Ctx, t: TicketRow): TicketView {
  const meta = one<{
    title: string;
    venue: string;
    kind: 'event' | 'trip';
    starts_at: number;
    label: string;
    section: string;
    row_label: string;
    tier_id: string;
    price_kes: number;
    layout_json: string;
  }>(
    ctx.db,
    `SELECT e.title, e.venue, e.kind, d.starts_at, ds.label, ds.section, ds.row_label, ds.tier_id, ds.price_kes, l.json AS layout_json
       FROM departures d JOIN events e ON e.id = d.event_id JOIN layouts l ON l.id = e.layout_id
       JOIN departure_seats ds ON ds.departure_id = d.id AND ds.seat_id = ?
      WHERE d.id = ?`,
    t.seat_id,
    t.departure_id,
  )!;
  const tiers = (JSON.parse(meta.layout_json) as { tiers: { id: string; name: string }[] }).tiers;
  const code = ctx.keys.signClaims({
    ticketId: t.id,
    departureId: t.departure_id,
    seatId: t.seat_id,
    version: t.version,
  });
  return {
    id: t.id,
    bookingId: t.booking_id,
    departureId: t.departure_id,
    eventTitle: meta.title,
    venue: meta.venue,
    kind: meta.kind,
    startsAt: meta.starts_at,
    seatId: t.seat_id,
    seatLabel: meta.label,
    section: meta.section,
    rowLabel: meta.row_label,
    tier: tiers.find((x) => x.id === meta.tier_id)?.name ?? meta.tier_id,
    priceKes: meta.price_kes,
    holderName: t.holder_name,
    version: t.version,
    status: t.status === 'void' ? 'void' : t.admitted_at ? 'used' : 'valid',
    voidReason: t.void_reason,
    admittedAt: t.admitted_at,
    admittedGate: t.admitted_gate,
    code,
    qrSvg: qrSvg(code, { label: `QR code for seat ${meta.label}` }),
    link: ticketLink(ctx, t),
  };
}

export function getTicketByLink(ctx: Ctx, ticketId: string, token: string): TicketView {
  const t = one<TicketRow>(ctx.db, `SELECT * FROM tickets WHERE id = ?`, ticketId);
  if (!t) throw notFound('Ticket not found');
  if (!safeEqual(token, ctx.keys.viewToken('ticket', t.id, t.version))) {
    throw conflict(
      'ticket_link_expired',
      'This ticket link is no longer valid. The ticket may have been transferred.',
    );
  }
  return ticketView(ctx, t);
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Re-issue a ticket to a new holder. The version goes up by one: the old QR (and the old link) stop
 * working immediately because the signed code embeds the version and the server only admits the
 * current one.
 */
export function transferTicket(
  ctx: Ctx,
  input: { ticketId: string; sessionId: string; newHolderName: string },
): TicketView {
  const name = input.newHolderName.trim();
  if (name.length < 2 || name.length > 80) throw badRequest('invalid_name', "Enter the new holder's name");
  const t = tx(ctx.db, () => {
    const t = one<TicketRow>(ctx.db, `SELECT * FROM tickets WHERE id = ?`, input.ticketId);
    if (!t) throw notFound('Ticket not found');
    const booking = one<{ session_id: string }>(
      ctx.db,
      `SELECT session_id FROM bookings WHERE id = ?`,
      t.booking_id,
    )!;
    if (booking.session_id !== input.sessionId) throw forbidden('Only the buyer can transfer this ticket');
    if (t.status !== 'valid') throw conflict('ticket_void', 'This ticket is no longer valid');
    if (t.admitted_at) throw conflict('ticket_used', 'This ticket has already been used');
    const dep = one<{ starts_at: number }>(
      ctx.db,
      `SELECT starts_at FROM departures WHERE id = ?`,
      t.departure_id,
    )!;
    if (dep.starts_at <= ctx.clock.now())
      throw conflict('departure_started', 'This departure has already started');
    const changes = run(
      ctx.db,
      `UPDATE tickets SET version = version + 1, holder_name = ? WHERE id = ? AND version = ? AND status = 'valid' AND admitted_at IS NULL`,
      name,
      t.id,
      t.version,
    );
    if (changes !== 1) throw conflict('ticket_changed', 'This ticket just changed. Please reload.');
    return one<TicketRow>(ctx.db, `SELECT * FROM tickets WHERE id = ?`, t.id)!;
  });
  return ticketView(ctx, t);
}
