import { ed25519 } from '@noble/curves/ed25519.js';

/**
 * Ticket code format (what the QR carries):
 *
 *   TK1.<ticketId>.<departureId>.<seatId>.<version>.<signature>
 *
 * The signature is Ed25519 over the UTF-8 bytes of `TK1|ticketId|departureId|seatId|version`, base64url.
 * This module is shared by the server (parsing) and the browser scanner (offline verification).
 */
export const CODE_PREFIX = 'TK1';

export interface TicketClaims {
  ticketId: string;
  departureId: string;
  seatId: string;
  version: number;
}

export interface ParsedCode extends TicketClaims {
  signature: string;
}

const ID = /^[A-Za-z0-9-]{1,40}$/;
const TICKET_ID = /^[A-Za-z0-9_-]{1,48}$/;

export function signingMessage(c: TicketClaims): Uint8Array {
  return new TextEncoder().encode(`${CODE_PREFIX}|${c.ticketId}|${c.departureId}|${c.seatId}|${c.version}`);
}

export function formatCode(c: TicketClaims, signature: string): string {
  return [CODE_PREFIX, c.ticketId, c.departureId, c.seatId, String(c.version), signature].join('.');
}

export function parseCode(raw: string): ParsedCode | null {
  const parts = raw.trim().split('.');
  if (parts.length !== 6 || parts[0] !== CODE_PREFIX) return null;
  const [, ticketId, departureId, seatId, versionStr, signature] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  if (!TICKET_ID.test(ticketId) || !TICKET_ID.test(departureId) || !ID.test(seatId)) return null;
  if (!/^[1-9][0-9]{0,5}$/.test(versionStr)) return null;
  if (!/^[A-Za-z0-9_-]{86}$/.test(signature)) return null;
  return { ticketId, departureId, seatId, version: Number(versionStr), signature };
}

export function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Verifies the signature with a raw 32-byte Ed25519 public key (base64url). Never throws. */
export function verifyCode(code: string, publicKeyB64url: string): ParsedCode | null {
  const parsed = parseCode(code);
  if (!parsed) return null;
  try {
    const ok = ed25519.verify(
      b64urlToBytes(parsed.signature),
      signingMessage(parsed),
      b64urlToBytes(publicKeyB64url),
    );
    return ok ? parsed : null;
  } catch {
    return null;
  }
}
