import { verifyCode } from '../../shared/ticketCode.ts';
import { NetworkError } from '../api.ts';

/** Minimal key-value store (localStorage in the browser, a Map in tests). */
export interface KV {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export interface ServerScan {
  result:
    'admitted' | 'duplicate' | 'invalid' | 'unknown_ticket' | 'stale_version' | 'void' | 'wrong_departure';
  message: string;
  scanId: number;
  ticket: { id: string; seatLabel: string; holderName: string; departureId: string } | null;
  firstScan: { at: number; gate: string } | null;
  conflict: boolean;
}

export interface ScanRequest {
  code: string;
  gate: string;
  departureId: string;
  clientScanId: string;
  scannedAt: number;
}

export interface Manifest {
  departureId: string;
  generatedAt: number;
  tickets: {
    id: string;
    seatLabel: string;
    holderName: string;
    version: number;
    status: 'valid' | 'void';
    admittedAt: number | null;
    admittedGate: string | null;
  }[];
}

export interface GateApi {
  scan(req: ScanRequest): Promise<ServerScan>;
  batch(reqs: ScanRequest[]): Promise<{ clientScanId: string | null; scan: ServerScan }[]>;
  manifest(departureId: string): Promise<Manifest>;
}

export interface Verdict {
  kind: 'admitted' | 'duplicate' | 'rejected';
  reason: string;
  message: string;
  seat?: string;
  holder?: string;
  /** Decided by the server, or by this device alone (offline). */
  source: 'server' | 'offline';
  at: number;
}

interface Stored {
  manifest: Manifest | null;
  /** The local one-time-use cache: tickets this device has already admitted. */
  admitted: Record<string, { at: number; gate: string; seat: string }>;
  queue: ScanRequest[];
  log: Verdict[];
}

export interface EngineDeps {
  storage: KV;
  api: GateApi;
  publicKey: () => string | null;
  now: () => number;
  newId: () => string;
  /** Forces offline behaviour (the "work offline" switch, or navigator.onLine === false). */
  isOffline: () => boolean;
  clockTime: (ms: number) => string;
}

/**
 * The gate scanner's brain, free of DOM so it can be tested. Order of checks for every code:
 *   1. Ed25519 signature, offline, against the cached public key.
 *   2. Right departure.
 *   3. This device's own one-time-use cache.
 *   4. If online: ask the server (the authority) and remember its answer.
 *      If the network fails or we are offline: decide from the cached ticket list, admit, and queue
 *      the scan for reconciliation.
 */
export class ScanEngine {
  private data: Stored;

  constructor(
    private readonly d: EngineDeps,
    readonly opts: { gate: string; departureId: string },
  ) {
    this.data = this.read();
  }

  private get key() {
    return `tiketi.gate.${this.opts.departureId}`;
  }
  private read(): Stored {
    try {
      const raw = this.d.storage.get(this.key);
      if (raw) return JSON.parse(raw) as Stored;
    } catch {
      /* corrupt storage: start clean */
    }
    return { manifest: null, admitted: {}, queue: [], log: [] };
  }
  private save() {
    this.d.storage.set(this.key, JSON.stringify(this.data));
  }

  get queueLength() {
    return this.data.queue.length;
  }
  get log() {
    return this.data.log;
  }
  get manifestAge(): number | null {
    return this.data.manifest ? this.d.now() - this.data.manifest.generatedAt : null;
  }
  get manifestSize(): number {
    return this.data.manifest?.tickets.length ?? 0;
  }

  async refreshManifest(): Promise<boolean> {
    try {
      this.data.manifest = await this.d.api.manifest(this.opts.departureId);
      this.save();
      return true;
    } catch (e) {
      if (e instanceof NetworkError) return false;
      throw e;
    }
  }

  private finish(v: Omit<Verdict, 'at'>): Verdict {
    const verdict: Verdict = { ...v, at: this.d.now() };
    this.data.log = [verdict, ...this.data.log].slice(0, 30);
    this.save();
    return verdict;
  }

  async handle(rawCode: string): Promise<Verdict> {
    const code = rawCode.trim();
    const key = this.d.publicKey();
    if (!key) {
      return this.finish({
        kind: 'rejected',
        reason: 'no_key',
        message: 'Cannot verify yet: the signing key has not been loaded. Connect once, then retry.',
        source: 'offline',
      });
    }
    const claims = verifyCode(code, key);
    if (!claims) {
      return this.finish({
        kind: 'rejected',
        reason: 'invalid',
        message: 'Fake or altered ticket: the signature does not match.',
        source: 'offline',
      });
    }
    if (claims.departureId !== this.opts.departureId) {
      return this.finish({
        kind: 'rejected',
        reason: 'wrong_departure',
        message: 'This ticket is for a different event or departure.',
        seat: claims.seatId,
        source: 'offline',
      });
    }
    const local = this.data.admitted[claims.ticketId];
    if (local) {
      return this.finish({
        kind: 'duplicate',
        reason: 'duplicate_local',
        message: `Already scanned at ${this.d.clockTime(local.at)} at ${local.gate}.`,
        seat: local.seat,
        source: 'offline',
      });
    }

    if (!this.d.isOffline()) {
      try {
        const req: ScanRequest = {
          code,
          gate: this.opts.gate,
          departureId: this.opts.departureId,
          clientScanId: this.d.newId(),
          scannedAt: this.d.now(),
        };
        const r = await this.d.api.scan(req);
        return this.fromServer(r);
      } catch (e) {
        if (!(e instanceof NetworkError)) throw e;
        // fall through: the connection dropped, so decide locally
      }
    }
    return this.decideOffline(code, claims);
  }

