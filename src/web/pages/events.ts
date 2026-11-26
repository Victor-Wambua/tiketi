import { get } from '../api.ts';
import { h } from '../dom.ts';
import { fmtDate, fmtTime, kes, plural } from '../format.ts';
import type { Page } from '../router.ts';

interface EventItem {
  id: string;
  title: string;
  kind: 'event' | 'trip';
  description: string;
  venue: string;
  layoutName: string;
  fromPriceKes: number;
  departures: { id: string; startsAt: number; seatsTotal: number; seatsLeft: number }[];
}

function card(e: EventItem) {
  const shown = e.departures.slice(0, 4);
  return h(
    'article',
    { class: 'ticket-card', 'aria-labelledby': `ev-${e.id}` },
    h(
      'div',
      { class: 't-main' },
      h('span', { class: 'eyebrow' }, e.kind === 'trip' ? 'Coach / matatu' : 'Live event'),
      h('h2', { id: `ev-${e.id}` }, e.title),
      h('p', { class: 'muted' }, e.venue),
      h('p', { class: 'muted' }, e.layoutName),
    ),
    h('div', { class: 't-tear', 'aria-hidden': 'true' }),
    h(
      'div',
      { class: 't-stub' },
      h(
        'div',
        { class: 'row between' },
        h('span', { class: 'eyebrow' }, 'From'),
        h('span', { class: 'price' }, kes(e.fromPriceKes)),
      ),
      shown.length === 0
        ? h('p', { class: 'muted' }, 'No upcoming departures.')
        : h(
            'ul',
            { class: 'dep-list' },
            ...shown.map((d) => {
              const low = d.seatsLeft <= Math.max(3, d.seatsTotal * 0.1);
              return h(
                'li',
                null,
                h(
                  'a',
                  { href: `/d/${d.id}`, 'data-link': '' },
                  h('span', null, `${fmtDate(d.startsAt)} · ${fmtTime(d.startsAt)}`),
                  h(
                    'span',
                    { class: `left${low ? ' low' : ''}` },
                    d.seatsLeft === 0 ? 'Sold out' : `${plural(d.seatsLeft, 'seat')} left`,
                  ),
                ),
              );
            }),
          ),
    ),
  );
}

export async function eventsPage(): Promise<Page> {
  const grid = h(
    'div',
    { class: 'event-grid', 'aria-busy': 'true' },
    ...[1, 2, 3].map(() => h('div', { class: 'card skeleton', 'aria-hidden': 'true' })),
  );
  const el = h(
    'div',
    { class: 'page' },
    h(
      'section',
      { class: 'hero' },
      h('span', { class: 'eyebrow' }, 'Seat booking and ticketing'),
      h('h1', null, 'Every seat sold once. Every ticket checkable.'),
      h(
        'p',
        null,
        'Pick your exact seat, hold it while you pay with M-Pesa, and get a ticket that gate staff can verify even with no signal. All events below are sample data.',
      ),
    ),
    grid,
  );
  try {
    const { events } = await get<{ events: EventItem[] }>('/api/events');
    grid.replaceChildren(...events.map(card));
  } catch {
    grid.replaceChildren(
      h(
        'p',
        { class: 'notice bad', role: 'alert' },
        'Could not load events. Check your connection and refresh.',
      ),
    );
  }
  grid.removeAttribute('aria-busy');
  return { title: 'Events and trips', el };
}
