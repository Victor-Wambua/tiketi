import type { Ctx } from './context.ts';
import { all, one, run, tx } from './db.ts';
import { AppError, badRequest, conflict, notFound } from './errors.ts';
import { newId } from './ids.ts';
import { getHoldFor, releaseHold, type HoldRow } from './inventory.ts';
import { issueTickets, ticketLink, type TicketRow } from './tickets.ts';

export interface BookingRow {
  id: string;
  hold_id: string;
  departure_id: string;
  session_id: string;
  status: 'pending_payment' | 'confirmed' | 'cancelled' | 'expired';
  customer_name: string;
  phone: string;
  total_kes: number;
  created_at: number;
  confirmed_at: number | null;
  cancelled_at: number | null;
}

export interface PaymentRow {
  id: string;
  booking_id: string;
  provider: string;
  provider_ref: string | null;
  amount_kes: number;
  phone: string;
  status: string;
  result_code: number | null;
  result_desc: string | null;
  receipt: string | null;
  paid_amount_kes: number | null;
  created_at: number;
  updated_at: number;
}

export interface RefundRow {
  id: string;
  payment_id: string;
  booking_id: string;
  amount_kes: number;
  reason: string;
  status: 'needed' | 'processed';
  created_at: number;
  processed_at: number | null;
  processed_by: string | null;
  refund_ref: string | null;
}

/** Kenyan mobile numbers in any common spelling -> 2547XXXXXXXX / 2541XXXXXXXX, or null. */
export function normalisePhone(raw: string): string | null {
  const digits = raw.replace(/[\s()-]/g, '').replace(/^\+/, '');
  const m = /^(?:254|0)?([17]\d{8})$/.exec(digits);
  return m ? `254${m[1]}` : null;
}

export function createRefund(
  ctx: Ctx,
  r: { paymentId: string; bookingId: string; amountKes: number; reason: string },
): string {
  const id = newId('rfd');
  run(
    ctx.db,
    `INSERT INTO refunds (id, payment_id, booking_id, amount_kes, reason, status, created_at) VALUES (?, ?, ?, ?, ?, 'needed', ?)`,
    id,
    r.paymentId,
    r.bookingId,
    r.amountKes,
    r.reason,
    ctx.clock.now(),
  );
  return id;
}

/**
 * Turns a pending booking into a confirmed one. Only ever called from the verified payment
 * callback, inside its transaction. The booking can be confirmed only from a hold that is still
 * active, unexpired, owned by the booking's own session, and whose seat claims are all still ours.
 * Returns null on success, or the reason the money has to be refunded instead.
 */
export function confirmFromPayment(ctx: Ctx, booking: BookingRow): string | null {
  const now = ctx.clock.now();
  if (booking.status === 'expired') return 'late_payment';
  if (booking.status !== 'pending_payment') return 'booking_cancelled';
  const hold = one<HoldRow>(ctx.db, `SELECT * FROM holds WHERE id = ?`, booking.hold_id)!;
  if (hold.status !== 'active' || hold.expires_at <= now) return 'late_payment';
  if (hold.session_id !== booking.session_id) return 'seat_unavailable';
  const seatCount = one<{ n: number }>(
    ctx.db,
    `SELECT COUNT(*) AS n FROM hold_seats WHERE hold_id = ?`,
    hold.id,
  )!.n;
  const claimed = run(
    ctx.db,
    `UPDATE seat_claims SET kind = 'booked', expires_at = NULL
      WHERE hold_id = ? AND kind = 'hold' AND expires_at > ?`,
    hold.id,
    now,
  );
  if (claimed !== seatCount) throw new Error('invariant: active hold lost seat claims');
  run(ctx.db, `UPDATE holds SET status = 'converted' WHERE id = ?`, hold.id);
  run(ctx.db, `UPDATE bookings SET status = 'confirmed', confirmed_at = ? WHERE id = ?`, now, booking.id);
  issueTickets(ctx, booking);
  return null;
}

