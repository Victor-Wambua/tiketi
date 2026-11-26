import type { Ctx } from './context.ts';
import { all, one, run, tx } from './db.ts';
import { parseCode } from '../shared/ticketCode.ts';
import type { TicketRow } from './tickets.ts';

export type ScanVerdict =
  'admitted' | 'duplicate' | 'invalid' | 'unknown_ticket' | 'stale_version' | 'void' | 'wrong_departure';

export interface ScanResult {
  result: ScanVerdict;
  message: string;
  scanId: number;
  ticket: { id: string; seatLabel: string; holderName: string; departureId: string } | null;
  firstScan: { at: number; gate: string } | null;
  /** True when an offline scan collided with another admission of the same ticket. */
  conflict: boolean;
}

export interface ScanInput {
  code: string;
  gate: string;
  staffId: string | null;
  departureId?: string | undefined;
  clientScanId?: string | undefined;
  clientScannedAt?: number | undefined;
  offline?: boolean | undefined;
}

const clockFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Africa/Nairobi',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
export const clockTime = (ms: number): string => clockFmt.format(new Date(ms));

/** A scan can only claim to have happened in the past, and never before the ticket existed. */
function effectiveTime(received: number, claimed: number | undefined, issuedAt: number): number {
  if (claimed === undefined || !Number.isFinite(claimed)) return received;
  return Math.max(issuedAt, Math.min(claimed, received));
}

/**
 * Admits a ticket at a gate. Verification happens again here even if the scanner already did it
 * offline; the server is the authority. The decisive step is one compare-and-set UPDATE
 * (`WHERE admitted_at IS NULL`) inside a write transaction, so two gates scanning the same ticket
 * at the same instant get exactly one `admitted`.
 */
