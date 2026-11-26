import assert from 'node:assert/strict';
import { test } from 'node:test';
import { b64urlToBytes, bytesToB64url, parseCode, verifyCode } from '../src/shared/ticketCode.ts';
import { TicketKeys } from '../src/server/ticketKeys.ts';

const claims = {
  ticketId: 'tkt_0123456789abcdef01234567',
  departureId: 'dep-coach-1',
  seatId: '7C',
  version: 1,
};

test('a signed code verifies with the public key (browser path) and the private key holder (server path)', () => {
  const keys = TicketKeys.generate();
  const code = keys.signClaims(claims);
  assert.deepEqual(keys.verifyCode(code), claims);
  // verifyCode() is the shared, noble-based verifier that the browser scanner runs offline.
  assert.deepEqual(verifyCode(code, keys.publicKeyB64url), { ...claims, signature: code.split('.')[5] });
});

test('flipping any single bit of the signature is rejected', () => {
  const keys = TicketKeys.generate();
  const code = keys.signClaims(claims);
  const parts = code.split('.');
  const sig = b64urlToBytes(parts[5]!);
  let tested = 0;
  for (let byte = 0; byte < sig.length; byte += 1) {
    for (let bit = 0; bit < 8; bit += 1) {
      const bad = new Uint8Array(sig);
      bad[byte]! ^= 1 << bit;
      const tampered = [...parts.slice(0, 5), bytesToB64url(bad)].join('.');
      assert.equal(verifyCode(tampered, keys.publicKeyB64url), null, `bit ${byte}:${bit}`);
      assert.equal(keys.verifyCode(tampered), null);
      tested += 1;
    }
  }
  assert.equal(tested, 512);
});

test('changing the seat, ticket, departure or version invalidates the signature', () => {
  const keys = TicketKeys.generate();
  const parts = keys.signClaims(claims).split('.');
  const variants: [number, string][] = [
    [1, 'tkt_0123456789abcdef01234568'],
    [2, 'dep-coach-2'],
    [3, '7D'],
    [4, '2'],
  ];
  for (const [i, value] of variants) {
    const p = [...parts];
    p[i] = value;
    assert.equal(verifyCode(p.join('.'), keys.publicKeyB64url), null, `field ${i}`);
    assert.equal(keys.verifyCode(p.join('.')), null);
  }
});

test('a code signed by another key is rejected', () => {
  const a = TicketKeys.generate();
  const b = TicketKeys.generate();
  const code = a.signClaims(claims);
  assert.equal(verifyCode(code, b.publicKeyB64url), null);
  assert.equal(b.verifyCode(code), null);
});

test('malformed codes never throw and never verify', () => {
  const keys = TicketKeys.generate();
  const good = keys.signClaims(claims);
  for (const bad of [
    '',
    'TK1',
    'hello',
    good.replace('TK1', 'TK2'),
    `${good}.extra`,
    good.slice(0, -2),
    good.replace(/\.1\./, '.0.'),
    ' '.repeat(5),
  ]) {
    assert.equal(verifyCode(bad, keys.publicKeyB64url), null, bad);
  }
  assert.equal(parseCode(good)?.seatId, '7C');
  assert.equal(verifyCode(good, 'not-a-key'), null);
});

test('link tokens depend on the ticket version', () => {
  const keys = TicketKeys.generate();
  assert.notEqual(keys.viewToken('ticket', 'tkt_a', 1), keys.viewToken('ticket', 'tkt_a', 2));
  assert.notEqual(keys.viewToken('ticket', 'tkt_a', 1), keys.viewToken('ticket', 'tkt_b', 1));
  assert.notEqual(keys.viewToken('ticket', 'tkt_a', 1), keys.viewToken('booking', 'tkt_a', 1));
});
