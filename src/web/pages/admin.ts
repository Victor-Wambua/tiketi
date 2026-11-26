import type { Layout } from '../../shared/layout.ts';
import { ApiError, get, post } from '../api.ts';
import { areaChart, barChart } from '../components/charts.ts';
import { createSeatMap, legendSwatch, type SeatVisual } from '../components/seatMap.ts';
import { h } from '../dom.ts';
import { fmtDate, fmtTime, fmtWhen, kes, plural } from '../format.ts';
import { navigate, type Page } from '../router.ts';
import { refreshSession } from '../session.ts';

interface Dash {
  departure: { id: string; title: string; venue: string; startsAt: number };
  totals: {
    capacity: number;
    available: number;
    held: number;
    sold: number;
    scanned: number;
    revenueKes: number;
    refundedKes: number;
  };
  byTier: { tierId: string; name: string; capacity: number; sold: number; revenueKes: number }[];
  seats: { seatId: string; label: string; state: 'available' | 'held' | 'sold' | 'scanned' }[];
  occupancy: { at: number; sold: number }[];
  throughput: { gate: string; buckets: { at: number; count: number }[] }[];
  conflicts: { ticketId: string; seat: string; gate: string; at: number; offline: boolean; result: string }[];
  refunds: {
    id: string;
    bookingId: string;
    customerName: string;
    amountKes: number;
    reason: string;
    status: string;
    createdAt: number;
  }[];
}
interface Departure {
  layout: Layout;
  accessibleSeatIds: string[];
}

const REASONS: Record<string, string> = {
  late_payment: 'Paid after the hold expired',
  customer_cancelled: 'Customer cancelled',
  wrong_amount: 'Wrong amount paid',
  duplicate_payment: 'Paid twice',
  seat_unavailable: 'Seat no longer available',
  booking_cancelled: 'Paid for a cancelled booking',
};