export function processScan(ctx: Ctx, input: ScanInput): ScanResult {
  const received = ctx.clock.now();
  const offline = input.offline ? 1 : 0;
  const result = tx(ctx.db, () => {
    if (input.clientScanId) {
      const prev = one<{ detail: string | null }>(
        ctx.db,
        `SELECT detail FROM scans WHERE client_scan_id = ?`,
        input.clientScanId,
      );
      if (prev?.detail) return JSON.parse(prev.detail) as ScanResult;
    }

    const record = (
      r: Omit<ScanResult, 'scanId'>,
      ticket: TicketRow | null,
      priorScanId: number | null = null,
    ) => {
      const id = Number(
        ctx.db
          .prepare(
            `INSERT INTO scans (ticket_id, departure_id, gate, staff_id, result, detail, client_scan_id, client_scanned_at, received_at, offline, prior_scan_id)
             VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
          )
          .run(
            ticket?.id ?? null,
            ticket?.departure_id ?? null,
            input.gate,
            input.staffId,
            r.result,
            input.clientScanId ?? null,
            input.clientScannedAt ?? null,
            received,
            offline,
            priorScanId,
          ).lastInsertRowid,
      );
      const full: ScanResult = { ...r, scanId: id };
      run(ctx.db, `UPDATE scans SET detail = ? WHERE id = ?`, JSON.stringify(full), id);
      return full;
    };
    const reject = (
      verdict: ScanVerdict,
      message: string,
      ticket: TicketRow | null = null,
      firstScan: ScanResult['firstScan'] = null,
    ) =>
      record(
        {
          result: verdict,
          message,
          ticket: ticket ? ticketSummary(ctx, ticket) : null,
          firstScan,
          conflict: false,
        },
        ticket,
      );

    const claims = ctx.keys.verifyCode(input.code);
    if (!claims) {
      return reject(
        'invalid',
        parseCode(input.code)
          ? 'Fake or altered ticket: the signature does not match.'
          : 'This is not a Tiketi ticket code.',
      );
    }
    const ticket = one<TicketRow>(ctx.db, `SELECT * FROM tickets WHERE id = ?`, claims.ticketId);
    if (!ticket)
      return reject('unknown_ticket', 'Signature is genuine, but this ticket is not in the system.');
    if (input.departureId && ticket.departure_id !== input.departureId) {
      return reject('wrong_departure', 'This ticket is for a different event or departure.', ticket);
    }
    if (
      claims.version !== ticket.version ||
      claims.seatId !== ticket.seat_id ||
      claims.departureId !== ticket.departure_id
    ) {
      return reject(
        'stale_version',
        'This QR code is out of date: the ticket was transferred or cancelled.',
        ticket,
      );
    }
    if (ticket.status !== 'valid') return reject('void', 'This ticket was cancelled or refunded.', ticket);

    const admittedAt = effectiveTime(received, input.clientScannedAt, ticket.issued_at);
    const scanId = Number(
      ctx.db
        .prepare(
          `INSERT INTO scans (ticket_id, departure_id, gate, staff_id, result, client_scan_id, client_scanned_at, received_at, offline)
           VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
        )
        .run(
          ticket.id,
          ticket.departure_id,
          input.gate,
          input.staffId,
          input.clientScanId ?? null,
          input.clientScannedAt ?? null,
          received,
          offline,
        ).lastInsertRowid,
    );
    const won = run(
      ctx.db,
      `UPDATE tickets SET admitted_at = ?, admitted_gate = ?, admitted_scan_id = ?
        WHERE id = ? AND admitted_at IS NULL AND status = 'valid' AND version = ?`,
      admittedAt,
      input.gate,
      scanId,
      ticket.id,
      ticket.version,
    );
    const finish = (r: Omit<ScanResult, 'scanId'>, dbResult: string, prior: number | null) => {
      const full: ScanResult = { ...r, scanId };
      run(
        ctx.db,
        `UPDATE scans SET result = ?, detail = ?, prior_scan_id = ?, conflict = ? WHERE id = ?`,
        dbResult,
        JSON.stringify(full),
        prior,
        r.conflict ? 1 : 0,
        scanId,
      );
      return full;
    };
    const summary = ticketSummary(ctx, ticket);

    if (won === 1) {
      return finish(
        {
          result: 'admitted',
          message: `Admitted: seat ${summary.seatLabel}, ${summary.holderName}.`,
          ticket: summary,
          firstScan: null,
          conflict: false,
        },
        'admitted',
        null,
      );
    }

    // Someone got there first. Report who, when and where.
    const current = one<TicketRow>(ctx.db, `SELECT * FROM tickets WHERE id = ?`, ticket.id)!;
    const first = one<{ id: number; client_scanned_at: number | null; received_at: number; offline: number }>(
      ctx.db,
      `SELECT id, client_scanned_at, received_at, offline FROM scans WHERE id = ?`,
      current.admitted_scan_id ?? -1,
    );
    const firstAt = current.admitted_at ?? received;
    const firstGate = current.admitted_gate ?? 'another gate';

    // Offline reconciliation: when this scan claims an earlier entry time than the recorded one,
    // it becomes the first entry and the previously recorded one becomes the duplicate. Either way
    // an offline collision is flagged as a conflict for the organiser to review.
    if (offline && first && admittedAt < firstAt) {
      run(
        ctx.db,
        `UPDATE tickets SET admitted_at = ?, admitted_gate = ?, admitted_scan_id = ? WHERE id = ?`,
        admittedAt,
        input.gate,
        scanId,
        ticket.id,
      );
      run(
        ctx.db,
        `UPDATE scans SET result = 'duplicate', prior_scan_id = ?, conflict = 1 WHERE id = ?`,
        scanId,
        first.id,
      );
      return finish(
        {
          result: 'admitted',
          message: `Admitted at ${clockTime(admittedAt)}. Conflict: this ticket was also scanned at ${firstGate} at ${clockTime(firstAt)}.`,
          ticket: summary,
          firstScan: { at: firstAt, gate: firstGate },
          conflict: true,
        },
        'admitted',
        first.id,
      );
    }
    return finish(
      {
        result: 'duplicate',
        message: `Already scanned at ${clockTime(firstAt)} at ${firstGate}.`,
        ticket: summary,
        firstScan: { at: firstAt, gate: firstGate },
        conflict: Boolean(offline),
      },
      'duplicate',
      first?.id ?? null,
    );
  });
  if (result.ticket) ctx.bus.publish(result.ticket.departureId);
  return result;
}

function ticketSummary(ctx: Ctx, t: TicketRow) {
  const seat = one<{ label: string }>(
    ctx.db,
    `SELECT label FROM departure_seats WHERE departure_id = ? AND seat_id = ?`,
    t.departure_id,
    t.seat_id,
  );
  return {
    id: t.id,
    seatLabel: seat?.label ?? t.seat_id,
    holderName: t.holder_name,
    departureId: t.departure_id,
  };
}

/** Offline scanners cache this: every ticket for a departure with its current version and status. */
export function gateManifest(ctx: Ctx, departureId: string) {
  const rows = all<TicketRow & { label: string }>(
    ctx.db,
    `SELECT t.*, ds.label FROM tickets t JOIN departure_seats ds ON ds.departure_id = t.departure_id AND ds.seat_id = t.seat_id
      WHERE t.departure_id = ? ORDER BY t.rowid`,
    departureId,
  );
  return {
    departureId,
    generatedAt: ctx.clock.now(),
    tickets: rows.map((t) => ({
      id: t.id,
      seatId: t.seat_id,
      seatLabel: t.label,
      holderName: t.holder_name,
      version: t.version,
      status: t.status,
      admittedAt: t.admitted_at,
      admittedGate: t.admitted_gate,
    })),
  };
}

export function gateDepartures(ctx: Ctx) {
  const since = ctx.clock.now() - 24 * 3600_000;
  return all<{ id: string; starts_at: number; title: string; venue: string }>(
    ctx.db,
    `SELECT d.id, d.starts_at, e.title, e.venue FROM departures d JOIN events e ON e.id = d.event_id
      WHERE d.starts_at > ? AND d.status = 'scheduled' ORDER BY d.starts_at`,
    since,
  ).map((d) => ({ id: d.id, startsAt: d.starts_at, title: d.title, venue: d.venue }));
}