export async function checkout(
  ctx: Ctx,
  input: { holdId: string; sessionId: string; name: string; phone: string },
): Promise<BookingView> {
  const name = input.name.trim();
  if (name.length < 2 || name.length > 80) throw badRequest('invalid_name', 'Enter your name');
  const phone = normalisePhone(input.phone);
  if (!phone) throw badRequest('invalid_phone', 'Enter a Kenyan mobile number, e.g. 0700 000 001');

  const { booking, payment } = tx(ctx.db, () => {
    const hold = getHoldFor(ctx, input.holdId, input.sessionId);
    const now = ctx.clock.now();
    let booking = one<BookingRow>(ctx.db, `SELECT * FROM bookings WHERE hold_id = ?`, hold.id);
    if (booking?.status === 'confirmed') throw conflict('already_paid', 'This booking is already paid');
    if (hold.status !== 'active' || hold.expires_at <= now) {
      throw conflict('hold_expired', 'This hold has expired. Please choose your seats again.');
    }
    if (booking) {
      const inFlight = one<{ id: string }>(
        ctx.db,
        `SELECT id FROM payments WHERE booking_id = ? AND status IN ('initiating','pending')`,
        booking.id,
      );
      if (inFlight) throw conflict('payment_in_progress', 'A payment prompt is already on your phone');
      run(ctx.db, `UPDATE bookings SET customer_name = ?, phone = ? WHERE id = ?`, name, phone, booking.id);
    } else {
      const id = newId('bkg');
      run(
        ctx.db,
        `INSERT INTO bookings (id, hold_id, departure_id, session_id, status, customer_name, phone, total_kes, created_at)
         VALUES (?, ?, ?, ?, 'pending_payment', ?, ?, ?, ?)`,
        id,
        hold.id,
        hold.departure_id,
        input.sessionId,
        name,
        phone,
        hold.total_kes,
        now,
      );
      booking = one<BookingRow>(ctx.db, `SELECT * FROM bookings WHERE id = ?`, id)!;
    }
    // Keep the seats while the phone prompt is out, so a prompt that is answered on time can confirm.
    const keepUntil = now + ctx.config.paymentGraceMs;
    if (hold.expires_at < keepUntil) {
      run(ctx.db, `UPDATE holds SET expires_at = ? WHERE id = ?`, keepUntil, hold.id);
      run(
        ctx.db,
        `UPDATE seat_claims SET expires_at = ? WHERE hold_id = ? AND kind = 'hold'`,
        keepUntil,
        hold.id,
      );
    }
    const paymentId = newId('pay');
    run(
      ctx.db,
      `INSERT INTO payments (id, booking_id, provider, amount_kes, phone, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'initiating', ?, ?)`,
      paymentId,
      booking.id,
      ctx.payments.name,
      booking.total_kes,
      phone,
      now,
      now,
    );
    return { booking, payment: one<PaymentRow>(ctx.db, `SELECT * FROM payments WHERE id = ?`, paymentId)! };
  });

  try {
    const { providerRef } = await ctx.payments.initiateStk({
      paymentId: payment.id,
      phone,
      amountKes: booking.total_kes,
      accountRef: booking.id,
      description: 'Tiketi seats',
    });
    run(
      ctx.db,
      `UPDATE payments SET provider_ref = ?, status = 'pending', updated_at = ? WHERE id = ? AND status = 'initiating'`,
      providerRef,
      ctx.clock.now(),
      payment.id,
    );
  } catch {
    run(
      ctx.db,
      `UPDATE payments SET status = 'failed', result_desc = 'provider_error', updated_at = ? WHERE id = ?`,
      ctx.clock.now(),
      payment.id,
    );
    throw new AppError(502, 'payment_provider_error', 'Could not send the payment prompt. Please try again.');
  }
  ctx.bus.publish(booking.departure_id);
  return bookingView(ctx, one<BookingRow>(ctx.db, `SELECT * FROM bookings WHERE id = ?`, booking.id)!);
}

export interface BookingView {
  id: string;
  status: BookingRow['status'];
  departureId: string;
  customerName: string;
  phone: string;
  totalKes: number;
  holdId: string;
  holdExpiresAt: number | null;
  payment: {
    status: string;
    resultDesc: string | null;
    receipt: string | null;
    providerRef: string | null;
  } | null;
  tickets: {
    id: string;
    seatId: string;
    seatLabel: string;
    holderName: string;
    status: string;
    link: string;
  }[];
  refund: { status: string; amountKes: number; reason: string } | null;
  token: string;
}

export function bookingView(ctx: Ctx, b: BookingRow): BookingView {
  const payment = one<PaymentRow>(
    ctx.db,
    `SELECT * FROM payments WHERE booking_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    b.id,
  );
  const refund = one<RefundRow>(
    ctx.db,
    `SELECT * FROM refunds WHERE booking_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    b.id,
  );
  const hold = one<HoldRow>(ctx.db, `SELECT * FROM holds WHERE id = ?`, b.hold_id);
  const tickets = all<TicketRow & { label: string }>(
    ctx.db,
    `SELECT t.*, ds.label FROM tickets t JOIN departure_seats ds ON ds.departure_id = t.departure_id AND ds.seat_id = t.seat_id
      WHERE t.booking_id = ? ORDER BY t.rowid`,
    b.id,
  );
  return {
    id: b.id,
    status: b.status,
    departureId: b.departure_id,
    customerName: b.customer_name,
    phone: b.phone,
    totalKes: b.total_kes,
    holdId: b.hold_id,
    holdExpiresAt: hold && hold.status === 'active' ? hold.expires_at : null,
    payment: payment
      ? {
          status: payment.status,
          resultDesc: payment.result_desc,
          receipt: payment.receipt,
          providerRef: payment.provider_ref,
        }
      : null,
    tickets: tickets.map((t) => ({
      id: t.id,
      seatId: t.seat_id,
      seatLabel: t.label,
      holderName: t.holder_name,
      status: t.status === 'void' ? 'void' : t.admitted_at ? 'used' : 'valid',
      link: ticketLink(ctx, t),
    })),
    refund: refund ? { status: refund.status, amountKes: refund.amount_kes, reason: refund.reason } : null,
    token: ctx.keys.viewToken('booking', b.id),
  };
}