  private fromServer(r: ServerScan): Verdict {
    const t = r.ticket;
    if (r.result === 'admitted' || r.result === 'duplicate') {
      if (t) {
        const at = r.firstScan?.at ?? this.d.now();
        const gate = r.firstScan?.gate ?? this.opts.gate;
        this.data.admitted[t.id] = { at, gate, seat: t.seatLabel };
      }
    }
    return this.finish({
      kind: r.result === 'admitted' ? 'admitted' : r.result === 'duplicate' ? 'duplicate' : 'rejected',
      reason: r.result,
      message: r.message,
      ...(t ? { seat: t.seatLabel, holder: t.holderName } : {}),
      source: 'server',
    });
  }

  private decideOffline(
    code: string,
    claims: { ticketId: string; version: number; seatId: string },
  ): Verdict {
    const m = this.data.manifest;
    if (!m) {
      return this.finish({
        kind: 'rejected',
        reason: 'no_list',
        message: 'Offline and no ticket list downloaded for this departure. Connect once to download it.',
        seat: claims.seatId,
        source: 'offline',
      });
    }
    const entry = m.tickets.find((t) => t.id === claims.ticketId);
    if (!entry) {
      return this.finish({
        kind: 'rejected',
        reason: 'not_in_list',
        message:
          'Not on the downloaded ticket list (issued after the last sync?). Refresh the list when online.',
        seat: claims.seatId,
        source: 'offline',
      });
    }
    if (entry.version !== claims.version) {
      return this.finish({
        kind: 'rejected',
        reason: 'stale_version',
        message: 'This QR code is out of date: the ticket was transferred or cancelled.',
        seat: entry.seatLabel,
        source: 'offline',
      });
    }
    if (entry.status !== 'valid') {
      return this.finish({
        kind: 'rejected',
        reason: 'void',
        message: 'This ticket was cancelled or refunded.',
        seat: entry.seatLabel,
        source: 'offline',
      });
    }
    if (entry.admittedAt !== null) {
      return this.finish({
        kind: 'duplicate',
        reason: 'duplicate_list',
        message: `Already scanned at ${this.d.clockTime(entry.admittedAt)} at ${entry.admittedGate ?? 'a gate'} (as of the last sync).`,
        seat: entry.seatLabel,
        holder: entry.holderName,
        source: 'offline',
      });
    }
    const now = this.d.now();
    this.data.admitted[claims.ticketId] = { at: now, gate: this.opts.gate, seat: entry.seatLabel };
    this.data.queue.push({
      code,
      gate: this.opts.gate,
      departureId: this.opts.departureId,
      clientScanId: this.d.newId(),
      scannedAt: now,
    });
    return this.finish({
      kind: 'admitted',
      reason: 'admitted_offline',
      message: `Admitted offline: seat ${entry.seatLabel}, ${entry.holderName}. Will be confirmed when the connection returns.`,
      seat: entry.seatLabel,
      holder: entry.holderName,
      source: 'offline',
    });
  }

  /** Sends queued offline scans for reconciliation. Safe to retry: every scan has its own id. */
  async sync(): Promise<{ sent: number; conflicts: number; remaining: number }> {
    if (this.data.queue.length === 0) return { sent: 0, conflicts: 0, remaining: 0 };
    const batch = [...this.data.queue];
    let results;
    try {
      results = await this.d.api.batch(batch);
    } catch (e) {
      if (e instanceof NetworkError) return { sent: 0, conflicts: 0, remaining: this.data.queue.length };
      throw e;
    }
    const done = new Set(results.map((r) => r.clientScanId));
    this.data.queue = this.data.queue.filter((q) => !done.has(q.clientScanId));
    let conflicts = 0;
    for (const r of results) {
      if (r.scan.conflict) conflicts += 1;
      if (r.scan.ticket && r.scan.firstScan && r.scan.result === 'duplicate') {
        this.data.admitted[r.scan.ticket.id] = {
          at: r.scan.firstScan.at,
          gate: r.scan.firstScan.gate,
          seat: r.scan.ticket.seatLabel,
        };
      }
    }
    this.save();
    await this.refreshManifest();
    return { sent: results.length, conflicts, remaining: this.data.queue.length };
  }
}
