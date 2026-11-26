import { Bus } from './bus.ts';
import { systemClock, type Clock } from './clock.ts';
import type { Config } from './config.ts';
import type { Ctx } from './context.ts';
import { openDb, type DB } from './db.ts';
import { createApp } from './http/app.ts';
import { SIGNATURE_HEADER } from './paymentCallbacks.ts';
import { MockMpesaProvider, type StkOutcome } from './payments/mockMpesa.ts';
import { TicketKeys } from './ticketKeys.ts';

export interface Overrides {
  db?: DB;
  clock?: Clock;
  keys?: TicketKeys;
  autoOutcome?: StkOutcome | null;
}

/** Wires the database, clock, signing keys, mock payment provider and HTTP app together. */
export function bootstrap(config: Config, o: Overrides = {}) {
  const db = o.db ?? openDb(config.databasePath);
  const mock = new MockMpesaProvider({
    secret: config.callbackSecret,
    timeoutMs: config.mockStkTimeoutMs,
    autoOutcome: o.autoOutcome ?? null,
  });
  const ctx: Ctx = {
    db,
    clock: o.clock ?? systemClock,
    config,
    bus: new Bus(),
    keys: o.keys ?? TicketKeys.loadOrCreate(config.ticketKeyPath),
    payments: mock,
  };
  const app = createApp(ctx, mock);
  // The mock provider "calls the webhook" by sending a signed request through the real route.
  mock.setDeliver(async (body, signature) => {
    const res = await app.request('/api/webhooks/mpesa', {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: signature },
    });
    if (!res.ok) console.error('mock webhook delivery rejected', res.status, await res.text());
  });
  return { ctx, app, mock };
}
