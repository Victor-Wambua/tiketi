import {
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  hkdfSync,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  b64urlToBytes,
  bytesToB64url,
  formatCode,
  parseCode,
  signingMessage,
  type TicketClaims,
} from '../shared/ticketCode.ts';

/** Holds the Ed25519 key pair; signs ticket codes and derives link tokens. */
export class TicketKeys {
  readonly publicKeyB64url: string;
  private readonly viewSecret: Buffer;

  constructor(private readonly privateKey: KeyObject) {
    const jwk = createPublicKey(privateKey).export({ format: 'jwk' });
    this.publicKeyB64url = String(jwk.x);
    this.viewSecret = Buffer.from(
      hkdfSync('sha256', privateKey.export({ format: 'der', type: 'pkcs8' }), '', 'tiketi-view-links', 32),
    );
  }

  static generate(): TicketKeys {
    return new TicketKeys(generateKeyPairSync('ed25519').privateKey);
  }

  /** Loads the key from `path`, creating a new one on first run. */
  static loadOrCreate(path: string): TicketKeys {
    if (existsSync(path)) return new TicketKeys(createPrivateKey(readFileSync(path)));
    const { privateKey } = generateKeyPairSync('ed25519');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
    return new TicketKeys(privateKey);
  }

  signClaims(claims: TicketClaims): string {
    const sig = sign(null, signingMessage(claims), this.privateKey);
    return formatCode(claims, bytesToB64url(sig));
  }

  /** Server-side verification (node:crypto). The browser verifies the same bytes with the public key. */
  verifyCode(code: string): TicketClaims | null {
    const parsed = parseCode(code);
    if (!parsed) return null;
    const ok = verify(
      null,
      signingMessage(parsed),
      createPublicKey(this.privateKey),
      Buffer.from(b64urlToBytes(parsed.signature)),
    );
    if (!ok) return null;
    const { ticketId, departureId, seatId, version } = parsed;
    return { ticketId, departureId, seatId, version };
  }

  /** Unguessable per-version link token: changes when a ticket is transferred, so old links die. */
  viewToken(purpose: 'ticket' | 'booking', id: string, version = 0): string {
    return createHmac('sha256', this.viewSecret)
      .update(`${purpose}|${id}|${version}`)
      .digest('base64url')
      .slice(0, 24);
  }
}
