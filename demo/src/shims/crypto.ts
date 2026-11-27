/**
 * The part of `node:crypto` the server uses, on top of @noble/hashes (the same library family the
 * production scanner already uses for Ed25519). Hashes and HMAC are synchronous like Node's;
 * scrypt yields to the event loop every few milliseconds so sign-in does not freeze the page.
 */
import { hmac } from '@noble/hashes/hmac.js';
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes as nobleRandom } from '@noble/hashes/utils.js';
import { BufferShim } from '../polyfills.ts';

type Input = string | Uint8Array;
const bytes = (x: Input): Uint8Array => (typeof x === 'string' ? new TextEncoder().encode(x) : x);

class Digest {
  private readonly chunks: Uint8Array[] = [];
  constructor(private readonly finish: (data: Uint8Array) => Uint8Array) {}
  update(data: Input): this {
    this.chunks.push(bytes(data));
    return this;
  }
  digest(): BufferShim;
  digest(enc: 'hex' | 'base64' | 'base64url'): string;
  digest(enc?: 'hex' | 'base64' | 'base64url'): BufferShim | string {
    const total = new Uint8Array(this.chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of this.chunks) {
      total.set(c, at);
      at += c.length;
    }
    const out = BufferShim.from(this.finish(total));
    return enc ? out.toString(enc) : out;
  }
}

export function createHash(alg: string): Digest {
  if (alg !== 'sha256') throw new Error(`demo crypto shim: unsupported hash ${alg}`);
  return new Digest((d) => sha256(d));
}

export function createHmac(alg: string, key: Input): Digest {
  if (alg !== 'sha256') throw new Error(`demo crypto shim: unsupported hmac ${alg}`);
  return new Digest((d) => hmac(sha256, bytes(key), d));
}

export const randomBytes = (n: number): BufferShim => BufferShim.from(nobleRandom(n));

/** Constant-time comparison of two equal-length byte strings. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) throw new RangeError('Input buffers must have the same byte length');
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/** Node's defaults: N=16384, r=8, p=1. */
export function scrypt(
  password: Input,
  salt: Uint8Array,
  keylen: number,
  cb: (err: Error | null, key: BufferShim) => void,
): void {
  scryptAsync(bytes(password), salt, { N: 16384, r: 8, p: 1, dkLen: keylen }).then(
    (key) => cb(null, BufferShim.from(key)),
    (err: Error) => cb(err, BufferShim.from([])),
  );
}
