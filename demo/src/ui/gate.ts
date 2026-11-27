import { uid } from '../../../src/web/api.ts';
import { h, trustedSvg } from '../../../src/web/dom.ts';
import { fmtWhen } from '../../../src/web/format.ts';
import type { Page } from '../../../src/web/router.ts';
import { all } from '../../../src/server/db.ts';
import type { ScanResult } from '../../../src/server/gate.ts';
import { qrSvg } from '../../../src/server/qr.ts';
import { TicketKeys } from '../../../src/server/ticketKeys.ts';
import { parseCode, verifyCode } from '../../../src/shared/ticketCode.ts';
import type { Client, Runtime } from '../runtime.ts';

interface Ticket {
  id: string;
  seat_id: string;
  version: number;
  holder_name: string;
  label: string;
  departure_id: string;
}

const VERDICT_TEXT: Record<string, string> = {
  admitted: 'Admitted',
  duplicate: 'Refused: already used',
  invalid: 'Refused: not a genuine ticket',
  unknown_ticket: 'Refused: unknown ticket',
  stale_version: 'Refused: out of date',
  void: 'Refused: cancelled',
  wrong_departure: 'Refused: wrong event',
};

/** Signs in once as gate staff, through the real sign-in route, and keeps the session. */
let gateClient: Client | null = null;
async function gate(rt: Runtime): Promise<Client> {
  if (gateClient) return gateClient;
  const c = rt.client('gate-lab');
  const res = await rt.request(c, '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'gate1', password: 'gate-demo-pass' }),
  });
  if (!res.ok) throw new Error('Gate sign-in failed');
  gateClient = c;
  return c;
}

