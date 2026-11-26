import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { Agent } from 'undici';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import type { Hono } from 'hono';
import { createUser } from '../src/server/auth.ts';
import { bootstrap } from '../src/server/bootstrap.ts';
import { createDeparture, createEvent, saveLayout } from '../src/server/catalog.ts';
import { FakeClock } from '../src/server/clock.ts';
import { loadConfig } from '../src/server/config.ts';
import { openDb } from '../src/server/db.ts';
import { loadShippedLayouts } from '../src/server/layouts.ts';
import { SIGNATURE_HEADER } from '../src/server/paymentCallbacks.ts';
import { buildCallbackBody, signCallback, type StkOutcome } from '../src/server/payments/mockMpesa.ts';
import { TicketKeys } from '../src/server/ticketKeys.ts';

export const DEP = 'dep-test';
export const HOUR = 3600_000;
export const MIN = 60_000;

export type Env = ReturnType<typeof makeEnv>;

/** A fresh in-memory system with one 14-seat matatu departure two days after the fake "now". */
export function makeEnv(opts: { layoutId?: string; config?: Partial<ReturnType<typeof loadConfig>> } = {}) {
  const clock = new FakeClock();
  const config = { ...loadConfig({}), databasePath: ':memory:', ...opts.config };
  const { ctx, app, mock } = bootstrap(config, {
    db: openDb(':memory:'),
    clock,
    keys: TicketKeys.generate(),
  });
  const layouts = loadShippedLayouts();
  for (const l of layouts) saveLayout(ctx, l);
  const layoutId = opts.layoutId ?? 'matatu-14';
  createEvent(ctx, {
    id: 'evt-test',
    title: 'Test trip',
    kind: 'trip',
    description: '',
    venue: 'A to B',
    layoutId,
  });
  createDeparture(ctx, { id: DEP, eventId: 'evt-test', startsAt: clock.now() + 48 * HOUR });
  return { ctx, app, mock, clock, layouts };
}

export interface Reply<T = any> {
  status: number;
  json: T;
  headers: Headers;
}

/** A browser-like HTTP client with its own cookie jar. `base` is an app (in-process) or a URL. */
export class Client {
  private cookie = '';
  constructor(
    private readonly base: Hono<any> | string,
    private readonly dispatcher?: Agent,
  ) {}

  async call<T = any>(
    method: string,
    path: string,
    body?: unknown,
    opts: { key?: string | null; headers?: Record<string, string>; raw?: string } = {},
  ): Promise<Reply<T>> {
    const headers: Record<string, string> = { ...opts.headers };
    if (this.cookie) headers.cookie = this.cookie;
    if (body !== undefined || opts.raw !== undefined) headers['content-type'] = 'application/json';
    if (method !== 'GET' && opts.key !== null) headers['idempotency-key'] = opts.key ?? randomUUID();
    const init: RequestInit & { dispatcher?: Agent } = { method, headers };
    if (this.dispatcher) init.dispatcher = this.dispatcher;
    if (opts.raw !== undefined) init.body = opts.raw;
    else if (body !== undefined) init.body = JSON.stringify(body);
    const res =
      typeof this.base === 'string'
        ? await fetch(this.base + path, init)
        : await this.base.request(path, init);
    const set = res.headers.getSetCookie();
    for (const c of set) {
      const pair = c.split(';')[0]!;
      if (pair.startsWith('tk_sid=') && pair !== 'tk_sid=') this.cookie = pair;
      if (c.startsWith('tk_sid=;')) this.cookie = '';
    }
    const text = await res.text();
    let json: any;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, json, headers: res.headers };
  }

  get = <T = any>(path: string) => this.call<T>('GET', path);
  post = <T = any>(path: string, body?: unknown, opts?: Parameters<Client['call']>[3]) =>
    this.call<T>('POST', path, body ?? {}, opts);
  del = <T = any>(path: string) => this.call<T>('DELETE', path);

  async login(username: string, password: string) {
    return this.call('POST', '/api/auth/login', { username, password }, { key: null });
  }
}

