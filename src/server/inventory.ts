import type { Ctx } from './context.ts';
import { all, one, run, tx } from './db.ts';
import { badRequest, conflict, notFound } from './errors.ts';
import { newId } from './ids.ts';

export interface HoldRow {
  id: string;
  departure_id: string;
  session_id: string;
  status: 'active' | 'expired' | 'released' | 'converted';
  created_at: number;
  expires_at: number;
  extensions: number;
  total_kes: number;
}

export interface HoldView {
  id: string;
  departureId: string;
  status: HoldRow['status'];
  expiresAt: number;
  extensions: number;
  canExtend: boolean;
  totalKes: number;
  seats: { seatId: string; label: string; priceKes: number; tierId: string }[];
}

export type SeatState = 'available' | 'held' | 'sold' | 'mine';

export function holdView(ctx: Ctx, hold: HoldRow): HoldView {
  const seats = all<{ seat_id: string; label: string; price_kes: number; tier_id: string }>(
    ctx.db,
    `SELECT hs.seat_id, ds.label, hs.price_kes, ds.tier_id FROM hold_seats hs
       JOIN departure_seats ds ON ds.departure_id = ? AND ds.seat_id = hs.seat_id
      WHERE hs.hold_id = ? ORDER BY ds.rowid`,
    hold.departure_id,
    hold.id,
  );
  return {
    id: hold.id,
    departureId: hold.departure_id,
    status: hold.status,
    expiresAt: hold.expires_at,
    extensions: hold.extensions,
    canExtend: canExtend(ctx, hold),
    totalKes: hold.total_kes,
    seats: seats.map((s) => ({
      seatId: s.seat_id,
      label: s.label,
      priceKes: s.price_kes,
      tierId: s.tier_id,
    })),
  };
}

function canExtend(ctx: Ctx, hold: HoldRow): boolean {
  return (
    hold.status === 'active' &&
    hold.extensions < 1 &&
    hold.expires_at > ctx.clock.now() &&
    Math.min(hold.expires_at + ctx.config.holdExtensionMs, hold.created_at + ctx.config.holdMaxLifetimeMs) >
      hold.expires_at
  );
}

/**
 * Lazy + sweeper release. Marks overdue active holds expired, deletes their seat claims (compare on
 * kind='hold', so a seat that has since been booked is never touched) and expires any booking that
 * was still waiting for payment on them.
 */
export function expireDueHolds(ctx: Ctx, departureId?: string): number {
  const now = ctx.clock.now();
  const touched = new Set<string>();
  const expired = tx(ctx.db, () => {
    const due = departureId
      ? all<{ id: string; departure_id: string }>(
          ctx.db,
          `SELECT id, departure_id FROM holds WHERE status = 'active' AND expires_at <= ? AND departure_id = ?`,
          now,
          departureId,
        )
      : all<{ id: string; departure_id: string }>(
          ctx.db,
          `SELECT id, departure_id FROM holds WHERE status = 'active' AND expires_at <= ?`,
          now,
        );
    for (const h of due) {
      run(ctx.db, `UPDATE holds SET status = 'expired' WHERE id = ? AND status = 'active'`, h.id);
      run(ctx.db, `DELETE FROM seat_claims WHERE hold_id = ? AND kind = 'hold'`, h.id);
      run(
        ctx.db,
        `UPDATE bookings SET status = 'expired' WHERE hold_id = ? AND status = 'pending_payment'`,
        h.id,
      );
      touched.add(h.departure_id);
    }
    return due.length;
  });
  for (const d of touched) ctx.bus.publish(d);
  return expired;
}