export function gatePage(rt: Runtime): Page {
  const db = rt.ctx.db;
  const publicKey = rt.ctx.keys.publicKeyB64url;
  const dep = 'dep-last-matatu-1';

  const pick = h('select', { id: 'gate-ticket' });
  const qrBox = h('div', { class: 'qr-small' });
  const codeBox = h('p', { class: 'code-text', id: 'gate-code' });
  const rows = h('tbody');
  const freeform = h('textarea', {
    id: 'gate-free',
    rows: '4',
    spellcheck: 'false',
    autocapitalize: 'off',
    autocomplete: 'off',
  }) as HTMLTextAreaElement;
  const freeOut = h('div', { class: 'scan-out', role: 'status', 'aria-live': 'polite' });
  const empty = h(
    'p',
    { class: 'notice warn', role: 'status', hidden: '' },
    'Every ticket for this show has been scanned.',
  );

  let tickets: Ticket[] = [];
  let validCode = '';

  function loadTickets() {
    tickets = all<Ticket>(
      db,
      `SELECT t.id, t.seat_id, t.version, t.holder_name, ds.label, t.departure_id
         FROM tickets t JOIN departure_seats ds ON ds.departure_id = t.departure_id AND ds.seat_id = t.seat_id
        WHERE t.departure_id = ? AND t.status = 'valid' AND t.admitted_at IS NULL ORDER BY t.rowid LIMIT 40`,
      dep,
    );
    pick.replaceChildren(
      ...tickets.map((t) => h('option', { value: t.id }, `Seat ${t.label}, ${t.holder_name}`)),
    );
    empty.hidden = tickets.length > 0;
    pick.disabled = tickets.length === 0;
    paintTicket();
  }

  const current = () => tickets.find((t) => t.id === pick.value);

  function codeFor(t: Ticket, key: TicketKeys = rt.ctx.keys): string {
    return key.signClaims({
      ticketId: t.id,
      departureId: t.departure_id,
      seatId: t.seat_id,
      version: t.version,
    });
  }

  function paintTicket() {
    const t = current();
    rows.replaceChildren();
    freeOut.replaceChildren();
    if (!t) {
      qrBox.replaceChildren();
      codeBox.textContent = '';
      freeform.value = '';
      return;
    }
    validCode = codeFor(t);
    qrBox.replaceChildren(trustedSvg(qrSvg(validCode, { label: `QR code for seat ${t.label}` })));
    codeBox.textContent = validCode;
    freeform.value = validCode;

    const other = t.seat_id === 'A1' ? 'A2' : 'A1';
    // The tampered code is the real signature (made for the real seat) with a different seat swapped in.
    const real = validCode.split('.');
    real[3] = other;
    const tamperedCode = real.join('.');
    const forgedKey = TicketKeys.generate();
    const forgedCode = codeFor(t, forgedKey);

    rows.append(
      scenario({
        n: 1,
        title: 'The real ticket',
        text: 'The code exactly as the system issued it.',
        code: validCode,
        button: 'Scan it',
      }),
      scenario({
        n: 2,
        title: 'The same ticket again',
        text: 'The first scan used the ticket up. The same code is scanned a second time.',
        code: validCode,
        button: 'Scan it again',
      }),
      scenario({
        n: 3,
        title: 'A tampered ticket',
        text: `Someone changes the seat from ${t.label} to ${other} and keeps the original signature.`,
        code: tamperedCode,
        mark: other,
        button: 'Scan it',
      }),
      scenario({
        n: 4,
        title: 'A forged ticket',
        text: 'A new key pair, made a moment ago, signs a ticket for this seat. It is well formed, but it is not the organiser’s key.',
        code: forgedCode,
        mark: forgedCode.split('.')[5],
        button: 'Scan it',
      }),
    );
  }

  async function scan(code: string) {
    const c = await gate(rt);
    const res = await rt.request(c, '/api/gate/scans', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': uid() },
      body: JSON.stringify({ code, gate: 'Gate A', departureId: dep }),
    });
    const body = (await res.json()) as { scan?: ScanResult; error?: { message: string } };
    if (!body.scan) throw new Error(body.error?.message ?? 'Scan failed');
    return body.scan;
  }

  /** Both checks a real scanner does: the offline signature check, then the server's verdict. */
  async function check(code: string): Promise<HTMLElement> {
    const offline = verifyCode(code, publicKey);
    const parsed = parseCode(code);
    let server: ScanResult | null = null;
    let failure = '';
    try {
      server = await scan(code);
    } catch (e) {
      failure = e instanceof Error ? e.message : 'Scan failed';
    }
    const admitted = server?.result === 'admitted';
    return h(
      'div',
      { class: `scan-result ${admitted ? 'ok' : 'bad'}` },
      h(
        'p',
        null,
        h('span', { class: 'k' }, 'In the browser, no network: '),
        h(
          'strong',
          null,
          offline
            ? 'signature valid'
            : parsed
              ? 'signature does not match the organiser’s key'
              : 'not a ticket code',
        ),
      ),
      h(
        'p',
        null,
        h('span', { class: 'k' }, 'Server: '),
        h('strong', null, server ? (VERDICT_TEXT[server.result] ?? server.result) : 'no answer'),
      ),
      h('p', { class: 'why' }, server ? server.message : failure),
    );
  }

  function scenario(o: {
    n: number;
    title: string;
    text: string;
    code: string;
    mark?: string | undefined;
    button: string;
  }) {
    const out = h('div', { class: 'scan-out', role: 'status', 'aria-live': 'polite' });
    const btn = h(
      'button',
      {
        class: 'btn small',
        type: 'button',
        onClick: async () => {
          btn.disabled = true;
          out.replaceChildren(h('p', { class: 'hint' }, 'Checking…'));
          try {
            out.replaceChildren(await check(o.code));
          } finally {
            btn.disabled = false;
          }
        },
      },
      o.button,
    );
    const codeEl = h('code', { class: 'code-text' });
    if (o.mark && o.code.includes(o.mark)) {
      const i = o.code.lastIndexOf(o.mark);
      codeEl.append(o.code.slice(0, i), h('mark', null, o.mark), o.code.slice(i + o.mark.length));
    } else codeEl.textContent = o.code;
    return h(
      'tr',
      null,
      h('th', { scope: 'row', 'data-label': 'Case' }, h('span', { class: 'num-lead' }, `${o.n}. `), o.title),
      h('td', { 'data-label': 'What happens' }, h('p', null, o.text), h('p', null, codeEl)),
      h('td', { 'data-label': 'Result' }, btn, out),
    );
  }

  pick.addEventListener('change', paintTicket);
  const reload = h(
    'button',
    { class: 'btn quiet small', type: 'button', onClick: loadTickets },
    'Refresh the list of unscanned tickets',
  );
  const freeBtn = h(
    'button',
    {
      class: 'btn small',
      type: 'button',
      onClick: async () => {
        freeBtn.disabled = true;
        freeOut.replaceChildren(h('p', { class: 'hint' }, 'Checking…'));
        try {
          freeOut.replaceChildren(await check(freeform.value.trim()));
        } finally {
          freeBtn.disabled = false;
        }
      },
    },
    'Scan this code',
  );

  loadTickets();

  const el = h(
    'div',
    { class: 'page demo-page' },
    h(
      'header',
      { class: 'stack' },
      h('span', { class: 'eyebrow' }, 'Demo lab'),
      h('h1', null, 'Gate checks'),
      h(
        'p',
        { class: 'lede' },
        'Gate staff scan a QR code. The scanner first checks the Ed25519 signature in the browser with the organiser’s public key, which works with no signal, then asks the server, which lets each ticket in once. The scans below go through the real gate route, signed in as the demo gate account.',
      ),
    ),
    h(
      'section',
      { class: 'stack', 'aria-labelledby': 'ticket-h' },
      h('h2', { id: 'ticket-h' }, 'Pick a ticket'),
      h(
        'p',
        { class: 'hint' },
        `Valid, unscanned tickets for the first showing (${fmtWhen(all<{ s: number }>(db, 'SELECT starts_at AS s FROM departures WHERE id = ?', dep)[0]?.s ?? 0)}). Each is a real ticket in this tab’s database.`,
      ),
      empty,
      h(
        'div',
        { class: 'ticket-pick' },
        h(
          'div',
          { class: 'stack' },
          h('div', { class: 'field' }, h('label', { for: 'gate-ticket' }, 'Ticket'), pick),
          reload,
        ),
        h(
          'div',
          { class: 'qr-wrap' },
          qrBox,
          h('div', null, h('p', { class: 'k' }, 'Code in the QR'), codeBox),
        ),
      ),
      h(
        'p',
        { class: 'hint' },
        'Organiser public key (base64url): ',
        h('code', { class: 'code-text' }, publicKey),
      ),
    ),
    h(
      'section',
      { class: 'stack', 'aria-labelledby': 'cases-h' },
      h('h2', { id: 'cases-h' }, 'Four scans'),
      h(
        'p',
        { class: 'hint' },
        'Run them in order, or in any order: the first scan that succeeds uses the ticket up.',
      ),
      h(
        'table',
        { class: 'stack-sm cases' },
        h(
          'thead',
          null,
          h(
            'tr',
            null,
            h('th', { scope: 'col' }, 'Case'),
            h('th', { scope: 'col' }, 'What happens'),
            h('th', { scope: 'col' }, 'Result'),
          ),
        ),
        rows,
      ),
    ),
    h(
      'section',
      { class: 'stack', 'aria-labelledby': 'free-h' },
      h('h2', { id: 'free-h' }, 'Edit a code yourself'),
      h(
        'p',
        { class: 'hint' },
        'Change any character and scan it. A genuine, unused code is admitted and used up.',
      ),
      h('div', { class: 'field' }, h('label', { for: 'gate-free' }, 'Ticket code'), freeform),
      h('div', { class: 'row' }, freeBtn),
      freeOut,
    ),
    h(
      'p',
      null,
      'The full scanner, with the offline queue, is on the ',
      h('a', { href: '/gate', 'data-link': '' }, 'Gate page'),
      ' (sign in as ',
      h('code', null, 'gate1'),
      ' with ',
      h('code', null, 'gate-demo-pass'),
      ').',
    ),
  );
  return { title: 'Gate checks', el };
}
