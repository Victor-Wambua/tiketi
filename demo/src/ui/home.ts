import { h } from '../../../src/web/dom.ts';
import { eventsPage } from '../../../src/web/pages/events.ts';
import type { Page } from '../../../src/web/router.ts';

/** The real events page, with a short guide between its heading and the events. */
export async function homePage(): Promise<Page> {
  const page = await eventsPage();
  const link = (route: string, text: string) => h('a', { href: route, 'data-link': '' }, text);
  const guide = h(
    'section',
    { class: 'guide', 'aria-labelledby': 'try-this' },
    h('h2', { id: 'try-this' }, 'Try this'),
    h(
      'ol',
      null,
      h(
        'li',
        null,
        h('strong', null, 'Hold seats. '),
        'Open ',
        link('/d/dep-last-matatu-1', 'The Last Matatu'),
        ', pick two seats and press Hold seats. A ten-minute timer starts.',
      ),
      h(
        'li',
        null,
        h('strong', null, 'Pay with the mock M-Pesa. '),
        'Enter any name and 0700 000 001, press Pay, then use the phone panel to choose what happens: Enter PIN and send, Cancel, Insufficient funds or Let it time out. A success gives you a signed QR ticket.',
      ),
      h(
        'li',
        null,
        h('strong', null, 'Let a hold run out. '),
        'With seats held, press “Skip ahead 10 min” in the bar above. The seats go back on sale. If you then pay late, the money is recorded as a refund to process, not kept.',
      ),
      h(
        'li',
        null,
        h('strong', null, 'Race for one seat. '),
        link('/demo/race', 'Two buyers, one seat'),
        ': several simulated shoppers ask for the same seat at once and exactly one gets it.',
      ),
      h(
        'li',
        null,
        h('strong', null, 'Check tickets at the gate. '),
        link('/demo/gate', 'Gate checks'),
        ': a valid ticket, a tampered one, a forged one and a second scan of the same ticket.',
      ),
    ),
  );
  const grid = page.el.querySelector('.event-grid');
  if (grid) grid.before(guide);
  else page.el.append(guide);
  return page;
}
