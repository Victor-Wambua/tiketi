import { z } from 'zod';

const Env = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  DATABASE_PATH: z.string().default('data/tiketi.db'),
  TICKET_KEY_PATH: z.string().default('data/ticket-key.pem'),
  MPESA_CALLBACK_SECRET: z.string().min(8).default('dev-only-callback-secret'),
  HOLD_TTL_SECONDS: z.coerce.number().int().min(5).default(600),
  MOCK_STK_TIMEOUT_SECONDS: z.coerce.number().int().min(1).default(60),
  MOCK_PAYMENTS: z.enum(['0', '1']).default('1'),
});

export interface Config {
  port: number;
  databasePath: string;
  ticketKeyPath: string;
  callbackSecret: string;
  holdTtlMs: number;
  /** A hold may be extended once, by this much. */
  holdExtensionMs: number;
  /** A hold can never live longer than this in total. */
  holdMaxLifetimeMs: number;
  maxSeatsPerHold: number;
  /** Minimum time a hold is kept alive once a payment prompt is sent. */
  paymentGraceMs: number;
  mockStkTimeoutMs: number;
  mockPayments: boolean;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const e = Env.parse(env);
  return {
    port: e.PORT,
    databasePath: e.DATABASE_PATH,
    ticketKeyPath: e.TICKET_KEY_PATH,
    callbackSecret: e.MPESA_CALLBACK_SECRET,
    holdTtlMs: e.HOLD_TTL_SECONDS * 1000,
    holdExtensionMs: 5 * 60_000,
    holdMaxLifetimeMs: Math.max(e.HOLD_TTL_SECONDS * 1000, 15 * 60_000),
    maxSeatsPerHold: 6,
    paymentGraceMs: e.MOCK_STK_TIMEOUT_SECONDS * 1000 + 30_000,
    mockStkTimeoutMs: e.MOCK_STK_TIMEOUT_SECONDS * 1000,
    mockPayments: e.MOCK_PAYMENTS === '1',
  };
}
