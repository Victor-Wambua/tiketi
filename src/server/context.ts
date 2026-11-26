import type { Bus } from './bus.ts';
import type { Clock } from './clock.ts';
import type { Config } from './config.ts';
import type { DB } from './db.ts';
import type { PaymentProvider } from './payments/provider.ts';
import type { TicketKeys } from './ticketKeys.ts';

/** Everything a service needs; passed explicitly so tests can swap the clock, DB and provider. */
export interface Ctx {
  db: DB;
  clock: Clock;
  config: Config;
  bus: Bus;
  keys: TicketKeys;
  payments: PaymentProvider;
}