export async function addStaff(env: Env) {
  await createUser(env.ctx, {
    username: 'boss',
    password: 'organiser-test-pass',
    role: 'organiser',
    displayName: 'Boss',
  });
  await createUser(env.ctx, {
    username: 'gatey',
    password: 'gate-test-pass',
    role: 'gate',
    displayName: 'Gate',
  });
}

export async function staffClient(env: Env, who: 'boss' | 'gatey') {
  const c = new Client(env.app);
  const r = await c.login(who, who === 'boss' ? 'organiser-test-pass' : 'gate-test-pass');
  if (r.status !== 200) throw new Error(`login failed ${r.status}`);
  return c;
}

/** Hold + checkout for one customer. Returns ids; the STK prompt is left pending on the mock phone. */
export async function startPurchase(
  env: Env,
  client: Client,
  seatIds: string[],
  phone = '0700 000 001',
  departureId = DEP,
) {
  const h = await client.post('/api/holds', { departureId, seatIds });
  if (h.status !== 201) throw new Error(`hold failed: ${h.status} ${JSON.stringify(h.json)}`);
  const c = await client.post(`/api/holds/${h.json.hold.id}/checkout`, { name: 'Test Buyer', phone });
  if (c.status !== 201) throw new Error(`checkout failed: ${c.status} ${JSON.stringify(c.json)}`);
  return {
    holdId: h.json.hold.id as string,
    bookingId: c.json.booking.id as string,
    providerRef: c.json.booking.payment.providerRef as string,
  };
}

export async function deliverCallback(
  env: Env,
  providerRef: string,
  outcome: StkOutcome,
  opts: { amountKes?: number; receipt?: string; secret?: string; phone?: string } = {},
) {
  const body = buildCallbackBody(
    { providerRef, phone: opts.phone ?? '254700000001', amountKes: opts.amountKes ?? 0 },
    outcome,
    opts.receipt ? { receipt: opts.receipt } : {},
  );
  const sig = signCallback(opts.secret ?? env.ctx.config.callbackSecret, body);
  return env.app.request('/api/webhooks/mpesa', {
    method: 'POST',
    body,
    headers: { [SIGNATURE_HEADER]: sig, 'content-type': 'application/json' },
  });
}

/** Pay a purchase through the mock phone (signed callback via the real route). */
export async function pay(env: Env, providerRef: string, outcome: StkOutcome = 'success') {
  return env.mock.resolve(providerRef, outcome);
}

export async function startServer(app: Hono<any>) {
  const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }) as Server;
  await new Promise<void>((r) => server.once('listening', () => r()));
  const port = (server.address() as AddressInfo).port;
  // macOS caps the listen backlog at 128, so a 100-socket pool keeps big bursts from being reset.
  const agent = new Agent({ connections: 100, pipelining: 1 });
  return {
    url: `http://127.0.0.1:${port}`,
    client: () => new Client(`http://127.0.0.1:${port}`, agent),
    close: () =>
      new Promise<void>((r) => {
        void agent.close();
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

/** Buys seats end to end (hold, checkout, signed success callback) and returns the booking view. */
export async function buy(env: Env, client: Client, seatIds: string[], departureId = DEP) {
  const p = await startPurchase(env, client, seatIds, '0700 000 001', departureId);
  await pay(env, p.providerRef);
  const r = await client.get(`/api/bookings/${p.bookingId}`);
  const tickets = await Promise.all(
    r.json.booking.tickets.map(
      async (t: { link: string }) =>
        (await new Client(env.app).get(t.link.replace('/t/', '/api/tickets/'))).json.ticket,
    ),
  );
  return {
    ...p,
    booking: r.json.booking,
    tickets: tickets as { id: string; code: string; seatLabel: string; version: number; link: string }[],
  };
}
