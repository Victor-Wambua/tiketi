import { ApiError, get, post } from '../api.ts';
import { h } from '../dom.ts';
import { kes, plural } from '../format.ts';
import type { Page, RouteCtx } from '../router.ts';

interface Booking {
  id: string;
  status: 'pending_payment' | 'confirmed' | 'cancelled' | 'expired';
  customerName: string;
  totalKes: number;
  tickets: { id: string; seatLabel: string; holderName: string; status: string; link: string }[];
  refund: { status: string; amountKes: number; reason: string } | null;
  payment: { receipt: string | null } | null;
}

const REASONS: Record<string, string> = {
  late_payment: 'payment arrived after the seats were released',
  customer_cancelled: 'you cancelled the booking',
  wrong_amount: 'the amount paid did not match the price',
  duplicate_payment: 'a second payment was received',
  seat_unavailable: 'the seats were no longer available',
  booking_cancelled: 'the booking had been cancelled',
};

export async function bookingPage(ctx: RouteCtx): Promise<Page> {
  const id = ctx.params.id ?? '';
  const key = ctx.query.get('k');
  const root = h('div', { class: 'page' });
  const body = h('div', { class: 'stack' });
  root.append(h('h1', null, 'Your booking'), body);

  async function load() {
    try {
      const { booking: b } = await get<{ booking: Booking }>(
        `/api/bookings/${id}${key ? `?k=${encodeURIComponent(key)}` : ''}`,
      );
      draw(b);
    } catch (e) {
      body.replaceChildren(
        h(
          'p',
          { class: 'notice bad', role: 'alert' },
          e instanceof ApiError && e.status === 404
            ? 'We could not find that booking on this device. Open the link you were sent.'
            : 'Could not load the booking.',
        ),
      );
    }
  }

  function draw(b: Booking) {
    const nodes: Node[] = [];
    const chip = b.status === 'confirmed' ? 'ok' : b.status === 'pending_payment' ? 'warn' : 'bad';
    nodes.push(
      h(
        'div',
        { class: 'card stack' },
        h(
          'div',
          { class: 'row between' },
          h('h2', null, `${b.customerName}`),
          h('span', { class: `chip ${chip}` }, b.status.replace('_', ' ')),
        ),
        h('div', { class: 'total' }, h('span', null, 'Total'), h('span', { class: 'mono' }, kes(b.totalKes))),
        b.payment?.receipt
          ? h('p', { class: 'muted mono' }, `M-Pesa receipt ${b.payment.receipt} (sample)`)
          : null,
      ),
    );
    if (b.refund) {
      nodes.push(
        h(
          'p',
          { class: 'notice warn', role: 'status' },
          `Refund ${b.refund.status === 'processed' ? 'sent' : 'recorded'}: ${kes(b.refund.amountKes)} because ${REASONS[b.refund.reason] ?? b.refund.reason}.`,
        ),
      );
    }
    if (b.tickets.length) {
      nodes.push(
        h('h2', null, plural(b.tickets.length, 'ticket')),
        h(
          'ul',
          { class: 'dep-list' },
          ...b.tickets.map((t) =>
            h(
              'li',
              null,
              h(
                'a',
                { href: t.link, 'data-link': '' },
                h('span', null, `Seat ${t.seatLabel} · ${t.holderName}`),
                h('span', { class: 'left' }, t.status),
              ),
            ),
          ),
        ),
      );
    }
    if (b.status === 'confirmed') {
      nodes.push(
        h(
          'button',
          { class: 'btn danger', type: 'button', onClick: () => void cancel() },
          'Cancel booking and refund',
        ),
        h(
          'p',
          { class: 'hint' },
          'Cancelling voids every ticket on this booking, frees the seats and refunds the full amount. Not possible after a ticket has been used.',
        ),
      );
    }
    nodes.push(h('a', { class: 'btn quiet', href: '/', 'data-link': '' }, 'Back to events'));
    body.replaceChildren(...nodes);
  }

  async function cancel() {
    if (!confirm('Cancel this booking? All its tickets stop working and the money is refunded.')) return;
    try {
      await post(`/api/bookings/${id}/cancel`);
      await load();
    } catch (e) {
      body.prepend(
        h(
          'p',
          { class: 'notice bad', role: 'alert' },
          e instanceof ApiError ? e.message : 'No connection. Try again.',
        ),
      );
    }
  }

  await load();
  return { title: 'Booking', el: root };
}
