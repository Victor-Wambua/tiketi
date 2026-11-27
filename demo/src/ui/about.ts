import { h } from '../../../src/web/dom.ts';
import type { Page } from '../../../src/web/router.ts';

export const REPO = 'https://github.com/Victor-Wambua/tiketi';

const code = (text: string) => h('code', null, text);

function row(part: string, real: string, demo: string) {
  return h(
    'tr',
    null,
    h('th', { scope: 'row', 'data-label': 'Part' }, part),
    h('td', { 'data-label': 'In the real project' }, real),
    h('td', { 'data-label': 'In this demo' }, demo),
  );
}

export function aboutPage(): Page {
  const el = h(
    'div',
    { class: 'page demo-page' },
    h(
      'header',
      { class: 'stack' },
      h('span', { class: 'eyebrow' }, 'About this demo'),
      h('h1', null, 'How this demo works'),
      h(
        'p',
        { class: 'lede' },
        'This is the real Tiketi, running inside your browser tab. The repository’s own server code and front-end are bundled into this page, and the database, the signing keys and the mock M-Pesa phone all live in it. There is no server behind it.',
      ),
    ),

    h(
      'section',
      { class: 'prose', 'aria-labelledby': 'real' },
      h('h2', { id: 'real' }, 'What is real'),
      h(
        'ul',
        null,
        h(
          'li',
          null,
          'The Hono app: routes, sessions, ',
          code('Idempotency-Key'),
          ' handling and input checks (',
          code('src/server/http'),
          ').',
        ),
        h(
          'li',
          null,
          'Seat holds, bookings, payment callbacks, tickets, the gate and the organiser dashboard, with every SQL statement they run (',
          code('src/server'),
          ').',
        ),
        h(
          'li',
          null,
          'SQLite itself, compiled to WebAssembly (sql.js). The schema, the ',
          code('BEGIN IMMEDIATE'),
          ' transactions and the primary key on ',
          code('seat_claims'),
          ' that refuses a second claim on a seat are the repository’s.',
        ),
        h(
          'li',
          null,
          'Ed25519 ticket signatures, made and checked in this page. The code format and the check the gate scanner runs come unchanged from ',
          code('src/shared/ticketCode.ts'),
          '.',
        ),
        h(
          'li',
          null,
          'HMAC-signed payment callbacks from the mock M-Pesa adapter, verified and de-duplicated by the real handler.',
        ),
        h(
          'li',
          null,
          'The seed script that makes the sample events and purchases, and the front-end you are looking at (same files, with routes after a ',
          code('#'),
          ' so deep links work on a static host).',
        ),
      ),
    ),

    h(
      'section',
      { class: 'prose', 'aria-labelledby': 'swapped' },
      h('h2', { id: 'swapped' }, 'What is swapped or simulated'),
      h(
        'p',
        null,
        'The server code imports a few Node built-ins. For this build only, each is replaced by a small adapter (',
        code('demo/src/shims'),
        '). Nothing in ',
        code('src'),
        ' behaves differently in the normal build.',
      ),
      h(
        'table',
        { class: 'stack-sm' },
        h(
          'thead',
          null,
          h(
            'tr',
            null,
            h('th', { scope: 'col' }, 'Part'),
            h('th', { scope: 'col' }, 'In the real project'),
            h('th', { scope: 'col' }, 'In this demo'),
          ),
        ),
        h(
          'tbody',
          null,
          row(
            'Network',
            'The browser calls a Node server over HTTP.',
            'fetch and EventSource are answered by the Hono app inside the page. No request leaves your browser.',
          ),
          row(
            'Database',
            'node:sqlite, a file on disk.',
            'sql.js, in memory. Reloading starts again from sample data.',
          ),
          row(
            'Keys and hashes',
            'node:crypto. The signing key is kept on the server.',
            'JavaScript (@noble/curves, @noble/hashes). A new key is made on every page load.',
          ),
          row(
            'Cookies',
            'The browser’s cookie jar.',
            'A small jar kept by the demo, one per simulated shopper.',
          ),
          row('Time', 'The real clock.', 'The real clock plus whatever you add with “Skip ahead”.'),
          row(
            'Threads',
            'Requests can overlap across several SQLite connections.',
            'One JavaScript thread, so requests run one after another.',
          ),
          row(
            'Payments',
            'A mock of M-Pesa STK push. No real M-Pesa.',
            'The same mock. Nothing here can take money.',
          ),
        ),
      ),
    ),

    h(
      'section',
      { class: 'prose', 'aria-labelledby': 'notshown' },
      h('h2', { id: 'notshown' }, 'What is not shown'),
      h(
        'ul',
        null,
        h('li', null, 'Real M-Pesa. The project has never been connected to it.'),
        h(
          'li',
          null,
          'Real concurrency. The repository’s tests race 200 requests, real HTTP sockets and four SQLite connections in separate threads; a browser tab cannot do that.',
        ),
        h(
          'li',
          null,
          'Camera scanning on a phone. The scanner page has the button, but it has not been tried on a physical phone, here or in the repository.',
        ),
        h(
          'li',
          null,
          'HTTP security headers. Browsers only apply them to a real server, so this page carries an equivalent content policy in a meta tag instead.',
        ),
      ),
    ),

    h(
      'section',
      { class: 'prose', 'aria-labelledby': 'staff' },
      h('h2', { id: 'staff' }, 'Staff sign-in'),
      h(
        'p',
        null,
        'These two accounts exist only in this tab’s database. The passwords are checked with scrypt in your browser.',
      ),
      h(
        'table',
        { class: 'stack-sm' },
        h(
          'thead',
          null,
          h(
            'tr',
            null,
            h('th', { scope: 'col' }, 'Role'),
            h('th', { scope: 'col' }, 'Username'),
            h('th', { scope: 'col' }, 'Password'),
            h('th', { scope: 'col' }, 'Can open'),
          ),
        ),
        h(
          'tbody',
          null,
          h(
            'tr',
            null,
            h('th', { scope: 'row', 'data-label': 'Role' }, 'Organiser'),
            h('td', { 'data-label': 'Username' }, code('organiser')),
            h('td', { 'data-label': 'Password' }, code('organiser-demo-pass')),
            h('td', { 'data-label': 'Can open' }, 'Dashboard and Gate'),
          ),
          h(
            'tr',
            null,
            h('th', { scope: 'row', 'data-label': 'Role' }, 'Gate staff'),
            h('td', { 'data-label': 'Username' }, code('gate1')),
            h('td', { 'data-label': 'Password' }, code('gate-demo-pass')),
            h('td', { 'data-label': 'Can open' }, 'Gate'),
          ),
        ),
      ),
      h('p', null, h('a', { href: '/login', 'data-link': '' }, 'Go to staff sign-in')),
    ),

    h(
      'section',
      { class: 'prose', 'aria-labelledby': 'data' },
      h('h2', { id: 'data' }, 'Where your data goes'),
      h(
        'p',
        null,
        'Nowhere. Everything you do is kept in memory in this tab. Reload the page or press “Reset sample data” to start again. All names, phone numbers, events and tickets are invented.',
      ),
    ),

    h(
      'section',
      { class: 'prose', 'aria-labelledby': 'real-thing' },
      h('h2', { id: 'real-thing' }, 'Run the real thing'),
      h('p', null, 'You need Node 22.13 or newer. From the repository:'),
      h(
        'pre',
        { class: 'codeblock', tabindex: '0', 'aria-label': 'Quick start commands' },
        h(
          'code',
          null,
          'git clone https://github.com/Victor-Wambua/tiketi.git\ncd tiketi\nnpm ci\nnpm run seed\nnpm run build\nnpm start        # http://localhost:8787',
        ),
      ),
      h(
        'p',
        null,
        h('a', { href: REPO }, 'Source and README on GitHub'),
        '. To rebuild this demo: ',
        code('npm run demo:build'),
        '.',
      ),
    ),
  );
  return { title: 'How this demo works', el };
}
