import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { confirmFromPayment, createRefund, type BookingRow, type PaymentRow } from './bookings.ts';
import type { Ctx } from './context.ts';
import { one, run, tx } from './db.ts';
import { AppError } from './errors.ts';
import { signCallback } from './payments/mockMpesa.ts';

const CallbackSchema = z.object({
  Body: z.object({
    stkCallback: z.object({
      MerchantRequestID: z.string(),
      CheckoutRequestID: z.string().min(1).max(100),
      ResultCode: z.number().int(),
      ResultDesc: z.string().max(300),
      CallbackMetadata: z
        .object({
          Item: z.array(z.object({ Name: z.string(), Value: z.union([z.string(), z.number()]).optional() })),
        })
        .optional(),
    }),
  }),
});

export type CallbackOutcome =
  'confirmed' | 'failed' | 'duplicate' | 'refund_needed' | 'amount_mismatch' | 'ignored';

export const SIGNATURE_HEADER = 'x-tiketi-signature';

export function verifySignature(secret: string, rawBody: string, header: string | null | undefined): boolean {
  if (!header) return false;
  const expected = Buffer.from(signCallback(secret, rawBody));
  const got = Buffer.from(header);
  return expected.length === got.length && timingSafeEqual(expected, got);
}

const FAILURE_STATUS: Record<number, string> = {
  1032: 'cancelled',
  1037: 'timeout',
  1: 'insufficient_funds',
};
const FAILED_STATES = new Set(['failed', 'cancelled', 'timeout', 'insufficient_funds']);

/**
 * The only place a payment result enters the system. In order: verify the HMAC over the raw body,
 * validate the shape, de-duplicate, then apply the result in one transaction.
 *
 * - Success + hold still valid  -> booking confirmed, tickets issued.
 * - Success + hold gone/expired -> payment marked refund_needed and a refund record is created
 *   (the money is never silently kept and the seat is never double-sold).
 * - Success with the wrong amount -> not confirmed; refund record for what was actually paid.
 * - Same callback delivered again -> no-op. A second, different success -> refund record.
 */
export function handleMpesaCallback(ctx: Ctx, rawBody: string, signature: string | null | undefined) {
  if (!verifySignature(ctx.config.callbackSecret, rawBody, signature)) {
    throw new AppError(401, 'bad_signature', 'Callback signature is invalid');
  }
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    throw new AppError(400, 'bad_payload', 'Callback body is not JSON');
  }
  const parsed = CallbackSchema.safeParse(json);
  if (!parsed.success) throw new AppError(400, 'bad_payload', 'Callback body has the wrong shape');
  const cb = parsed.data.Body.stkCallback;
  const meta = new Map((cb.CallbackMetadata?.Item ?? []).map((i) => [i.Name, i.Value]));
  const receipt = meta.has('MpesaReceiptNumber') ? String(meta.get('MpesaReceiptNumber')) : null;
  const paidAmount = meta.has('Amount') ? Number(meta.get('Amount')) : null;
  const ref = cb.CheckoutRequestID;

  const result = tx(ctx.db, () => {
    const payment = one<PaymentRow>(ctx.db, `SELECT * FROM payments WHERE provider_ref = ?`, ref);
    if (!payment) throw new AppError(404, 'unknown_payment', 'No payment with that reference');
    const booking = one<BookingRow>(ctx.db, `SELECT * FROM bookings WHERE id = ?`, payment.booking_id)!;
    const now = ctx.clock.now();

    const dedupeKey = createHash('sha256')
      .update(`${ref}|${cb.ResultCode}|${receipt ?? ''}`)
      .digest('hex');
    const fresh = run(
      ctx.db,
      `INSERT INTO payment_callbacks (dedupe_key, provider_ref, outcome, received_at) VALUES (?, ?, 'received', ?) ON CONFLICT DO NOTHING`,
      dedupeKey,
      ref,
      now,
    );
    if (fresh === 0) return { outcome: 'duplicate' as CallbackOutcome, booking };

    const finish = (outcome: CallbackOutcome, status: string, extra: Partial<PaymentRow> = {}) => {
      run(
        ctx.db,
        `UPDATE payments SET status = ?, result_code = ?, result_desc = ?, receipt = COALESCE(?, receipt),
                paid_amount_kes = COALESCE(?, paid_amount_kes), updated_at = ? WHERE id = ?`,
        status,
        cb.ResultCode,
        cb.ResultDesc,
        extra.receipt ?? receipt,
        paidAmount,
        now,
        payment.id,
      );
      run(ctx.db, `UPDATE payment_callbacks SET outcome = ? WHERE dedupe_key = ?`, outcome, dedupeKey);
      return { outcome, booking };
    };

    if (cb.ResultCode !== 0) {
      // A failure never overrides a success we already recorded.
      if (!(payment.status === 'pending' || FAILED_STATES.has(payment.status))) {
        run(ctx.db, `UPDATE payment_callbacks SET outcome = 'ignored' WHERE dedupe_key = ?`, dedupeKey);
        return { outcome: 'ignored' as CallbackOutcome, booking };
      }
      return finish('failed', FAILURE_STATUS[cb.ResultCode] ?? 'failed');
    }

    if (paidAmount === null || receipt === null) {
      throw new AppError(400, 'bad_payload', 'Success callback is missing the amount or receipt');
    }

    // Money really arrived. From here every path ends in either a confirmed booking or a refund record.
    const alreadySettled = ['succeeded', 'refund_needed', 'amount_mismatch'].includes(payment.status);
    if (alreadySettled) {
      createRefund(ctx, {
        paymentId: payment.id,
        bookingId: booking.id,
        amountKes: paidAmount,
        reason: 'duplicate_payment',
      });
      run(ctx.db, `UPDATE payment_callbacks SET outcome = 'refund_needed' WHERE dedupe_key = ?`, dedupeKey);
      return { outcome: 'refund_needed' as CallbackOutcome, booking };
    }
    if (paidAmount !== payment.amount_kes) {
      createRefund(ctx, {
        paymentId: payment.id,
        bookingId: booking.id,
        amountKes: paidAmount,
        reason: 'wrong_amount',
      });
      return finish('amount_mismatch', 'amount_mismatch');
    }
    const refundReason = confirmFromPayment(ctx, booking);
    if (refundReason) {
      createRefund(ctx, {
        paymentId: payment.id,
        bookingId: booking.id,
        amountKes: paidAmount,
        reason: refundReason,
      });
      return finish('refund_needed', 'refund_needed');
    }
    return finish('confirmed', 'succeeded');
  });

  ctx.bus.publish(result.booking.departure_id);
  return { outcome: result.outcome, bookingId: result.booking.id };
}
