import assert from 'node:assert/strict';
import { test } from 'node:test';
import jsQR from 'jsqr';
import { qrSvg } from '../src/server/qr.ts';
import { TicketKeys } from '../src/server/ticketKeys.ts';

/** Rasterises our own SVG output (the single path of `M x y h w v1 h-w z` runs) so a real decoder can read it. */
function rasterise(svg: string, scale = 6) {
  const size = Number(/viewBox="0 0 (\d+) \d+"/.exec(svg)![1]);
  const d = /<path d="([^"]+)"/.exec(svg)![1]!;
  const px = size * scale;
  const data = new Uint8ClampedArray(px * px * 4).fill(255);
  for (const m of d.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
    const [x, y, w] = [Number(m[1]), Number(m[2]), Number(m[3])];
    for (let yy = y * scale; yy < (y + 1) * scale; yy += 1) {
      for (let xx = x * scale; xx < (x + w) * scale; xx += 1) {
        const i = (yy * px + xx) * 4;
        data[i] = data[i + 1] = data[i + 2] = 0;
      }
    }
  }
  return { data, px };
}

test('the QR we render decodes back to exactly the signed ticket code', () => {
  const keys = TicketKeys.generate();
  for (const seat of ['1A', '12E', 'K10']) {
    const code = keys.signClaims({
      ticketId: 'tkt_0123456789abcdef01234567',
      departureId: 'dep-last-matatu-1',
      seatId: seat,
      version: 3,
    });
    const { data, px } = rasterise(qrSvg(code));
    const decoded = jsQR(data, px, px);
    assert.equal(decoded?.data, code);
  }
});

test('the SVG is small, self-contained and labelled', () => {
  const svg = qrSvg('TK1.x.y.z.1.sig', { label: 'QR <code> "x"' });
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.length < 12_000);
  assert.ok(!svg.includes('<script'));
  assert.match(svg, /aria-label="QR code x"/);
});
