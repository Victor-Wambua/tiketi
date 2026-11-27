import { uid } from '../../../src/web/api.ts';
import { h } from '../../../src/web/dom.ts';
import { fmtTime, fmtWhen, plural } from '../../../src/web/format.ts';
import type { Page } from '../../../src/web/router.ts';
import { all } from '../../../src/server/db.ts';
import { expireDueHolds } from '../../../src/server/inventory.ts';
import type { Runtime } from '../runtime.ts';

interface Dep {
  id: string;
  title: string;
  starts_at: number;
}
interface Seat {
  seat_id: string;
  label: string;
}
interface Claim {
  seat_id: string;
  kind: string;
  hold_id: string;
  expires_at: number | null;
}
interface Outcome {
  buyer: string;
  status: number;
  won: boolean;
  text: string;
  order: number;
  holdId: string | null;
}

export function racePage(rt: Runtime): Page {
  const db = rt.ctx.db;

  const deps = all<Dep>(
    db,
    `SELECT d.id, e.title, d.starts_at FROM departures d JOIN events e ON e.id = d.event_id
      WHERE d.starts_at > ? AND d.status = 'scheduled' ORDER BY d.starts_at`,
    rt.clock.now(),
  );

  const depSelect = h(
    'select',
    { id: 'race-dep' },
    ...deps.map((d) => h('option', { value: d.id }, `${d.title}, ${fmtWhen(d.starts_at)}`)),
  );
  const seatSelect = h('select', { id: 'race-seat' });
  const buyersSelect = h(
    'select',
    { id: 'race-buyers' },
    ...[2, 3, 4, 6, 8].map((n) => h('option', { value: String(n) }, `${n} buyers`)),
  );
  const go = h('button', { class: 'btn primary', type: 'submit' }, 'Start the race');
  const seatNote = h('p', { class: 'hint', id: 'race-seat-note' });
  const results = h('div', { class: 'race-results', role: 'status', 'aria-live': 'polite' });
  const dbPanel = h('div', { class: 'race-db' });

  let winnerHold: {
    holdId: string;
    client: ReturnType<Runtime['client']>;
    dep: string;
    seat: string;
  } | null = null;

  function loadSeats() {
    expireDueHolds(rt.ctx, depSelect.value);
    const free = all<Seat>(
      db,
      `SELECT ds.seat_id, ds.label FROM departure_seats ds
        WHERE ds.departure_id = ?
          AND NOT EXISTS (SELECT 1 FROM seat_claims sc WHERE sc.departure_id = ds.departure_id AND sc.seat_id = ds.seat_id)
        ORDER BY ds.rowid`,
      depSelect.value,
    );
    seatSelect.replaceChildren(...free.map((s) => h('option', { value: s.seat_id }, `Seat ${s.label}`)));
    // Start on a seat near the middle so the first race is not on an edge seat.
    const mid = free[Math.floor(free.length / 2)];
    if (mid) seatSelect.value = mid.seat_id;
    seatSelect.disabled = free.length === 0;
    go.disabled = free.length === 0;
    seatNote.textContent =
      free.length === 0
        ? 'Every seat on this departure is sold or held. Pick another departure, or skip ahead so holds expire.'
        : `${plural(free.length, 'seat')} free on this departure.`;
  }

  async function startRace() {
    const dep = depSelect.value;
    const seat = seatSelect.value;
    const label = seatSelect.selectedOptions[0]?.textContent?.replace('Seat ', '') ?? seat;
    const n = Number(buyersSelect.value);
    const run = uid().slice(0, 6);
    const buyers = Array.from({ length: n }, (_, i) => ({
      name: `Buyer ${String.fromCharCode(65 + i)}`,
      client: rt.client(`race-${run}-${i}`),
    }));
    go.disabled = true;
    winnerHold = null;
    dbPanel.replaceChildren();
    results.replaceChildren(
      h('p', { class: 'hint' }, `${plural(n, 'buyer')} asking for seat ${label} at the same moment…`),
    );

    let finished = 0;
    // All requests are started in the same tick, before any of them is answered.
    const outcomes: Outcome[] = await Promise.all(
      buyers.map(async (b): Promise<Outcome> => {
        const res = await rt.request(b.client, '/api/holds', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': uid() },
          body: JSON.stringify({ departureId: dep, seatIds: [seat] }),
        });
        const order = (finished += 1);
        const body = (await res.json()) as {
          hold?: { id: string; expiresAt: number };
          error?: { code: string; message: string };
        };
        if (res.status === 201 && body.hold) {
          return {
            buyer: b.name,
            status: res.status,
            won: true,
            order,
            holdId: body.hold.id,
            text: `Seat held until ${fmtTime(body.hold.expiresAt)}.`,
          };
        }
        return {
          buyer: b.name,
          status: res.status,
          won: false,
          order,
          holdId: null,
          text: `${body.error?.code ?? 'error'}: ${body.error?.message ?? 'Request failed'}`,
        };
      }),
    );

    const winners = outcomes.filter((o) => o.won);
    const win = winners[0];
    if (win?.holdId) {
      const idx = outcomes.indexOf(win);
      winnerHold = { holdId: win.holdId, client: buyers[idx]!.client, dep, seat };
    }

    results.replaceChildren(
      h(
        'table',
        { class: 'stack-sm race-table' },
        h(
          'caption',
          { class: 'sr-only' },
          `Replies from the server to ${plural(n, 'buyer')} asking for seat ${label}`,
        ),
        h(
          'thead',
          null,
          h(
            'tr',
            null,
            h('th', { scope: 'col' }, 'Buyer'),
            h('th', { scope: 'col' }, 'Answered'),
            h('th', { scope: 'col' }, 'Server reply'),
            h('th', { scope: 'col' }, 'Result'),
          ),
        ),
        h(
          'tbody',
          null,
          ...outcomes.map((o) =>
            h(
              'tr',
              { class: o.won ? 'is-win' : 'is-lose' },
              h('th', { scope: 'row', 'data-label': 'Buyer' }, o.buyer),
              h('td', { 'data-label': 'Answered', class: 'num' }, `#${o.order}`),
              h(
                'td',
                { 'data-label': 'Server reply' },
                h('span', { class: 'mono' }, String(o.status)),
                ` ${o.text}`,
              ),
              h('td', { 'data-label': 'Result' }, h('strong', null, o.won ? 'Got the seat' : 'Refused')),
            ),
          ),
        ),
      ),
      h(
        'p',
        { class: winners.length === 1 ? 'verdict-line ok' : 'verdict-line bad' },
        winners.length === 1
          ? `Exactly one of ${plural(n, 'request')} won seat ${label}.`
          : `${plural(winners.length, 'request')} won seat ${label}. That should never happen.`,
      ),
    );

    paintDatabase(dep, seat, label);
    loadSeats();
  }

  function claimsFor(dep: string, seat: string): Claim[] {
    return all<Claim>(
      db,
      `SELECT seat_id, kind, hold_id, expires_at FROM seat_claims WHERE departure_id = ? AND seat_id = ?`,
      dep,
      seat,
    );
  }

  function paintDatabase(dep: string, seat: string, label: string) {
    const claims = claimsFor(dep, seat);
    const cheatOut = h('div', { role: 'status', 'aria-live': 'polite' });
    const cheat = h(
      'button',
      {
        class: 'btn',
        type: 'button',
        onClick: () => {
          // Raw SQL against the same database the app uses. No application code is involved.
          const holdId = claims[0]?.hold_id ?? 'x';
          const sql = `INSERT INTO seat_claims (departure_id, seat_id, kind, hold_id, expires_at) VALUES ('${dep}', '${seat}', 'hold', '${holdId}', ${rt.clock.now() + 600000})`;
          let msg: string;
          let refused = true;
          try {
            const r = db
              .prepare(
                `INSERT INTO seat_claims (departure_id, seat_id, kind, hold_id, expires_at) VALUES (?, ?, 'hold', ?, ?)`,
              )
              .run(dep, seat, holdId, rt.clock.now() + 600_000);
            refused = false;
            db.prepare(`DELETE FROM seat_claims WHERE rowid = ?`).run(r.lastInsertRowid);
            msg = 'The insert was accepted.';
          } catch (e) {
            msg = e instanceof Error ? e.message : String(e);
          }
          cheatOut.replaceChildren(
            h(
              'pre',
              { class: 'codeblock', tabindex: '0', 'aria-label': 'SQL statement' },
              h('code', null, sql),
            ),
            h(
              'p',
              { class: refused ? 'verdict-line ok' : 'verdict-line bad' },
              refused ? 'SQLite refused it:' : 'Unexpected:',
            ),
            h(
              'pre',
              { class: 'codeblock', tabindex: '0', 'aria-label': 'SQLite reply' },
              h('code', null, msg),
            ),
            h(
              'p',
              { class: 'hint' },
              `Seat ${label} still has ${plural(claimsFor(dep, seat).length, 'claim')}.`,
            ),
          );
        },
      },
      'Try to add a second claim by hand',
    );
    dbPanel.replaceChildren(
      h('h2', null, 'What the database holds'),
      h(
        'p',
        null,
        `Table `,
        h('code', null, 'seat_claims'),
        ' has a primary key on (departure, seat), so a seat can have at most one row. Rows for seat ',
        label,
        ':',
      ),
      claims.length === 0
        ? h('p', { class: 'hint' }, 'No claims. Nobody got the seat.')
        : h(
            'table',
            { class: 'stack-sm' },
            h(
              'thead',
              null,
              h(
                'tr',
                null,
                h('th', { scope: 'col' }, 'seat_id'),
                h('th', { scope: 'col' }, 'kind'),
                h('th', { scope: 'col' }, 'hold_id'),
                h('th', { scope: 'col' }, 'expires_at'),
              ),
            ),
            h(
              'tbody',
              null,
              ...claims.map((c) =>
                h(
                  'tr',
                  null,
                  h('td', { 'data-label': 'seat_id', class: 'mono' }, c.seat_id),
                  h('td', { 'data-label': 'kind', class: 'mono' }, c.kind),
                  h('td', { 'data-label': 'hold_id', class: 'mono wrap' }, c.hold_id),
                  h(
                    'td',
                    { 'data-label': 'expires_at', class: 'mono' },
                    c.expires_at ? fmtTime(c.expires_at) : 'none',
                  ),
                ),
              ),
            ),
          ),
      h(
        'p',
        null,
        'The app’s insert says “insert this claim, unless the seat already has one”. The database settles it, so the answer does not depend on which request arrived first. To see that the rule lives in SQLite and not only in the app’s code:',
      ),
      ...(claims.length > 0 ? [h('div', { class: 'row' }, cheat), cheatOut] : []),
      h(
        'div',
        { class: 'row after-race' },
        h(
          'button',
          {
            class: 'btn',
            type: 'button',
            onClick: async () => {
              if (!winnerHold) return;
              const w = winnerHold;
              await rt.request(w.client, `/api/holds/${w.holdId}`, {
                method: 'DELETE',
                headers: { 'idempotency-key': uid() },
              });
              winnerHold = null;
              dbPanel.replaceChildren(
                h('p', { class: 'notice ok', role: 'status' }, `Hold released. Seat ${label} is free again.`),
              );
              results.replaceChildren();
              loadSeats();
            },
          },
          'Release the winner’s hold',
        ),
        h('a', { class: 'btn quiet', href: `/d/${dep}`, 'data-link': '' }, 'See it on the seat map'),
      ),
    );
  }

  depSelect.addEventListener('change', () => {
    results.replaceChildren();
    dbPanel.replaceChildren();
    loadSeats();
  });

  const form = h(
    'form',
    {
      class: 'race-form',
      onSubmit: (e: Event) => {
        e.preventDefault();
        void startRace().finally(() => {
          go.disabled = seatSelect.disabled;
        });
      },
    },
    h('div', { class: 'field' }, h('label', { for: 'race-dep' }, 'Departure'), depSelect),
    h(
      'div',
      { class: 'field' },
      h('label', { for: 'race-seat' }, 'Seat everyone wants'),
      seatSelect,
      seatNote,
    ),
    h('div', { class: 'field' }, h('label', { for: 'race-buyers' }, 'How many buyers'), buyersSelect),
    go,
  );
  seatSelect.setAttribute('aria-describedby', 'race-seat-note');

  loadSeats();

  const el = h(
    'div',
    { class: 'page demo-page' },
    h(
      'header',
      { class: 'stack' },
      h('span', { class: 'eyebrow' }, 'Demo lab'),
      h('h1', null, 'Two buyers, one seat'),
      h(
        'p',
        { class: 'lede' },
        'Each buyer is a separate simulated browser with its own session. They all ask the real server for the same seat in the same instant. One gets a ten-minute hold; the others are told the seat is gone.',
      ),
    ),
    h(
      'div',
      { class: 'lab-grid' },
      h('div', { class: 'stack' }, form),
      h('div', { class: 'stack' }, results, dbPanel),
    ),
    h(
      'aside',
      { class: 'prose small', 'aria-label': 'Limits of this simulation' },
      h(
        'p',
        null,
        'A browser tab runs JavaScript on one thread, so the server handles these requests one after another, in the order they were sent. The guarantee comes from the transaction and the primary key, which is the same code the repository runs. The repository’s own tests go further (200 simultaneous holds, real sockets, four SQLite connections in separate threads); this page does not.',
      ),
    ),
  );
  return { title: 'Two buyers, one seat', el };
}
