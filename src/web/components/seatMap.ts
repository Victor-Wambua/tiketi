import { flattenSeats, type Layout } from '../../shared/layout.ts';
import { h, s } from '../dom.ts';
import { kes } from '../format.ts';

export type SeatVisual = 'available' | 'held' | 'sold' | 'mine' | 'selected' | 'scanned';

const STATE_TEXT: Record<SeatVisual, string> = {
  available: 'available',
  selected: 'selected',
  mine: 'held for you',
  held: 'held by someone else',
  sold: 'sold',
  scanned: 'sold, checked in',
};

export interface SeatMapOptions {
  layout: Layout;
  accessible: Set<string>;
  interactive: boolean;
  label: string;
  onToggle?: (seatId: string) => void;
}

export interface SeatMap {
  el: HTMLElement;
  update(visuals: Record<string, SeatVisual>): void;
  flash(seatIds: string[]): void;
  focusSeat(seatId: string): void;
}

/** Defs shared by every seat map on the page: the hatch pattern that marks "held by someone else". */
export function seatDefs(): SVGSVGElement {
  return s(
    'svg',
    { width: 0, height: 0, class: 'defs-svg', 'aria-hidden': 'true', focusable: 'false' },
    s(
      'defs',
      null,
      s(
        'pattern',
        { id: 'hatch', width: 7, height: 7, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' },
        s('rect', { width: 7, height: 7, class: 'hatch-bg' }),
        s('line', { x1: 0, y1: 0, x2: 0, y2: 7, class: 'hatch-line', 'stroke-width': 3 }),
      ),
    ),
  );
}

/** Legend swatch for one seat state, drawn with the same classes as a real seat. */
export function legendSwatch(state: SeatVisual): SVGSVGElement {
  return s(
    'svg',
    { viewBox: '-2 -2 40 40', 'aria-hidden': 'true' },
    s(
      'g',
      { class: `seat view is-${state}` },
      s('rect', { class: 'body', width: 36, height: 36, rx: 8 }),
      s('path', { class: 'mark cross', d: 'M9 9l18 18M27 9L9 27' }),
      s('path', { class: 'mark check', d: 'M9 19l7 7 12-14' }),
    ),
  );
}

export function createSeatMap(opts: SeatMapOptions): SeatMap {
  const { layout, interactive } = opts;
  const S = layout.seatSize;
  const tierIndex = new Map(layout.tiers.map((t, i) => [t.id, i + 1]));
  const tierInfo = new Map(layout.tiers.map((t) => [t.id, t]));
  const seats = flattenSeats(layout);
  const byId = new Map<
    string,
    { g: SVGGElement; x: number; y: number; label: string; tier: string; accessible: boolean }
  >();

  const svg = s('svg', {
    class: 'seatmap',
    viewBox: `0 0 ${layout.width} ${layout.height}`,
    role: 'group',
    'aria-label': opts.label,
  });
  svg.style.setProperty('--w', String(layout.width));

  for (const d of layout.decor) {
    if (d.kind === 'stage') {
      svg.append(
        s('rect', { class: 'stage', x: d.x, y: d.y, width: d.w, height: d.h, rx: 10 }),
        s('text', { class: 'stage-text', x: d.x + d.w / 2, y: d.y + d.h / 2 + 5 }, d.label ?? 'STAGE'),
      );
    } else if (d.kind === 'driver') {
      svg.append(
        s('rect', { class: 'decor', x: d.x, y: d.y, width: d.w, height: d.h, rx: 10 }),
        s('circle', { class: 'decor', cx: d.x + d.w / 2, cy: d.y + d.h / 2, r: 9, fill: 'none' }),
        s('text', { class: 'decor-text', x: d.x + d.w / 2, y: d.y + d.h + 14 }, 'DRIVER'),
      );
    } else if (d.kind === 'door') {
      svg.append(s('rect', { class: 'decor', x: d.x, y: d.y, width: d.w, height: d.h, rx: 3 }));
    } else {
      svg.append(s('text', { class: 'decor-text', x: d.x + d.w / 2, y: d.y + 12 }, d.label ?? ''));
    }
  }

  for (const seat of seats) {
    const isAcc = opts.accessible.has(seat.id);
    const g = s(
      'g',
      {
        class: `seat ${interactive ? '' : 'view'} is-available`,
        transform: `translate(${seat.x} ${seat.y})`,
        'data-seat': seat.id,
        tabindex: interactive ? -1 : null,
        role: interactive ? 'checkbox' : null,
      },
      s('rect', { class: 'body', width: S, height: S, rx: 8 }),
      s('rect', {
        class: `band t-${tierIndex.get(seat.tier) ?? 1}`,
        x: 7,
        y: 4,
        width: S - 14,
        height: 5,
        rx: 2.5,
      }),
      s('text', { x: S / 2, y: S / 2 + 9 }, seat.label),
      s('path', { class: 'mark cross', d: 'M8 8l20 20M28 8L8 28', opacity: 0.35 }),
      s(
        'g',
        { class: 'mark check', transform: `translate(${S - 3} 3)` },
        s('circle', { r: 8, fill: '#14213d', stroke: 'none' }),
        s('path', { d: 'M-4 0l3 3 5-6', stroke: '#fff', 'stroke-width': 2.2 }),
      ),
    );
    if (isAcc) {
      g.append(
        s(
          'g',
          { transform: `translate(3 ${S - 3})` },
          s('circle', { class: 'acc', r: 8 }),
          s('circle', { cx: 0.5, cy: -4, r: 1.4, fill: '#fff' }),
          s('path', { class: 'acc-glyph', d: 'M0.5 -2v4h3.5M-3 -0.5h3' }),
          s('circle', { class: 'acc-glyph', cx: -0.5, cy: 3, r: 2.6 }),
        ),
      );
    }
    svg.append(g);
    byId.set(seat.id, { g, x: seat.x, y: seat.y, label: seat.label, tier: seat.tier, accessible: isAcc });
  }

  let active = seats[0]?.id ?? '';
  const setActive = (id: string) => {
    byId.get(active)?.g.setAttribute('tabindex', '-1');
    active = id;
    byId.get(id)?.g.setAttribute('tabindex', '0');
  };

  function update(next: Record<string, SeatVisual>) {
    for (const [id, v] of byId) {
      const state = next[id] ?? 'available';
      v.g.setAttribute('class', `seat ${interactive ? '' : 'view'} is-${state}`);
      const tier = tierInfo.get(v.tier);
      const parts = [
        `Seat ${v.label}`,
        tier?.name ?? '',
        tier ? kes(tier.priceKes) : '',
        v.accessible ? 'accessible seat' : '',
        STATE_TEXT[state],
      ];
      v.g.setAttribute('aria-label', parts.filter(Boolean).join(', '));
      if (interactive) {
        v.g.setAttribute('aria-checked', state === 'selected' || state === 'mine' ? 'true' : 'false');
        const free = state === 'available' || state === 'selected';
        if (free) v.g.removeAttribute('aria-disabled');
        else v.g.setAttribute('aria-disabled', 'true');
      }
    }
    if (interactive && !byId.get(active)?.g.getAttribute('tabindex')?.includes('0')) setActive(active);
  }

  function neighbour(from: string, dir: 'left' | 'right' | 'up' | 'down'): string | null {
    const f = byId.get(from);
    if (!f) return null;
    let best: string | null = null;
    let bestScore = Infinity;
    for (const [id, v] of byId) {
      if (id === from) continue;
      const dx = v.x - f.x;
      const dy = v.y - f.y;
      const along = dir === 'left' ? -dx : dir === 'right' ? dx : dir === 'up' ? -dy : dy;
      const across = dir === 'left' || dir === 'right' ? Math.abs(dy) : Math.abs(dx);
      if (along < 4) continue;
      const score = along + across * 3;
      if (score < bestScore) {
        bestScore = score;
        best = id;
      }
    }
    return best;
  }

  const wrap = h('div', { class: 'seatmap-wrap' }, svg);

  if (interactive) {
    const seatOf = (t: EventTarget | null) =>
      t instanceof Element ? t.closest<SVGGElement>('g.seat') : null;
    svg.addEventListener('click', (e) => {
      const g = seatOf(e.target);
      const id = g?.dataset.seat;
      if (!id) return;
      setActive(id);
      opts.onToggle?.(id);
    });
    svg.addEventListener('keydown', (e) => {
      const g = seatOf(e.target);
      const id = g?.dataset.seat;
      if (!id) return;
      const dirs: Record<string, 'left' | 'right' | 'up' | 'down'> = {
        ArrowLeft: 'left',
        ArrowRight: 'right',
        ArrowUp: 'up',
        ArrowDown: 'down',
      };
      const dir = dirs[e.key];
      if (dir) {
        e.preventDefault();
        const next = neighbour(id, dir);
        if (next) {
          setActive(next);
          byId.get(next)?.g.focus();
        }
      } else if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        const target = e.key === 'Home' ? seats[0]?.id : seats[seats.length - 1]?.id;
        if (target) {
          setActive(target);
          byId.get(target)?.g.focus();
        }
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        opts.onToggle?.(id);
      }
    });
    byId.get(active)?.g.setAttribute('tabindex', '0');
  }

  return {
    el: wrap,
    update,
    flash(ids) {
      for (const id of ids) {
        const g = byId.get(id)?.g;
        if (!g) continue;
        g.classList.add('just-taken');
        setTimeout(() => g.classList.remove('just-taken'), 1200);
      }
    },
    focusSeat(id) {
      if (!byId.has(id)) return;
      setActive(id);
      byId.get(id)?.g.focus();
    },
  };
}