export function createHold(
  ctx: Ctx,
  input: { departureId: string; sessionId: string; seatIds: string[] },
): HoldView {
  const seatIds = [...new Set(input.seatIds)];
  if (seatIds.length < 1) throw badRequest('no_seats', 'Choose at least one seat');
  if (seatIds.length > ctx.config.maxSeatsPerHold) {
    throw badRequest('too_many_seats', `You can hold at most ${ctx.config.maxSeatsPerHold} seats at once`);
  }
  const now = ctx.clock.now();

  const hold = tx(ctx.db, () => {
    const dep = one<{ starts_at: number; status: string }>(
      ctx.db,
      `SELECT starts_at, status FROM departures WHERE id = ?`,
      input.departureId,
    );
    if (!dep) throw notFound('Departure not found');
    if (dep.status !== 'scheduled') throw conflict('departure_closed', 'This departure is cancelled');
    if (dep.starts_at <= now) throw conflict('departure_closed', 'Booking has closed for this departure');

    const seats = all<{ seat_id: string; price_kes: number }>(
      ctx.db,
      `SELECT seat_id, price_kes FROM departure_seats WHERE departure_id = ? AND seat_id IN (${seatIds
        .map(() => '?')
        .join(',')})`,
      input.departureId,
      ...seatIds,
    );
    if (seats.length !== seatIds.length)
      throw badRequest('unknown_seat', 'One of those seats does not exist');

    // Lazy release of anything overdue on this departure, so expired holds never block a seat.
    expireDueHolds(ctx, input.departureId);

    // One live hold per customer per departure: choosing again replaces the previous selection.
    const previous = one<HoldRow>(
      ctx.db,
      `SELECT * FROM holds WHERE departure_id = ? AND session_id = ? AND status = 'active'`,
      input.departureId,
      input.sessionId,
    );
    if (previous) {
      const booking = one<{ status: string }>(
        ctx.db,
        `SELECT status FROM bookings WHERE hold_id = ? AND status IN ('pending_payment','confirmed')`,
        previous.id,
      );
      if (booking) {
        throw conflict(
          'hold_in_checkout',
          'Finish or cancel your current booking before choosing other seats',
        );
      }
      run(ctx.db, `UPDATE holds SET status = 'released' WHERE id = ?`, previous.id);
      run(ctx.db, `DELETE FROM seat_claims WHERE hold_id = ? AND kind = 'hold'`, previous.id);
    }

    const holdId = newId('hld');
    const expiresAt = now + ctx.config.holdTtlMs;
    const total = seats.reduce((sum, s) => sum + s.price_kes, 0);
    run(
      ctx.db,
      `INSERT INTO holds (id, departure_id, session_id, status, created_at, expires_at, total_kes)
       VALUES (?, ?, ?, 'active', ?, ?, ?)`,
      holdId,
      input.departureId,
      input.sessionId,
      now,
      expiresAt,
      total,
    );

    // Atomic insert-if-absent on the (departure, seat) primary key. If any seat is already claimed,
    // `changes` is 0 for it and the whole transaction rolls back: all seats or none.
    const taken: string[] = [];
    for (const s of seats) {
      const changes = run(
        ctx.db,
        `INSERT INTO seat_claims (departure_id, seat_id, kind, hold_id, expires_at)
         VALUES (?, ?, 'hold', ?, ?) ON CONFLICT (departure_id, seat_id) DO NOTHING`,
        input.departureId,
        s.seat_id,
        holdId,
        expiresAt,
      );
      if (changes === 0) taken.push(s.seat_id);
      run(
        ctx.db,
        `INSERT INTO hold_seats (hold_id, seat_id, price_kes) VALUES (?, ?, ?)`,
        holdId,
        s.seat_id,
        s.price_kes,
      );
    }
    if (taken.length > 0) {
      throw conflict('seat_unavailable', 'Someone else just took that seat. Please choose another.', {
        seatIds: taken,
      });
    }
    return one<HoldRow>(ctx.db, `SELECT * FROM holds WHERE id = ?`, holdId)!;
  });

  ctx.bus.publish(input.departureId);
  return holdView(ctx, hold);
}

export function getHoldFor(ctx: Ctx, holdId: string, sessionId: string): HoldRow {
  const hold = one<HoldRow>(ctx.db, `SELECT * FROM holds WHERE id = ?`, holdId);
  // 404 rather than 403 so hold ids of other customers cannot be probed.
  if (!hold || hold.session_id !== sessionId) throw notFound('Hold not found');
  return hold;
}

