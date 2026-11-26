import './styles.css';
import { post } from './api.ts';
import { seatDefs } from './components/seatMap.ts';
import { h } from './dom.ts';
import { logoMark } from './logo.ts';
import { adminPage } from './pages/admin.ts';
import { bookingPage } from './pages/booking.ts';
import { departurePage } from './pages/departure.ts';
import { eventsPage } from './pages/events.ts';
import { gatePage } from './pages/gate.ts';
import { loginPage } from './pages/login.ts';
import { ticketPage } from './pages/ticket.ts';
import { navigate, route, start } from './router.ts';
import { currentUser, onSession, refreshSession } from './session.ts';

route('/', eventsPage);
route('/d/:id', departurePage);
route('/b/:id', bookingPage);
route('/t/:id', ticketPage);
route('/login', loginPage);
route('/gate', gatePage);
route('/admin', adminPage);
route('/.*', () => ({
  title: 'Not found',
  el: h(
    'div',
    { class: 'page' },
    h('h1', null, 'Page not found'),
    h('a', { class: 'btn', href: '/', 'data-link': '' }, 'Back to events'),
  ),
}));

const shell = document.getElementById('shell')!;
const nav = h('nav', { class: 'nav', 'aria-label': 'Main' });
const main = h('main', { id: 'main', tabindex: '-1' });

function paintNav() {
  const me = currentUser();
  const links: HTMLElement[] = [h('a', { href: '/', 'data-link': '' }, 'Events')];
  if (me?.role === 'organiser') links.push(h('a', { href: '/admin', 'data-link': '' }, 'Dashboard'));
  if (me) links.push(h('a', { href: '/gate', 'data-link': '' }, 'Gate'));
  if (me) {
    links.push(
      h(
        'button',
        {
          type: 'button',
          onClick: async () => {
            await post('/api/auth/logout');
            await refreshSession();
            navigate('/');
          },
        },
        `Sign out (${me.username})`,
      ),
    );
  } else links.push(h('a', { href: '/login', 'data-link': '' }, 'Staff'));
  nav.replaceChildren(...links);
  const here = location.pathname;
  for (const a of nav.querySelectorAll('a')) {
    if (a.getAttribute('href') === here) a.setAttribute('aria-current', 'page');
  }
}

shell.append(
  seatDefs(),
  h('div', { id: 'live', class: 'sr-only', role: 'status', 'aria-live': 'polite' }),
  h(
    'header',
    { class: 'topbar' },
    h(
      'div',
      { class: 'topbar-inner' },
      h(
        'a',
        { class: 'brand', href: '/', 'data-link': '', 'aria-label': 'Tiketi home' },
        logoMark(),
        'Tiketi',
      ),
      nav,
    ),
  ),
  main,
  h(
    'footer',
    { class: 'footer' },
    'Tiketi is a portfolio build. Events, people and payments are synthetic sample data; M-Pesa is mocked.',
  ),
);

onSession(paintNav);
window.addEventListener('popstate', paintNav);
document.addEventListener('click', () => queueMicrotask(paintNav));
paintNav();
void refreshSession();
start(main);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('/sw.js').catch(() => undefined);
}
