import type { Layout } from '../../shared/layout.ts';
import { ApiError, del, get, NetworkError, post, uid } from '../api.ts';
import { createSeatMap, legendSwatch, type SeatMap, type SeatVisual } from '../components/seatMap.ts';
import { announce, h } from '../dom.ts';
import { fmtWhen, kes, mmss, plural } from '../format.ts';
import { navigate, type Page, type RouteCtx } from '../router.ts';

interface HoldView {
  id: string;
  expiresAt: number;
  canExtend: boolean;
  totalKes: number;
  serverNow: number;
  seats: { seatId: string; label: string; priceKes: number; tierId: string }[];
}
interface BookingView {
  id: string;
  status: 'pending_payment' | 'confirmed' | 'cancelled' | 'expired';
  customerName: string;
  phone: string;
  totalKes: number;
  holdId: string;
  payment: { status: string; resultDesc: string | null } | null;
  tickets: { id: string; link: string }[];
  refund: { status: string; amountKes: number; reason: string } | null;
  token: string;
}
interface DepartureDetail {
  id: string;
  startsAt: number;
  title: string;
  kind: 'event' | 'trip';
  venue: string;
  layout: Layout;
  accessibleSeatIds: string[];
}
type ServerState = 'available' | 'held' | 'sold' | 'mine';
interface Prompt {
  providerRef: string;
  amountKes: number;
  phone: string;
}

const MAX_SEATS = 6;
const FAILED = new Set(['cancelled', 'timeout', 'insufficient_funds', 'failed']);
const FAIL_TEXT: Record<string, string> = {
  cancelled: 'You cancelled the payment on your phone.',
  timeout: 'The prompt timed out before it was answered.',
  insufficient_funds: 'M-Pesa reported insufficient funds.',
  failed: 'The payment did not go through.',
};

