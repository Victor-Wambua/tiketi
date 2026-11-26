import { s } from '../dom.ts';

const W = 560;
const H = 180;
const PAD = { l: 34, r: 12, t: 12, b: 26 };

interface Point {
  at: number;
  value: number;
}

/** Step-area chart of a running total over time (inline SVG, no library). */
export function areaChart(
  points: Point[],
  opts: { yMax: number; label: string; fmtX: (ms: number) => string },
): SVGSVGElement {
  const svg = s('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': opts.label });
  const iw = W - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;
  const yMax = Math.max(1, opts.yMax);
  const y = (v: number) => PAD.t + ih - (v / yMax) * ih;
  for (const f of [0, 0.5, 1]) {
    svg.append(
      s('line', { class: 'axis', x1: PAD.l, x2: W - PAD.r, y1: y(yMax * f), y2: y(yMax * f) }),
      s(
        'text',
        { class: 'tick', x: PAD.l - 6, y: y(yMax * f) + 3, 'text-anchor': 'end' },
        String(Math.round(yMax * f)),
      ),
    );
  }
  if (points.length === 0) {
    svg.append(s('text', { class: 'tick', x: W / 2, y: H / 2, 'text-anchor': 'middle' }, 'No sales yet'));
    return svg;
  }
  const t0 = points[0]!.at;
  const t1 = Math.max(points[points.length - 1]!.at, t0 + 1);
  const x = (t: number) => PAD.l + ((t - t0) / (t1 - t0)) * iw;
  let d = `M${x(t0)} ${y(0)}`;
  let prev = 0;
  for (const p of points) {
    d += ` L${x(p.at)} ${y(prev)} L${x(p.at)} ${y(p.value)}`;
    prev = p.value;
  }
  const line = d;
  d += ` L${x(t1)} ${y(prev)} L${x(t1)} ${y(0)} Z`;
  svg.append(
    s('path', { class: 'area', d }),
    s('path', { class: 'series', d: `${line} L${x(t1)} ${y(prev)}` }),
    s('text', { class: 'tick', x: PAD.l, y: H - 6 }, opts.fmtX(t0)),
    s('text', { class: 'tick', x: W - PAD.r, y: H - 6, 'text-anchor': 'end' }, opts.fmtX(t1)),
  );
  for (const p of points)
    svg.append(s('circle', { cx: x(p.at), cy: y(p.value), r: 3.5, fill: 'var(--accent-strong)' }));
  return svg;
}

/** Column chart of counts per time bucket for one series. */
export function barChart(
  buckets: Point[],
  opts: { label: string; fmtX: (ms: number) => string; alt?: boolean },
): SVGSVGElement {
  const svg = s('svg', {
    class: 'chart',
    viewBox: `0 0 ${W} ${H - 40}`,
    role: 'img',
    'aria-label': opts.label,
  });
  const hh = H - 40;
  const ih = hh - PAD.t - PAD.b;
  const max = Math.max(1, ...buckets.map((b) => b.value));
  const gap = 6;
  const bw = Math.min(46, (W - PAD.l - PAD.r) / Math.max(1, buckets.length) - gap);
  buckets.forEach((b, i) => {
    const h = (b.value / max) * ih;
    const x = PAD.l + i * (bw + gap);
    svg.append(
      s('rect', {
        class: `bar-rect${opts.alt ? ' alt' : ''}`,
        x,
        y: PAD.t + ih - h,
        width: bw,
        height: h,
        rx: 3,
      }),
      s(
        'text',
        { class: 'tick', x: x + bw / 2, y: PAD.t + ih - h - 4, 'text-anchor': 'middle' },
        String(b.value),
      ),
      s('text', { class: 'tick', x: x + bw / 2, y: hh - 8, 'text-anchor': 'middle' }, opts.fmtX(b.at)),
    );
  });
  svg.append(s('line', { class: 'axis', x1: PAD.l, x2: W - PAD.r, y1: PAD.t + ih, y2: PAD.t + ih }));
  return svg;
}