export function getBookingFor(
  ctx: Ctx,
  id: string,
  auth: { sessionId?: string | null; token?: string | null },
): BookingRow {
  const b = one<BookingRow>(ctx.db, `SELECT * FROM bookings WHERE id = ?`, id);
  if (!b) throw notFound('Booking not found');
  const byToken = auth.token ? auth.token === ctx.keys.viewToken('booking', b.id) : false;
  if (!byToken && b.session_id !== auth.sessionId) throw notFound('Booking not found');
  return b;
}

/**
 * Customer cancellation. Unpaid: releases the seats. Paid: voids the tickets, releases the seats and
 * records a refund (processed straight away through the payment port).
 */
export async function cancelBooking(
  ctx: Ctx,
  input: { bookingId: string; sessionId: string },
): Promise<BookingView> {
  const outcome = tx(ctx.db, () => {
    const b = getBookingFor(ctx, input.bookingId, { sessionId: input.sessionId });
    const now = ctx.clock.now();
    if (b.status === 'cancelled') return { b, refundId: null };
    if (b.status === 'expired') throw conflict('booking_expired', 'This booking has already expired');
    if (b.status === 'pending_payment') return { b, refundId: null, pending: true };
    const dep = one<{ starts_at: number }>(
      ctx.db,
      `SELECT starts_at FROM departures WHERE id = ?`,
      b.departure_id,
    )!;
    if (dep.starts_at <= now) throw conflict('departure_started', 'This departure has already started');
    const used = one<{ n: number }>(
      ctx.db,
      `SELECT COUNT(*) AS n FROM tickets WHERE booking_id = ? AND admitted_at IS NOT NULL`,
      b.id,
    )!.n;
    if (used > 0) throw conflict('ticket_used', 'A ticket on this booking has already been used');
    run(
      ctx.db,
      `UPDATE tickets SET status = 'void', void_reason = 'cancelled', void_at = ?, version = version + 1 WHERE booking_id = ? AND status = 'valid'`,
      now,
      b.id,
    );
    run(ctx.db, `DELETE FROM seat_claims WHERE hold_id = ? AND kind = 'booked'`, b.hold_id);
    run(ctx.db, `UPDATE bookings SET status = 'cancelled', cancelled_at = ? WHERE id = ?`, now, b.id);
    const payment = one<PaymentRow>(
      ctx.db,
      `SELECT * FROM payments WHERE booking_id = ? AND status = 'succeeded'`,
      b.id,
    );
    const refundId = payment
      ? createRefund(ctx, {
          paymentId: payment.id,
          bookingId: b.id,
          amountKes: payment.amount_kes,
          reason: 'customer_cancelled',
        })
      : null;
    return { b, refundId };
  });
  if ('pending' in outcome && outcome.pending) {
    releaseHold(ctx, { holdId: outcome.b.hold_id, sessionId: input.sessionId });
  } else {
    ctx.bus.publish(outcome.b.departure_id);
  }
  if (outcome.refundId) await processRefund(ctx, outcome.refundId, 'system');
  return bookingView(ctx, one<BookingRow>(ctx.db, `SELECT * FROM bookings WHERE id = ?`, outcome.b.id)!);
}

/** Pays a refund-needed record out through the payment port. Safe to call twice. */
export async function processRefund(ctx: Ctx, refundId: string, actor: string): Promise<RefundRow> {
  const refund = one<RefundRow>(ctx.db, `SELECT * FROM refunds WHERE id = ?`, refundId);
  if (!refund) throw notFound('Refund not found');
  if (refund.status === 'processed') return refund;
  const payment = one<PaymentRow>(ctx.db, `SELECT * FROM payments WHERE id = ?`, refund.payment_id)!;
  const { refundRef } = await ctx.payments.refund({
    providerRef: payment.provider_ref ?? payment.id,
    amountKes: refund.amount_kes,
    reason: refund.reason,
    idempotencyKey: refund.id,
  });
  run(
    ctx.db,
    `UPDATE refunds SET status = 'processed', processed_at = ?, processed_by = ?, refund_ref = ? WHERE id = ? AND status = 'needed'`,
    ctx.clock.now(),
    actor,
    refundRef,
    refund.id,
  );
  return one<RefundRow>(ctx.db, `SELECT * FROM refunds WHERE id = ?`, refund.id)!;
}