export async function adminPage(): Promise<Page> {
  const me = await refreshSession();
  if (!me || me.role !== 'organiser') {
    navigate('/login?next=/admin', true);
    return { title: 'Dashboard', el: h('div') };
  }
  let deps: { id: string; startsAt: number; title: string }[] = [];
  try {
    deps = (await get<{ departures: typeof deps }>('/api/admin/departures')).departures;
  } catch (e) {
    if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
      navigate('/login?next=/admin', true);
      return { title: 'Dashboard', el: h('div') };
    }
  }
  const now = Date.now();
  const sorted = [...deps].sort((a, b) => Math.abs(a.startsAt - now) - Math.abs(b.startsAt - now));
  const select = h(
    'select',
    { id: 'dep' },
    ...deps.map((d) =>
      h(
        'option',
        { value: d.id, selected: d.id === sorted[0]?.id || null },
        `${d.title} · ${fmtWhen(d.startsAt)}`,
      ),
    ),
  );
  if (sorted[0]) select.value = sorted[0].id;
  const out = h('div', { class: 'stack' });
  const exportLink = h('a', { class: 'btn small', href: '#', download: '' }, 'Export CSV');
  const updated = h('span', { class: 'chip ok' }, 'Live');
  const root = h(
    'div',
    { class: 'page' },
    h(
      'header',
      { class: 'stack' },
      h('span', { class: 'eyebrow' }, 'Organiser'),
      h('h1', null, 'Dashboard'),
      h('div', { class: 'row' }, h('div', null, select), exportLink, updated),
    ),
    out,
  );

  let stream: EventSource | null = null;
  let timer = 0;
  let pending: number | undefined;
  let layoutFor = '';
  let layout: Departure | null = null;

  async function load() {
    const id = select.value;
    if (!id) {
      out.replaceChildren(
        h('p', { class: 'empty' }, 'No departures yet. Run npm run seed to load sample data.'),
      );
      return;
    }
    exportLink.href = `/api/admin/departures/${id}/export.csv`;
    try {
      if (layoutFor !== id) {
        layout = await get<Departure>(`/api/departures/${id}`);
        layoutFor = id;
      }
      const d = await get<Dash>(`/api/admin/departures/${id}/dashboard`);
      draw(d);
      updated.className = 'chip ok';
      updated.textContent = `Updated ${fmtTime(Date.now())}`;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) navigate('/login?next=/admin', true);
      updated.className = 'chip warn';
      updated.textContent = 'Offline';
    }
  }

  function draw(d: Dash) {
    const t = d.totals;
    const soldAll = t.sold + t.scanned;
    const kpi = (label: string, value: string, sub: string, bar?: number) =>
      h(
        'div',
        { class: 'kpi' },
        h('div', { class: 'eyebrow' }, label),
        h('div', { class: 'n' }, value),
        h('div', { class: 'sub' }, sub),
        bar !== undefined
          ? h(
              'div',
              { class: 'bar', 'aria-hidden': 'true' },
              h('i', { 'data-w': String(Math.round(bar * 100)) }),
            )
          : null,
      );
    const kpis = h(
      'div',
      { class: 'kpis' },
      kpi(
        'Sold',
        `${soldAll}/${t.capacity}`,
        `${Math.round((soldAll / Math.max(1, t.capacity)) * 100)}% full`,
        soldAll / Math.max(1, t.capacity),
      ),
      kpi(
        'Checked in',
        String(t.scanned),
        `${soldAll ? Math.round((t.scanned / soldAll) * 100) : 0}% of sold`,
        soldAll ? t.scanned / soldAll : 0,
      ),
      kpi('Held now', String(t.held), 'in someone’s checkout'),
      kpi(
        'Revenue',
        kes(t.revenueKes - t.refundedKes),
        t.refundedKes ? `after ${kes(t.refundedKes)} refunded` : 'no refunds paid',
      ),
    );

    const sm = createSeatMap({
      layout: layout!.layout,
      accessible: new Set(layout!.accessibleSeatIds),
      interactive: false,
      label: 'Seat heat map',
    });
    const vis: Record<string, SeatVisual> = {};
    for (const s of d.seats) vis[s.seatId] = s.state;
    sm.update(vis);
    const heat = h(
      'section',
      { class: 'card stack', 'aria-labelledby': 'heat-h' },
      h('h2', { id: 'heat-h' }, 'Seat heat map'),
      sm.el,
      h(
        'ul',
        { class: 'legend heat-legend' },
        h('li', null, legendSwatch('available'), `Available ${t.available}`),
        h('li', null, legendSwatch('held'), `Held ${t.held}`),
        h('li', null, legendSwatch('sold'), `Sold ${t.sold}`),
        h('li', null, legendSwatch('scanned'), `Checked in ${t.scanned}`),
      ),
    );

    const tiers = h(
      'section',
      { class: 'card stack', 'aria-labelledby': 'tier-h' },
      h('h2', { id: 'tier-h' }, 'Sales by tier'),
      h(
        'table',
        null,
        h(
          'thead',
          null,
          h(
            'tr',
            null,
            h('th', null, 'Tier'),
            h('th', { class: 'num' }, 'Sold'),
            h('th', { class: 'num' }, 'Revenue'),
          ),
        ),
        h(
          'tbody',
          null,
          ...d.byTier.map((x) =>
            h(
              'tr',
              null,
              h('td', null, x.name),
              h('td', { class: 'num' }, `${x.sold}/${x.capacity}`),
              h('td', { class: 'num' }, kes(x.revenueKes)),
            ),
          ),
        ),
      ),
    );

    const occupancy = h(
      'section',
      { class: 'card stack', 'aria-labelledby': 'occ-h' },
      h('h2', { id: 'occ-h' }, 'Occupancy over time'),
      areaChart(
        d.occupancy.map((o) => ({ at: o.at, value: o.sold })),
        {
          yMax: t.capacity,
          label: `Seats sold over time, now ${soldAll} of ${t.capacity}`,
          fmtX: (ms) => `${fmtDate(ms)} ${fmtTime(ms)}`,
        },
      ),
    );

    const gates = d.throughput.length
      ? d.throughput.map((g, i) =>
          h(
            'div',
            { class: 'stack' },
            h(
              'h3',
              null,
              `${g.gate}: ${plural(
                g.buckets.reduce((n, b) => n + b.count, 0),
                'entry',
                'entries',
              )}`,
            ),
            barChart(
              g.buckets.map((b) => ({ at: b.at, value: b.count })),
              { label: `Entries per 15 minutes at ${g.gate}`, fmtX: fmtTime, alt: i % 2 === 1 },
            ),
          ),
        )
      : [h('p', { class: 'empty' }, 'No tickets scanned yet.')];
    const throughput = h(
      'section',
      { class: 'card stack', 'aria-labelledby': 'thr-h' },
      h('h2', { id: 'thr-h' }, 'Gate throughput (15-minute buckets)'),
      ...gates,
    );

    const conflicts = d.conflicts.length
      ? h(
          'section',
          { class: 'card stack', 'aria-labelledby': 'con-h' },
          h('h2', { id: 'con-h' }, 'Offline scan conflicts'),
          h(
            'p',
            { class: 'muted' },
            'The same ticket was admitted at two gates while scanners were offline. Both people got in; review who held the ticket.',
          ),
          h(
            'table',
            null,
            h(
              'thead',
              null,
              h(
                'tr',
                null,
                h('th', null, 'Seat'),
                h('th', null, 'Gate'),
                h('th', null, 'Time'),
                h('th', null, 'Recorded as'),
              ),
            ),
            h(
              'tbody',
              null,
              ...d.conflicts.map((c) =>
                h(
                  'tr',
                  null,
                  h('td', { class: 'mono' }, c.seat),
                  h('td', null, c.gate),
                  h('td', { class: 'mono' }, fmtTime(c.at)),
                  h('td', null, c.result === 'admitted' ? 'first entry' : 'duplicate'),
                ),
              ),
            ),
          ),
        )
      : null;

    const refunds = h(
      'section',
      { class: 'card stack', 'aria-labelledby': 'ref-h' },
      h('h2', { id: 'ref-h' }, 'Refunds'),
      d.refunds.length === 0
        ? h('p', { class: 'empty' }, 'No refunds recorded.')
        : h(
            'table',
            null,
            h(
              'thead',
              null,
              h(
                'tr',
                null,
                h('th', null, 'Customer'),
                h('th', null, 'Why'),
                h('th', { class: 'num' }, 'Amount'),
                h('th', null, ''),
              ),
            ),
            h(
              'tbody',
              null,
              ...d.refunds.map((r) =>
                h(
                  'tr',
                  null,
                  h('td', null, r.customerName),
                  h('td', null, REASONS[r.reason] ?? r.reason),
                  h('td', { class: 'num' }, kes(r.amountKes)),
                  h(
                    'td',
                    null,
                    r.status === 'needed'
                      ? h(
                          'button',
                          {
                            class: 'btn small primary',
                            type: 'button',
                            onClick: () => void processRefund(r.id),
                          },
                          'Process refund',
                        )
                      : h('span', { class: 'chip ok' }, 'Refunded'),
                  ),
                ),
              ),
            ),
          ),
    );

    out.replaceChildren(
      kpis,
      h('div', { class: 'layout-2' }, heat, h('div', { class: 'stack' }, tiers, occupancy)),
      throughput,
      ...(conflicts ? [conflicts] : []),
      refunds,
    );
    for (const bar of out.querySelectorAll<HTMLElement>('.bar > i')) bar.style.width = `${bar.dataset.w}%`;
  }

  async function processRefund(id: string) {
    try {
      await post(`/api/admin/refunds/${id}/process`);
    } catch {
      /* shown on next refresh */
    }
    await load();
  }

  select.addEventListener('change', () => {
    stream?.close();
    listen();
    void load();
  });
  function listen() {
    stream?.close();
    if (!select.value) return;
    stream = new EventSource(`/api/departures/${select.value}/stream`);
    stream.addEventListener('seats', () => {
      window.clearTimeout(pending);
      pending = window.setTimeout(() => void load(), 200);
    });
  }
  await load();
  listen();
  timer = window.setInterval(() => void load(), 10_000);

  return {
    title: 'Dashboard',
    el: root,
    destroy() {
      stream?.close();
      window.clearInterval(timer);
    },
  };
}
