import assert from 'node:assert/strict';
import { createHash, createHmac, createPrivateKey, randomBytes as nodeRandom } from 'node:crypto';
import { test } from 'node:test';
import { BufferShim } from '../demo/src/polyfills.ts';
import * as shim from '../demo/src/shims/crypto.ts';
import { TicketKeys as BrowserKeys } from '../demo/src/shims/ticketKeys.ts';
import { verifyCode } from '../src/shared/ticketCode.ts';
import { TicketKeys as ServerKeys } from '../src/server/ticketKeys.ts';

// The demo swaps node:crypto for browser code. These tests check the swap does not change results.

const claims = { ticketId: 'tkt_abc123', departureId: 'dep-1', seatId: 'C7', version: 1 };

test('a ticket signed by the browser key verifies with the public key and with the server key class', () => {
  const k = BrowserKeys.generate();
  const code = k.signClaims(claims);
  assert.deepEqual(k.verifyCode(code), claims);
  assert.ok(verifyCode(code, k.publicKeyB64url));
});

test('a code signed by the node:crypto server key passes the shared verifier and fails under another key', () => {
  const server = ServerKeys.generate();
  const code = server.signClaims(claims);
  // Same wire format: the shared verifier (what the gate scanner runs) accepts it.
  assert.ok(verifyCode(code, server.publicKeyB64url));
  assert.equal(verifyCode(code, BrowserKeys.generate().publicKeyB64url), null);
});

test('browser-signed codes are byte-identical to node:crypto signatures for the same private key', () => {
  // Ed25519 is deterministic, so the same seed must give the same signature in both implementations.
  const seed = nodeRandom(32);
  const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
  const nodeKeys = new ServerKeys(createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' }));
  const browserKeys = new BrowserKeys(new Uint8Array(seed));
  assert.equal(browserKeys.publicKeyB64url, nodeKeys.publicKeyB64url);
  assert.equal(browserKeys.signClaims(claims), nodeKeys.signClaims(claims));
});

test('a tampered or foreign code is refused by the browser key class', () => {
  const k = BrowserKeys.generate();
  const code = k.signClaims(claims).split('.');
  code[3] = 'A1';
  assert.equal(k.verifyCode(code.join('.')), null);
  assert.equal(k.verifyCode(BrowserKeys.generate().signClaims(claims)), null);
});

test('hash and HMAC adapters match node:crypto', () => {
  const text = 'POST /api/holds\n{"seatIds":["C7"]}';
  assert.equal(
    shim.createHash('sha256').update(text).digest('hex'),
    createHash('sha256').update(text).digest('hex'),
  );
  assert.equal(
    shim.createHmac('sha256', 'dev-only-callback-secret').update(text).digest('hex'),
    createHmac('sha256', 'dev-only-callback-secret').update(text).digest('hex'),
  );
});

test('scrypt adapter matches node:crypto with the same salt', async () => {
  const salt = nodeRandom(16);
  const mine = await new Promise<Uint8Array>((ok, fail) =>
    shim.scrypt('organiser-demo-pass', salt, 32, (e, key) => (e ? fail(e) : ok(key))),
  );
  const { scryptSync } = await import('node:crypto');
  assert.equal(
    Buffer.from(mine).toString('hex'),
    scryptSync('organiser-demo-pass', salt, 32).toString('hex'),
  );
});

test('timingSafeEqual and Buffer encodings behave like Node', () => {
  assert.equal(shim.timingSafeEqual(BufferShim.from('abc'), BufferShim.from('abc')), true);
  assert.equal(shim.timingSafeEqual(BufferShim.from('abc'), BufferShim.from('abd')), false);
  assert.throws(() => shim.timingSafeEqual(BufferShim.from('a'), BufferShim.from('ab')));
  const raw = nodeRandom(21);
  for (const enc of ['hex', 'base64', 'base64url'] as const) {
    const text = Buffer.from(raw).toString(enc);
    assert.equal(BufferShim.from(raw).toString(enc), text);
    assert.equal(BufferShim.from(text, enc).toString('hex'), raw.toString('hex'));
  }
});