export async function departurePage(ctx: RouteCtx): Promise<Page> {
  const depId = ctx.params.id ?? '';
  const root = h('div', { class: 'page' });
  let dep: DepartureDetail;
  try {
    dep = await get<DepartureDetail>(`/api/departures/${depId}`);
  } catch {
    root.append(
      h('h1', null, 'Departure not found'),
      h(
        'p',
        { class: 'notice bad', role: 'alert' },
        'That event or trip does not exist, or has been removed.',
      ),
      h('a', { class: 'btn', href: '/', 'data-link': '' }, 'Back to events'),
    );
    return { title: 'Not found', el: root };
  }

  const layout = dep.layout;
  const tierIdx = new Map(layout.tiers.map((t, i) => [t.id, i + 1]));
  const priceOf = new Map(
    layout.sections.flatMap((s) =>
      s.rows.flatMap((r) =>
        r.seats.map((x) => [x.id, layout.tiers.find((t) => t.id === x.tier)?.priceKes ?? 0] as const),
      ),
    ),
  );
  const labelOf = new Map(
    layout.sections.flatMap((s) => s.rows.flatMap((r) => r.seats.map((x) => [x.id, x.label] as const))),
  );

  // ---- state ----------------------------------------------------------------------------
  let states: Record<string, ServerState> = {};
  const selected = new Set<string>();
  let hold: HoldView | null = null;
  let clockOffset = 0;
  let booking: BookingView | null = null;
  let message: { kind: 'ok' | 'warn' | 'bad'; text: string } | null = null;
  let prompts: Prompt[] = [];
  let simAvailable = true;
  let busy = false;
  let alive = true;
  const timers: number[] = [];
  let stream: EventSource | null = null;
  const bookingKey = (holdId: string) => `tiketi.booking.${holdId}`;

  const map: SeatMap = createSeatMap({
    layout,
    accessible: new Set(dep.accessibleSeatIds),
    interactive: true,
    label: `Seat map for ${dep.title}. Use arrow keys to move between seats and space to select.`,
    onToggle: toggleSeat,
  });

  const nameInput = h('input', {
    id: 'f-name',
    name: 'name',
    autocomplete: 'name',
    required: '',
    maxlength: 80,
  });
  const phoneInput = h('input', {
    id: 'f-phone',
    name: 'phone',
    type: 'tel',
    inputmode: 'tel',
    autocomplete: 'tel',
    placeholder: '0700 000 001',
    required: '',
  });
  const side = h('div', { class: 'side stack' });
  const bar = h('div', { class: 'sticky-bar', hidden: '' });
  const statusChip = h('span', { class: 'chip ok' }, 'Live');

  function visuals(): Record<string, SeatVisual> {
    const v: Record<string, SeatVisual> = {};
    for (const id of labelOf.keys()) {
      v[id] = selected.has(id) ? 'selected' : (states[id] ?? 'available');
    }
    return v;
  }
  const paintMap = () => map.update(visuals());

  function toggleSeat(id: string) {
    if (hold || booking) {
      announce('Release your current hold to choose different seats.');
      return;
    }
    const st = states[id] ?? 'available';
    if (st !== 'available') {
      announce(`Seat ${labelOf.get(id)} is ${st === 'sold' ? 'sold' : 'held by someone else'}.`);
      return;
    }
    if (selected.has(id)) selected.delete(id);
    else if (selected.size >= MAX_SEATS) {
      announce(`You can pick up to ${MAX_SEATS} seats.`);
      return;
    } else selected.add(id);
    message = null;
    announce(
      `Seat ${labelOf.get(id)} ${selected.has(id) ? 'selected' : 'removed'}. ${plural(selected.size, 'seat')} selected.`,
    );
    paintMap();
    renderSide();
  }

  // ---- data ------------------------------------------------------------------------------
  async function refresh() {
    try {
      const r = await get<{ states: Record<string, ServerState>; hold: HoldView | null }>(
        `/api/departures/${depId}/seats`,
      );
      const before = states;
      states = r.states;
      // Seats that someone else took while I was choosing.
      const lost = [...selected].filter((id) => states[id] !== 'available');
      if (lost.length) {
        for (const id of lost) selected.delete(id);
        map.flash(lost);
        const labels = lost.map((id) => labelOf.get(id)).join(', ');
        message = {
          kind: 'warn',
          text: `${plural(lost.length, 'seat')} you picked (${labels}) just taken by someone else. Please choose another.`,
        };
        announce(message.text);
      } else if (!hold) {
        const taken = Object.keys(states).filter(
          (id) => before[id] === 'available' && (states[id] === 'held' || states[id] === 'sold'),
        );
        if (taken.length) map.flash(taken);
      }
      if (r.hold) {
        adoptHold(r.hold);
        if (!booking) await resumeBooking(r.hold.id);
      } else if (hold && !booking) {
        hold = null;
        message = {
          kind: 'warn',
          text: 'Your hold expired and the seats were released. You can pick them again if they are still free.',
        };
        announce(message.text);
      }
      statusChip.className = 'chip ok';
      statusChip.textContent = 'Live';
    } catch (e) {
      if (e instanceof NetworkError) {
        statusChip.className = 'chip warn';
        statusChip.textContent = 'Offline';
      }
    }
    paintMap();
    renderSide();
  }

  function adoptHold(v: HoldView) {
    hold = v;
    clockOffset = v.serverNow - Date.now();
  }

  async function resumeBooking(holdId: string) {
    const id = sessionStorage.getItem(bookingKey(holdId));
    if (!id) return;
    try {
      booking = (await get<{ booking: BookingView }>(`/api/bookings/${id}`)).booking;
      if (booking.status !== 'pending_payment') booking = null;
    } catch {
      booking = null;
    }
  }

  // ---- actions ---------------------------------------------------------------------------
  const guard = async (fn: () => Promise<void>) => {
    if (busy) return;
    busy = true;
    renderSide();
    try {
      await fn();
    } catch (e) {
      if (e instanceof NetworkError)
        message = {
          kind: 'bad',
          text: 'No connection. Nothing was changed. Check your signal and try again.',
        };
      else if (e instanceof ApiError) message = { kind: e.status === 409 ? 'warn' : 'bad', text: e.message };
      else throw e;
      announce(message.text);
    } finally {
      busy = false;
      paintMap();
      renderSide();
    }
  };

  const holdSeats = () =>
    guard(async () => {
      const ids = [...selected];
      try {
        const r = await post<{ hold: HoldView }>('/api/holds', { departureId: depId, seatIds: ids }, uid());
        adoptHold(r.hold);
        selected.clear();
        message = {
          kind: 'ok',
          text: `Seats held. Pay within ${mmss(r.hold.expiresAt - r.hold.serverNow)} to keep them.`,
        };
        announce(message.text);
      } catch (e) {
        if (e instanceof ApiError && e.code === 'seat_unavailable') {
          const lost = ((e.details?.seatIds as string[] | undefined) ?? []).filter(Boolean);
          for (const id of lost) selected.delete(id);
          map.flash(lost);
          const labels = lost.map((id) => labelOf.get(id) ?? id).join(', ');
          message = {
            kind: 'warn',
            text: `Seat ${labels} was just taken by someone else. Your other seats are not held. Please pick another seat.`,
          };
          announce(message.text);
          await refresh();
          const firstFree = [...labelOf.keys()].find((id) => states[id] === 'available');
          if (firstFree) map.focusSeat(firstFree);
          return;
        }
        throw e;
      }
      await refresh();
    });

  const extend = () =>
    guard(async () => {
      if (!hold) return;
      adoptHold((await post<{ hold: HoldView }>(`/api/holds/${hold.id}/extend`)).hold);
      message = { kind: 'ok', text: 'Hold extended by 5 minutes.' };
    });

  const release = () =>
    guard(async () => {
      const holdId = hold?.id ?? booking?.holdId;
      if (!holdId) return;
      if (booking?.status === 'pending_payment') await post(`/api/bookings/${booking.id}/cancel`);
      else if (!booking) await del(`/api/holds/${holdId}`);
      sessionStorage.removeItem(bookingKey(holdId));
      hold = null;
      booking = null;
      message = { kind: 'ok', text: 'Seats released.' };
      await refresh();
    });

  async function pay(name: string, phone: string) {
    await guard(async () => {
      if (!hold) return;
      const r = await post<{ booking: BookingView }>(`/api/holds/${hold.id}/checkout`, { name, phone });
      booking = r.booking;
      sessionStorage.setItem(bookingKey(hold.id), booking.id);
      message = null;
      await refresh();
    });
    void pollPayment();
  }

  async function pollPayment() {
    if (!booking || !alive) return;
    try {
      const b = (await get<{ booking: BookingView }>(`/api/bookings/${booking.id}`)).booking;
      booking = b;
      if (b.status === 'confirmed') {
        sessionStorage.removeItem(bookingKey(b.holdId));
        navigate(
          b.tickets.length === 1 ? (b.tickets[0]?.link ?? `/b/${b.id}`) : `/b/${b.id}?k=${b.token}`,
          true,
        );
        return;
      }
    } catch {
      /* keep trying */
    }
    if (booking?.payment?.status === 'pending' || booking?.payment?.status === 'initiating') {
      try {
        const r = await get<{ prompts: Prompt[] }>(`/api/mock/stk?phone=${booking.phone}`);
        prompts = r.prompts;
        simAvailable = true;
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) simAvailable = false;
      }
    } else prompts = [];
    renderSide();
  }

  async function resolvePrompt(p: Prompt, outcome: string) {
    try {
      await post(`/api/mock/stk/${p.providerRef}/resolve`, { outcome });
    } catch {
      /* the prompt may already be gone */
    }
    prompts = [];
    await pollPayment();
  }

  // ---- rendering -------------------------------------------------------------------------
  const countdown = h('div', { class: 'countdown', role: 'timer', 'aria-live': 'off' }, '--:--');
  let lastAnnounced = 999;
  function tick() {
    if (!hold) return;
    const left = hold.expiresAt - (Date.now() + clockOffset);
    countdown.textContent = mmss(left);
    countdown.classList.toggle('low', left < 60_000);
    const secs = Math.ceil(left / 1000);
    for (const mark of [60, 30, 10]) {
      if (secs <= mark && lastAnnounced > mark) announce(`${mark} seconds left on your hold.`);
    }
    lastAnnounced = secs;
    if (left <= 0 && !busy) {
      lastAnnounced = 999;
      void refresh();
    }
  }

  function seatList(rows: { label: string; price: number }[]) {
    return h(
      'ul',
      { class: 'summary-list' },
      ...rows.map((r) =>
        h('li', null, h('span', null, `Seat ${r.label}`), h('span', { class: 'mono' }, kes(r.price))),
      ),
    );
  }

  // Skip re-rendering when nothing visible changed, so typing in the form is never interrupted.
  let lastSig = '';
  function renderSide() {
    const sig = JSON.stringify([
      message,
      busy,
      [...selected],
      hold && [hold.id, hold.expiresAt, hold.canExtend],
      booking && [booking.status, booking.payment, booking.refund],
      prompts.map((x) => x.providerRef),
      simAvailable,
    ]);
    if (sig === lastSig) return;
    lastSig = sig;
    const nodes: Node[] = [];
    if (message)
      nodes.push(
        h(
          'p',
          { class: `notice ${message.kind}`, role: message.kind === 'bad' ? 'alert' : 'status' },
          message.text,
        ),
      );

    if (booking) nodes.push(paymentPanel(booking));
    else if (hold) nodes.push(holdPanel(hold));
    else nodes.push(pickPanel());
    if (booking && simAvailable && booking.payment?.status === 'pending') nodes.push(phoneSim());
    side.replaceChildren(...nodes);

    // phone-width sticky action bar
    if (!hold && !booking && selected.size > 0) {
      const total = [...selected].reduce((n, id) => n + (priceOf.get(id) ?? 0), 0);
      bar.hidden = false;
      bar.replaceChildren(
        h(
          'div',
          { class: 'row between' },
          h(
            'div',
            null,
            h('strong', null, plural(selected.size, 'seat')),
            h('div', { class: 'mono' }, kes(total)),
          ),
          h(
            'button',
            { class: 'btn primary', type: 'button', disabled: busy || null, onClick: () => void holdSeats() },
            'Hold seats',
          ),
        ),
      );
    } else {
      bar.hidden = true;
    }
  }

  function pickPanel() {
    const ids = [...selected];
    const total = ids.reduce((n, id) => n + (priceOf.get(id) ?? 0), 0);
    return h(
      'section',
      { class: 'card stack', 'aria-labelledby': 'sel-h' },
      h('h2', { id: 'sel-h' }, ids.length ? plural(ids.length, 'seat') + ' selected' : 'Choose your seats'),
      ids.length
        ? seatList(ids.map((id) => ({ label: labelOf.get(id) ?? id, price: priceOf.get(id) ?? 0 })))
        : h(
            'p',
            { class: 'muted' },
            `Tap seats on the map. You can hold up to ${MAX_SEATS}. Seats are kept for you for 10 minutes once held.`,
          ),
      ids.length
        ? h('div', { class: 'total' }, h('span', null, 'Total'), h('span', { class: 'mono' }, kes(total)))
        : null,
      h(
        'button',
        {
          class: 'btn primary',
          type: 'button',
          disabled: ids.length === 0 || busy || null,
          onClick: () => void holdSeats(),
        },
        busy ? 'Holding…' : 'Hold seats',
      ),
    );
  }

  function holdPanel(hv: HoldView) {
    const name = nameInput;
    const phone = phoneInput;
    const form = h(
      'form',
      {
        class: 'stack',
        novalidate: '',
        onSubmit: (e: Event) => {
          e.preventDefault();
          if (!name.value.trim() || !phone.value.trim()) {
            message = { kind: 'bad', text: 'Enter your name and M-Pesa phone number.' };
            renderSide();
            return;
          }
          void pay(name.value, phone.value);
        },
      },
      h('div', { class: 'field' }, h('label', { for: 'f-name' }, 'Name on the ticket'), name),
      h(
        'div',
        { class: 'field' },
        h('label', { for: 'f-phone' }, 'M-Pesa phone number'),
        phone,
        h(
          'p',
          { class: 'hint' },
          'You will get a prompt on this number. Sample data only: no real payment is made.',
        ),
      ),
      h(
        'button',
        { class: 'btn primary', type: 'submit', disabled: busy || null },
        `Pay ${kes(hv.totalKes)} with M-Pesa`,
      ),
    );
    queueMicrotask(tick);
    return h(
      'section',
      { class: 'card stack', 'aria-labelledby': 'hold-h' },
      h(
        'div',
        { class: 'row between' },
        h('h2', { id: 'hold-h' }, 'Seats held for you'),
        h('span', { class: 'chip ok' }, 'Held'),
      ),
      h('div', null, h('div', { class: 'eyebrow' }, 'Time left'), countdown),
      seatList(hv.seats.map((x) => ({ label: x.label, price: x.priceKes }))),
      h('div', { class: 'total' }, h('span', null, 'Total'), h('span', { class: 'mono' }, kes(hv.totalKes))),
      form,
      h(
        'div',
        { class: 'row' },
        hv.canExtend
          ? h(
              'button',
              {
                class: 'btn small quiet',
                type: 'button',
                disabled: busy || null,
                onClick: () => void extend(),
              },
              'Add 5 minutes',
            )
          : null,
        h(
          'button',
          { class: 'btn small quiet', type: 'button', disabled: busy || null, onClick: () => void release() },
          'Release seats',
        ),
      ),
    );
  }

  function paymentPanel(b: BookingView) {
    const st = b.payment?.status ?? 'pending';
    const pending = st === 'pending' || st === 'initiating';
    let body: Node;
    if (b.status === 'expired' || (b.refund && b.refund.reason === 'late_payment')) {
      body = h(
        'p',
        { class: 'notice warn', role: 'status' },
        b.refund
          ? `Your payment arrived after the hold expired, so we did not issue tickets. A refund of ${kes(b.refund.amountKes)} has been recorded.`
          : 'The hold expired before payment. Your seats were released.',
      );
    } else if (st === 'amount_mismatch') {
      body = h(
        'p',
        { class: 'notice bad', role: 'alert' },
        'The amount received did not match the price. No tickets were issued and a refund has been recorded.',
      );
    } else if (pending) {
      body = h(
        'div',
        { class: 'row' },
        h('span', { class: 'spinner', 'aria-hidden': 'true' }),
        h(
          'p',
          { role: 'status' },
          `Check your phone (${b.phone.replace(/^254/, '0').replace(/(\d{4})(\d{3})(\d{3})/, '$1 $2 $3')}) and enter your M-Pesa PIN.`,
        ),
      );
    } else if (FAILED.has(st)) {
      body = h(
        'p',
        { class: 'notice warn', role: 'alert' },
        `${FAIL_TEXT[st] ?? FAIL_TEXT.failed} Your seats are still held, so you can try again.`,
      );
    } else {
      body = h('p', { class: 'notice ok', role: 'status' }, 'Payment received. Preparing your tickets…');
    }
    const retry = FAILED.has(st) && b.status === 'pending_payment';
    return h(
      'section',
      { class: 'card stack', 'aria-labelledby': 'pay-h' },
      h('h2', { id: 'pay-h' }, 'Payment'),
      h('div', { class: 'total' }, h('span', null, 'To pay'), h('span', { class: 'mono' }, kes(b.totalKes))),
      body,
      retry
        ? h(
            'button',
            {
              class: 'btn primary',
              type: 'button',
              disabled: busy || null,
              onClick: () => void pay(b.customerName, b.phone),
            },
            'Send a new prompt',
          )
        : null,
      h(
        'button',
        { class: 'btn small quiet', type: 'button', disabled: busy || null, onClick: () => void release() },
        b.status === 'pending_payment' ? 'Cancel and release seats' : 'Back to the seat map',
      ),
    );
  }

  function phoneSim() {
    return h(
      'section',
      { class: 'stack', 'aria-labelledby': 'sim-h' },
      h('p', { class: 'eyebrow', id: 'sim-h' }, 'Reviewer tool · mock M-Pesa phone'),
      h(
        'div',
        { class: 'phone' },
        h('div', { class: 'notch' }),
        prompts.length === 0
          ? h('p', { class: 'sms' }, 'No prompt on this phone right now.')
          : h(
              'div',
              null,
              ...prompts.map((p) =>
                h(
                  'div',
                  null,
                  h(
                    'div',
                    { class: 'sms' },
                    h('b', null, 'M-PESA'),
                    h('p', null, `Pay ${kes(p.amountKes)} to Tiketi (sample)? Enter PIN.`),
                  ),
                  h(
                    'button',
                    {
                      class: 'btn primary',
                      type: 'button',
                      'data-outcome': 'success',
                      onClick: () => void resolvePrompt(p, 'success'),
                    },
                    'Enter PIN and send',
                  ),
                  h(
                    'button',
                    {
                      class: 'btn',
                      type: 'button',
                      'data-outcome': 'cancelled',
                      onClick: () => void resolvePrompt(p, 'cancelled'),
                    },
                    'Cancel',
                  ),
                  h(
                    'button',
                    {
                      class: 'btn',
                      type: 'button',
                      'data-outcome': 'insufficient_funds',
                      onClick: () => void resolvePrompt(p, 'insufficient_funds'),
                    },
                    'Insufficient funds',
                  ),
                  h(
                    'button',
                    {
                      class: 'btn',
                      type: 'button',
                      'data-outcome': 'timeout',
                      onClick: () => void resolvePrompt(p, 'timeout'),
                    },
                    'Let it time out',
                  ),
                ),
              ),
            ),
      ),
      h(
        'p',
        { class: 'hint' },
        'Stand-in for the customer’s phone. Real M-Pesa is not connected; outcomes come back as signed callbacks.',
      ),
    );
  }

  // ---- assemble --------------------------------------------------------------------------
  const tierLegend = h(
    'ul',
    { class: 'legend', 'aria-label': 'Price tiers' },
    ...layout.tiers.map((t) =>
      h(
        'li',
        null,
        h('span', { class: `tier-dot tier-${tierIdx.get(t.id)}`, 'aria-hidden': 'true' }),
        `${t.name} · ${kes(t.priceKes)}`,
      ),
    ),
  );
  const stateLegend = h(
    'ul',
    { class: 'legend', 'aria-label': 'Seat states' },
    h('li', null, legendSwatch('available'), 'Available'),
    h('li', null, legendSwatch('selected'), 'Selected'),
    h('li', null, legendSwatch('held'), 'Held by someone'),
    h('li', null, legendSwatch('sold'), 'Sold'),
  );

  root.append(
    h(
      'header',
      { class: 'stack' },
      h('span', { class: 'eyebrow' }, dep.kind === 'trip' ? 'Coach / matatu' : 'Live event'),
      h('h1', null, dep.title),
      h('p', { class: 'muted' }, `${dep.venue} · ${fmtWhen(dep.startsAt)} (Nairobi time)`),
    ),
    h(
      'div',
      { class: 'layout-2' },
      h(
        'section',
        { class: 'card stack', 'aria-label': 'Seat map' },
        h('div', { class: 'row between' }, tierLegend, statusChip),
        map.el,
        stateLegend,
        h(
          'p',
          { class: 'hint' },
          'Keyboard: arrow keys move between seats, space or enter selects. A diagonal pattern means held by someone else; a cross means sold.',
        ),
        bar,
      ),
      side,
    ),
  );

  paintMap();
  renderSide();
  await refresh();

  stream = new EventSource(`/api/departures/${depId}/stream`);
  let pending: number | undefined;
  stream.addEventListener('seats', () => {
    window.clearTimeout(pending);
    pending = window.setTimeout(() => void refresh(), 120);
  });
  stream.addEventListener('error', () => {
    statusChip.className = 'chip warn';
    statusChip.textContent = 'Reconnecting';
  });
  stream.addEventListener('open', () => {
    statusChip.className = 'chip ok';
    statusChip.textContent = 'Live';
  });
  timers.push(window.setInterval(tick, 250));
  timers.push(window.setInterval(() => void refresh(), 10_000)); // safety net if the stream is blocked
  timers.push(window.setInterval(() => void pollPayment(), 1500));

  return {
    title: dep.title,
    el: root,
    destroy() {
      alive = false;
      stream?.close();
      for (const t of timers) window.clearInterval(t);
    },
  };
}