/** Extension rule: once per hold, +5 minutes, and never beyond 15 minutes after the hold was made. */
export function extendHold(ctx: Ctx, input: { holdId: string; sessionId: string }): HoldView {
  const updated = tx(ctx.db, () => {
    const hold = getHoldFor(ctx, input.holdId, input.sessionId);
    const now = ctx.clock.now();
    if (hold.status !== 'active' || hold.expires_at <= now) {
      throw conflict('hold_expired', 'This hold has expired. Please choose your seats again.');
    }
    if (!canExtend(ctx, hold)) {
      throw conflict('extension_limit', 'This hold has already been extended once');
    }
    const next = Math.min(
      hold.expires_at + ctx.config.holdExtensionMs,
      hold.created_at + ctx.config.holdMaxLifetimeMs,
    );
    run(ctx.db, `UPDATE holds SET expires_at = ?, extensions = extensions + 1 WHERE id = ?`, next, hold.id);
    run(ctx.db, `UPDATE seat_claims SET expires_at = ? WHERE hold_id = ? AND kind = 'hold'`, next, hold.id);
    return one<HoldRow>(ctx.db, `SELECT * FROM holds WHERE id = ?`, hold.id)!;
  });
  ctx.bus.publish(updated.departure_id);
  return holdView(ctx, updated);
}

export function releaseHold(ctx: Ctx, input: { holdId: string; sessionId: string }): void {
  const departureId = tx(ctx.db, () => {
    const hold = getHoldFor(ctx, input.holdId, input.sessionId);
    if (hold.status === 'converted') {
      const paid = one<{ id: string }>(
        ctx.db,
        `SELECT id FROM bookings WHERE hold_id = ? AND status = 'confirmed'`,
        hold.id,
      );
      if (paid) throw conflict('already_booked', 'This booking is confirmed. Cancel the booking instead.');
    }
    if (hold.status !== 'active') return hold.departure_id; // already gone: releasing twice is fine
    run(ctx.db, `UPDATE holds SET status = 'released' WHERE id = ?`, hold.id);
    run(ctx.db, `DELETE FROM seat_claims WHERE hold_id = ? AND kind = 'hold'`, hold.id);
    run(
      ctx.db,
      `UPDATE bookings SET status = 'cancelled', cancelled_at = ? WHERE hold_id = ? AND status = 'pending_payment'`,
      ctx.clock.now(),
      hold.id,
    );
    return hold.departure_id;
  });
  ctx.bus.publish(departureId);
}

/** Seat states as one customer sees them. Overdue holds count as available without needing a write. */
export function seatStates(ctx: Ctx, departureId: string, sessionId: string | null) {
  const now = ctx.clock.now();
  const seats = all<{ seat_id: string; kind: string | null; hold_session: string | null }>(
    ctx.db,
    `SELECT ds.seat_id, sc.kind AS kind, h.session_id AS hold_session
       FROM departure_seats ds
  LEFT JOIN seat_claims sc ON sc.departure_id = ds.departure_id AND sc.seat_id = ds.seat_id
        AND (sc.kind = 'booked' OR sc.expires_at > ?)
  LEFT JOIN holds h ON h.id = sc.hold_id
      WHERE ds.departure_id = ?`,
    now,
    departureId,
  );
  const states: Record<string, SeatState> = {};
  for (const s of seats) {
    if (s.kind === 'booked') states[s.seat_id] = 'sold';
    else if (s.kind === 'hold')
      states[s.seat_id] = sessionId && s.hold_session === sessionId ? 'mine' : 'held';
    else states[s.seat_id] = 'available';
  }
  const mine = sessionId
    ? one<HoldRow>(
        ctx.db,
        `SELECT * FROM holds WHERE departure_id = ? AND session_id = ? AND status = 'active' AND expires_at > ?`,
        departureId,
        sessionId,
        now,
      )
    : undefined;
  return { version: ctx.bus.version(departureId), states, hold: mine ? holdView(ctx, mine) : null };
}

export function startSweeper(ctx: Ctx, intervalMs = 5000): () => void {
  const timer = setInterval(() => {
    try {
      expireDueHolds(ctx);
    } catch (err) {
      console.error('sweeper failed', err);
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
