import { ed25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';
import {
  b64urlToBytes,
  bytesToB64url,
  formatCode,
  parseCode,
  signingMessage,
  type TicketClaims,
} from '../../../src/shared/ticketCode.ts';

const keyStore = new Map<string, Uint8Array>();

/**
 * Same interface as `src/server/ticketKeys.ts`, with the Ed25519 calls made through @noble/curves
 * instead of `node:crypto`. The code format, the signed message and the verification used by the
 * gate come unchanged from `src/shared/ticketCode.ts`. The key is generated fresh on every page load
 * and never leaves the page.
 */
export class TicketKeys {
  readonly publicKeyB64url: string;
  private readonly viewSecret: Uint8Array;

  constructor(private readonly seed: Uint8Array) {
    this.publicKeyB64url = bytesToB64url(ed25519.getPublicKey(seed));
    this.viewSecret = hkdf(
      sha256,
      seed,
      new Uint8Array(0),
      new TextEncoder().encode('tiketi-view-links'),
      32,
    );
  }

  static generate(): TicketKeys {
    return new TicketKeys(randomBytes(32));
  }

  /** There is no disk: the key for a given "path" lives in memory for this page load. */
  static loadOrCreate(path: string): TicketKeys {
    let seed = keyStore.get(path);
    if (!seed) {
      seed = randomBytes(32);
      keyStore.set(path, seed);
    }
    return new TicketKeys(seed);
  }

  signClaims(claims: TicketClaims): string {
    return formatCode(claims, bytesToB64url(ed25519.sign(signingMessage(claims), this.seed)));
  }

  verifyCode(code: string): TicketClaims | null {
    const parsed = parseCode(code);
    if (!parsed) return null;
    try {
      const ok = ed25519.verify(
        b64urlToBytes(parsed.signature),
        signingMessage(parsed),
        b64urlToBytes(this.publicKeyB64url),
      );
      if (!ok) return null;
    } catch {
      return null;
    }
    const { ticketId, departureId, seatId, version } = parsed;
    return { ticketId, departureId, seatId, version };
  }

  viewToken(purpose: 'ticket' | 'booking', id: string, version = 0): string {
    const mac = hmac(sha256, this.viewSecret, new TextEncoder().encode(`${purpose}|${id}|${version}`));
    return bytesToB64url(mac).slice(0, 24);
  }
}
