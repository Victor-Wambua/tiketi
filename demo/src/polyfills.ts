/**
 * The server code was written for Node and uses `Buffer` and `process` in a few places. This file
 * supplies the small part of each that it actually uses. It must be the first import of the demo.
 */
import { bytesToB64url, b64urlToBytes } from '../../src/shared/ticketCode.ts';

type Encoding = 'utf8' | 'utf-8' | 'hex' | 'base64' | 'base64url';

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

// @ts-expect-error Node's Buffer.from takes an encoding where Uint8Array.from takes a map function.
export class BufferShim extends Uint8Array {
  static override from(input: string | ArrayLike<number>, enc: Encoding = 'utf8'): BufferShim {
    let bytes: Uint8Array;
    if (typeof input !== 'string') bytes = Uint8Array.from(input);
    else if (enc === 'hex') bytes = Uint8Array.from(input.match(/../g) ?? [], (h) => parseInt(h, 16));
    else if (enc === 'base64' || enc === 'base64url') bytes = b64urlToBytes(input.replace(/=+$/, ''));
    else bytes = new TextEncoder().encode(input);
    const out = new BufferShim(bytes.length);
    out.set(bytes);
    return out;
  }

  override toString(enc: Encoding = 'utf8'): string {
    if (enc === 'hex') return hex(this);
    if (enc === 'base64url') return bytesToB64url(this);
    if (enc === 'base64') {
      const u = bytesToB64url(this).replace(/-/g, '+').replace(/_/g, '/');
      return u + '='.repeat((4 - (u.length % 4)) % 4);
    }
    return new TextDecoder().decode(this);
  }
}

const g = globalThis as unknown as Record<string, unknown>;
g.Buffer ??= BufferShim;
g.process ??= { env: {}, argv: [], cwd: () => '/' };
