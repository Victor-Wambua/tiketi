import type { Hono } from 'hono';
import { bootstrap } from '../../src/server/bootstrap.ts';
import type { Clock } from '../../src/server/clock.ts';
import { loadConfig } from '../../src/server/config.ts';
import type { Ctx } from '../../src/server/context.ts';
import { all } from '../../src/server/db.ts';
import { expireDueHolds, startSweeper } from '../../src/server/inventory.ts';
import type { MockMpesaProvider } from '../../src/server/payments/mockMpesa.ts';
import { seed } from '../../src/server/seed.ts';
import { RESPONSE_HEADER, REQUEST_HEADER } from './shims/cookie.ts';

/** The real clock plus an offset, so "skip ahead" can make holds expire without a ten-minute wait. */
export class DemoClock implements Clock {
  offsetMs = 0;
  now(): number {
    return Date.now() + this.offsetMs;
  }
}

/** One simulated browser: it has its own cookies, so it is a different shopper (session) to the server. */
export class Client {
  readonly cookies = new Map<string, string>();
  constructor(readonly id: string) {}
}

export interface Runtime {
  ctx: Ctx;
  app: Hono;
  mock: MockMpesaProvider;
  clock: DemoClock;
  client(id: string): Client;
  /** Sends a request to the real Hono app as `client`, the way a browser would send it to a server. */
  request(client: Client, input: string | URL | Request, init?: RequestInit): Promise<Response>;
  /** Moves the demo clock forward and lets the server notice expired holds. */
  skipAhead(ms: number): number;
}

const DB_PATH = 'demo.db';
const KEY_PATH = 'demo.key';
const ORIGIN = 'http://tiketi.demo';

export async function startRuntime(log: (line: string) => void = () => undefined): Promise<Runtime> {
  // Runs the repo's own seed script: events, departures, staff, purchases through the real services.
  await seed(DB_PATH, KEY_PATH, log);

  const clock = new DemoClock();
  const config = { ...loadConfig({}), databasePath: DB_PATH, ticketKeyPath: KEY_PATH };
  const { ctx, app, mock } = bootstrap(config, { clock });
  startSweeper(ctx);

  const clients = new Map<string, Client>();
  const client = (id: string) => {
    let c = clients.get(id);
    if (!c) clients.set(id, (c = new Client(id)));
    return c;
  };

  async function request(c: Client, input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const source = input instanceof Request ? input : new Request(new URL(String(input), ORIGIN), init);
    const url = new URL(source.url, ORIGIN);
    const method = source.method.toUpperCase();
    const headers = new Headers(source.headers);
    headers.set(REQUEST_HEADER, [...c.cookies].map(([k, v]) => `${k}=${v}`).join('; '));
    const body = method === 'GET' || method === 'HEAD' ? undefined : await source.text();
    const res = await app.fetch(
      new Request(new URL(url.pathname + url.search, ORIGIN), {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        signal: source.signal,
      }),
    );
    const set = res.headers.get(RESPONSE_HEADER);
    if (set) {
      for (const ck of JSON.parse(`[${set}]`) as { name: string; value: string; maxAge: number | null }[]) {
        if (ck.maxAge === 0) c.cookies.delete(ck.name);
        else c.cookies.set(ck.name, ck.value);
      }
    }
    return res;
  }

  function skipAhead(ms: number): number {
    clock.offsetMs += ms;
    expireDueHolds(ctx);
    // Open pages refetch seat state when told a departure changed; this also refreshes their countdowns.
    for (const d of all<{ id: string }>(ctx.db, `SELECT id FROM departures`)) ctx.bus.publish(d.id);
    return clock.offsetMs;
  }

  return { ctx, app: app as unknown as Hono, mock, clock, client, request, skipAhead };
}
