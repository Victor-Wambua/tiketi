import { ApiError, get, post } from '../api.ts';
import { h, trustedSvg } from '../dom.ts';
import { fmtTime, fmtWhen, kes } from '../format.ts';
import type { Page, RouteCtx } from '../router.ts';

interface Ticket {
  id: string;
  bookingId: string;
  eventTitle: string;
  venue: string;
  kind: 'event' | 'trip';
  startsAt: number;
  seatLabel: string;
  section: string;
  rowLabel: string;
  tier: string;
  priceKes: number;
  holderName: string;
  version: number;
  status: 'valid' | 'void' | 'used';
  voidReason: string | null;
  admittedAt: number | null;
  admittedGate: string | null;
  code: string;
  qrSvg: string;
  link: string;
}

function summary(t: Ticket): string {
  if (t.status === 'void') return 'This ticket was cancelled or refunded and can no longer be used.';
  if (t.status === 'used') {
    return `This ticket was used at ${t.admittedAt ? fmtTime(t.admittedAt) : 'the gate'}${t.admittedGate ? ` at ${t.admittedGate}` : ''}. It cannot be used again.`;
  }
  const where = t.kind === 'trip' ? 'on the' : 'at';
  return `Show this QR code at the gate. It admits ${t.holderName} to seat ${t.seatLabel} ${where} ${t.eventTitle}, ${fmtWhen(t.startsAt)}. It works once. If you transfer it, the old code stops working.`;
}

export async function ticketPage(ctx: RouteCtx): Promise<Page> {
  const id = ctx.params.id ?? '';
  const key = ctx.query.get('k') ?? '';
  const root = h('div', { class: 'page' });
  let ticket: Ticket;
  try {
    ticket = (await get<{ ticket: Ticket }>(`/api/tickets/${id}?k=${encodeURIComponent(key)}`)).ticket;
  } catch (e) {
    const expired = e instanceof ApiError && e.code === 'ticket_link_expired';
    root.append(
      h(
        'div',
        { class: 'ticket-page stack' },
        h('h1', null, expired ? 'This ticket link has expired' : 'Ticket not found'),
        h(
          'p',
          { class: 'notice warn', role: 'alert' },
          expired
            ? 'The ticket was transferred or re-issued. Ask the person who bought it for the new link.'
            : 'Check the link you were sent.',
        ),
      ),
    );
    return { title: 'Ticket', el: root };
  }

  const msg = h('div', { 'aria-live': 'polite' });
  const holder = h('input', {
    id: 'tr-name',
    name: 'holder',
    autocomplete: 'off',
    maxlength: 80,
    required: '',
  });
  const view = h('div', { class: 'ticket-page stack' });

  const render = (t: Ticket) => {
    ticket = t;
    const state = t.status === 'valid' ? 'is-valid' : t.status === 'used' ? 'is-used' : 'is-void';
    const qr = trustedSvg(t.qrSvg);
    view.replaceChildren(
      h(
        'article',
        { class: `ticket-card ticket-big ${state}`, 'aria-labelledby': 'tk-h' },
        h(
          'div',
          { class: 't-head' },
          h('div', { class: 'eyebrow' }, t.kind === 'trip' ? 'Boarding pass' : 'Admit one'),
          h('h1', { id: 'tk-h' }, t.eventTitle),
          h('p', null, `${t.venue}`),
          h('p', { class: 'mono' }, fmtWhen(t.startsAt)),
        ),
        h(
          'div',
          { class: 't-main stack' },
          h(
            'div',
            { class: 'row between' },
            h(
              'div',
              null,
              h('div', { class: 'eyebrow' }, 'Seat'),
              h('div', { class: 'seat-big' }, t.seatLabel),
            ),
            h(
              'span',
              { class: `chip ${t.status === 'valid' ? 'ok' : t.status === 'used' ? 'warn' : 'bad'}` },
              t.status === 'valid' ? 'Valid' : t.status === 'used' ? 'Used' : 'Void',
            ),
          ),
          h(
            'dl',
            { class: 'kv' },
            h('dt', null, 'Holder'),
            h('dd', null, t.holderName),
            h('dt', null, 'Section'),
            h('dd', null, `${t.section}, row ${t.rowLabel}`),
            h('dt', null, 'Tier'),
            h('dd', null, `${t.tier} · ${kes(t.priceKes)}`),
          ),
        ),
        h('div', { class: 't-tear', 'aria-hidden': 'true' }),
        h(
          'div',
          { class: 't-stub stack' },
          h('div', { class: 'qr-box' }, qr),
          h('p', { role: 'status' }, summary(t)),
          h('p', { class: 'code-text', 'aria-label': 'Ticket code' }, t.code),
        ),
      ),
    );
    if (t.status === 'valid') {
      view.append(
        h(
          'form',
          {
            class: 'card stack',
            novalidate: '',
            onSubmit: (e: Event) => {
              e.preventDefault();
              void transfer();
            },
          },
          h('h2', null, 'Transfer this ticket'),
          h(
            'p',
            { class: 'muted' },
            'Gives the seat to someone else under their name. You get a new link and QR; the old ones stop working straight away.',
          ),
          h('div', { class: 'field' }, h('label', { for: 'tr-name' }, 'New holder’s name'), holder),
          h('button', { class: 'btn', type: 'submit' }, 'Transfer ticket'),
          msg,
        ),
        h('a', { class: 'btn quiet', href: `/b/${t.bookingId}`, 'data-link': '' }, 'Booking details'),
      );
    }
  };

  async function transfer() {
    msg.replaceChildren();
    try {
      const r = await post<{ ticket: Ticket }>(`/api/tickets/${ticket.id}/transfer`, {
        newHolderName: holder.value,
      });
      history.replaceState(null, '', r.ticket.link);
      render(r.ticket);
      view.prepend(
        h(
          'p',
          { class: 'notice ok', role: 'status' },
          `Transferred to ${r.ticket.holderName}. This is the new QR; the previous one no longer works. Share this page’s address with them.`,
        ),
      );
    } catch (e) {
      msg.replaceChildren(
        h(
          'p',
          { class: 'notice bad', role: 'alert' },
          e instanceof ApiError
            ? e.status === 403
              ? 'Only the person who bought this ticket can transfer it, from the device they bought it on.'
              : e.message
            : 'No connection. Try again.',
        ),
      );
    }
  }

  render(ticket);
  root.append(view);
  return { title: `Ticket ${ticket.seatLabel}`, el: root };
}
