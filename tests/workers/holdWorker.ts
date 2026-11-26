import { parentPort, workerData } from 'node:worker_threads';
import { Bus } from '../../src/server/bus.ts';
import { systemClock } from '../../src/server/clock.ts';
import { loadConfig } from '../../src/server/config.ts';
import { openDb } from '../../src/server/db.ts';
import { AppError } from '../../src/server/errors.ts';
import { createHold } from '../../src/server/inventory.ts';
import { MockMpesaProvider } from '../../src/server/payments/mockMpesa.ts';
import { TicketKeys } from '../../src/server/ticketKeys.ts';

/** Its own SQLite connection to the shared file: a separate writer, like a second server process. */
const { path, departureId, attempts, seatIds, id } = workerData as {
  path: string;
  departureId: string;
  attempts: number;
  seatIds: string[];
  id: number;
};
const config = loadConfig({});
const ctx = {
  db: openDb(path),
  clock: systemClock,
  config,
  bus: new Bus(),
  keys: TicketKeys.generate(),
  payments: new MockMpesaProvider({ secret: 'x'.repeat(12), timeoutMs: 1000 }),
};

let won = 0;
let lost = 0;
for (let i = 0; i < attempts; i += 1) {
  try {
    createHold(ctx, { departureId, sessionId: `w${id}-${i}`, seatIds });
    won += 1;
  } catch (e) {
    if (e instanceof AppError && e.code === 'seat_unavailable') lost += 1;
    else throw e;
  }
}
ctx.db.close();
parentPort!.postMessage({ won, lost });
