import { s } from './dom.ts';

/** The Tiketi mark: a ticket with side notches, a perforation and a check. */
export function logoMark(): SVGSVGElement {
  return s(
    'svg',
    { viewBox: '0 0 64 64', 'aria-hidden': 'true', focusable: 'false' },
    s('rect', { width: 64, height: 64, rx: 14, fill: '#f5a524' }),
    s('path', {
      d: 'M12 22a4 4 0 0 1 4-4h32a4 4 0 0 1 4 4v5a5 5 0 0 0 0 10v5a4 4 0 0 1-4 4H16a4 4 0 0 1-4-4v-5a5 5 0 0 0 0-10z',
      fill: '#14213d',
    }),
    s('path', { d: 'M40 20v24', stroke: '#f5a524', 'stroke-width': 2.5, 'stroke-dasharray': '3 3.5' }),
    s('path', {
      d: 'M20 38l4 4 8-9',
      fill: 'none',
      stroke: '#f5a524',
      'stroke-width': 3.5,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    }),
  );
}
