import { relative, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getCookie } from 'hono/cookie';
import { streamSSE } from 'hono/streaming';
import { z, ZodError } from 'zod';
import { dashboard, exportCsv } from '../admin.ts';
import { destroySession, login } from '../auth.ts';
import { bookingView, cancelBooking, checkout, getBookingFor, processRefund } from '../bookings.ts';
import { getDeparture, listEvents } from '../catalog.ts';
import type { Ctx } from '../context.ts';
import { all } from '../db.ts';
import { AppError, notFound } from '../errors.ts';
import { gateDepartures, gateManifest, processScan } from '../gate.ts';
import { createHold, extendHold, getHoldFor, holdView, releaseHold, seatStates } from '../inventory.ts';
import { handleMpesaCallback, SIGNATURE_HEADER } from '../paymentCallbacks.ts';
import type { MockMpesaProvider, StkOutcome } from '../payments/mockMpesa.ts';
import { getTicketByLink, transferTicket } from '../tickets.ts';
import {
  clearSessionCookie,
  COOKIE,
  ensureSession,
  idempotency,
  requireRole,
  securityHeaders,
  sessionMiddleware,
  setSessionCookie,
  type Env,
} from './middleware.ts';

const DIST = fileURLToPath(new URL('../../../dist/web/', import.meta.url));

const HoldBody = z.object({
  departureId: z.string().min(1).max(60),
  seatIds: z.array(z.string().min(1).max(12)).min(1).max(12),
});
const CheckoutBody = z.object({ name: z.string().max(120), phone: z.string().max(30) });
const TransferBody = z.object({ newHolderName: z.string().max(120) });
const LoginBody = z.object({ username: z.string().min(1).max(60), password: z.string().min(1).max(200) });
const ScanBody = z.object({
  code: z.string().min(1).max(300),
  gate: z.string().trim().min(1).max(40),
  departureId: z.string().max(60).optional(),
  clientScanId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{8,64}$/)
    .optional(),
  scannedAt: z.number().int().positive().optional(),
  offline: z.boolean().optional(),
});
const BatchBody = z.object({ scans: z.array(ScanBody).min(1).max(500) });

export function createApp(ctx: Ctx, mock?: MockMpesaProvider) {
  const app = new Hono<Env>();

  app.use('*', securityHeaders);
  app.use(
    '/api/*',
    bodyLimit({
      maxSize: 64 * 1024,
      onError: () => {
        throw new AppError(413, 'too_large', 'Request body too large');
      },
    }),
  );
  app.use('/api/*', sessionMiddleware(ctx));
  app.use('/api/*', idempotency(ctx));

  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(
        { error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } },
        err.status as 400,
      );
    }
    if (err instanceof ZodError) {
      return c.json(
        {
          error: {
            code: 'validation_error',
            message: 'Some fields are invalid',
            details: { issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
          },
        },
        400,
      );
    }
    if (err instanceof SyntaxError)
      return c.json({ error: { code: 'bad_json', message: 'Body must be valid JSON' } }, 400);
    console.error(err);
    return c.json({ error: { code: 'internal_error', message: 'Something went wrong on our side' } }, 500);
  });

  const sid = (c: Parameters<typeof ensureSession>[1]) => ensureSession(ctx, c).id;

  // ---- public catalogue -------------------------------------------------------------------
  app.get('/api/health', (c) => c.json({ ok: true }));
  app.get('/api/events', (c) => c.json({ events: listEvents(ctx) }));
  app.get('/api/public-key', (c) => c.json({ alg: 'Ed25519', publicKey: ctx.keys.publicKeyB64url }));
  app.get('/api/departures/:id', (c) => c.json(getDeparture(ctx, c.req.param('id'))));
  app.get('/api/departures/:id/seats', (c) => {
    const id = c.req.param('id');
    getDeparture(ctx, id);
    return c.json(seatStates(ctx, id, c.get('session')?.id ?? null));
  });
  app.get('/api/departures/:id/stream', (c) => {
    const id = c.req.param('id');
    getDeparture(ctx, id);
    return streamSSE(c, async (stream) => {
      let alive = true;
      stream.onAbort(() => {
        alive = false;
      });
      const unsub = ctx.bus.subscribe(
        id,
        (v) => void stream.writeSSE({ event: 'seats', data: String(v) }).catch(() => undefined),
      );
      await stream.writeSSE({ event: 'hello', data: String(ctx.bus.version(id)) });
      while (alive) {
        await stream.sleep(15_000);
        if (alive) await stream.writeSSE({ event: 'ping', data: '1' });
      }
      unsub();
    });
  });

  // ---- holds ------------------------------------------------------------------------------
  app.post('/api/holds', async (c) => {
    const body = HoldBody.parse(await c.req.json());
    const hold = createHold(ctx, { departureId: body.departureId, sessionId: sid(c), seatIds: body.seatIds });
    return c.json({ hold }, 201);
  });
  app.get('/api/holds/:id', (c) => {
    const s = c.get('session');
    return c.json({ hold: holdView(ctx, getHoldFor(ctx, c.req.param('id'), s?.id ?? '')) });
  });
  app.post('/api/holds/:id/extend', (c) =>
    c.json({ hold: extendHold(ctx, { holdId: c.req.param('id'), sessionId: sid(c) }) }),
  );
  app.delete('/api/holds/:id', (c) => {
    releaseHold(ctx, { holdId: c.req.param('id'), sessionId: sid(c) });
    return c.json({ released: true });
  });
  app.post('/api/holds/:id/checkout', async (c) => {
    const body = CheckoutBody.parse(await c.req.json());
    const booking = await checkout(ctx, {
      holdId: c.req.param('id'),
      sessionId: sid(c),
      name: body.name,
      phone: body.phone,
    });
    return c.json({ booking }, 201);
  });

  // ---- bookings and tickets ---------------------------------------------------------------
  app.get('/api/bookings/:id', (c) => {
    const b = getBookingFor(ctx, c.req.param('id'), {
      sessionId: c.get('session')?.id ?? null,
      token: c.req.query('k') ?? null,
    });
    return c.json({ booking: bookingView(ctx, b) });
  });
  app.post('/api/bookings/:id/cancel', async (c) =>
    c.json({ booking: await cancelBooking(ctx, { bookingId: c.req.param('id'), sessionId: sid(c) }) }),
  );
  app.get('/api/tickets/:id', (c) =>
    c.json({ ticket: getTicketByLink(ctx, c.req.param('id'), c.req.query('k') ?? '') }),
  );
  app.post('/api/tickets/:id/transfer', async (c) => {
    const body = TransferBody.parse(await c.req.json());
    return c.json({
      ticket: transferTicket(ctx, {
        ticketId: c.req.param('id'),
        sessionId: sid(c),
        newHolderName: body.newHolderName,
      }),
    });
  });

  // ---- payments ---------------------------------------------------------------------------
  app.post('/api/webhooks/mpesa', async (c) => {
    const raw = await c.req.text();
    const result = handleMpesaCallback(ctx, raw, c.req.header(SIGNATURE_HEADER));
    return c.json({ ResultCode: 0, ResultDesc: 'Accepted', outcome: result.outcome });
  });

  if (mock && ctx.config.mockPayments) {
    app.get('/api/mock/stk', (c) => c.json({ prompts: mock.pending(c.req.query('phone') ?? undefined) }));
    app.post('/api/mock/stk/:ref/resolve', async (c) => {
      const { outcome } = z
        .object({ outcome: z.enum(['success', 'cancelled', 'insufficient_funds', 'timeout']) })
        .parse(await c.req.json());
      const done = await mock.resolve(c.req.param('ref'), outcome as StkOutcome);
      if (!done) throw notFound('That prompt is no longer on the phone');
      return c.json({ resolved: true });
    });
  }

  // ---- staff auth -------------------------------------------------------------------------
  app.post('/api/auth/login', async (c) => {
    const body = LoginBody.parse(await c.req.json());
    const { session, user } = await login(ctx, body.username, body.password);
    destroySession(ctx, getCookie(c, COOKIE));
    setSessionCookie(c, session.token, session.maxAgeMs);
    return c.json({ user });
  });
  app.post('/api/auth/logout', (c) => {
    destroySession(ctx, getCookie(c, COOKIE));
    clearSessionCookie(c);
    return c.json({ ok: true });
  });
  app.get('/api/auth/me', (c) => {
    const s = c.get('session');
    return c.json({
      user: s?.role ? { username: s.username, role: s.role, displayName: s.displayName } : null,
    });
  });

  // ---- gate staff -------------------------------------------------------------------------
  const gateRoles = requireRole('gate', 'organiser');
  app.get('/api/gate/config', gateRoles, (c) =>
    c.json({ publicKey: ctx.keys.publicKeyB64url, departures: gateDepartures(ctx) }),
  );
  app.get('/api/gate/manifest/:departureId', gateRoles, (c) =>
    c.json(gateManifest(ctx, c.req.param('departureId'))),
  );
  app.post('/api/gate/scans', gateRoles, async (c) => {
    const b = ScanBody.parse(await c.req.json());
    const result = processScan(ctx, {
      code: b.code,
      gate: b.gate,
      staffId: c.get('session')!.userId,
      departureId: b.departureId,
      clientScanId: b.clientScanId,
      clientScannedAt: b.scannedAt,
      offline: b.offline,
    });
    return c.json({ scan: result });
  });
  app.post('/api/gate/scans/batch', gateRoles, async (c) => {
    const { scans } = BatchBody.parse(await c.req.json());
    const ordered = [...scans].sort((a, b) => (a.scannedAt ?? 0) - (b.scannedAt ?? 0));
    const results = ordered.map((b) => ({
      clientScanId: b.clientScanId ?? null,
      scan: processScan(ctx, {
        code: b.code,
        gate: b.gate,
        staffId: c.get('session')!.userId,
        departureId: b.departureId,
        clientScanId: b.clientScanId,
        clientScannedAt: b.scannedAt,
        offline: true,
      }),
    }));
    return c.json({ results });
  });

  // ---- organiser --------------------------------------------------------------------------
  const organiser = requireRole('organiser');
  app.get('/api/admin/departures', organiser, (c) =>
    c.json({
      departures: all<{ id: string; starts_at: number; title: string }>(
        ctx.db,
        `SELECT d.id, d.starts_at, e.title FROM departures d JOIN events e ON e.id = d.event_id ORDER BY d.starts_at`,
      ).map((d) => ({ id: d.id, startsAt: d.starts_at, title: d.title })),
    }),
  );
  app.get('/api/admin/departures/:id/dashboard', organiser, (c) => c.json(dashboard(ctx, c.req.param('id'))));
  app.get('/api/admin/departures/:id/export.csv', organiser, (c) => {
    const csv = exportCsv(ctx, c.req.param('id'));
    return c.body(csv, 200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="tiketi-${c.req.param('id')}.csv"`,
    });
  });
  app.post('/api/admin/refunds/:id/process', organiser, async (c) =>
    c.json({
      refund: await processRefund(ctx, c.req.param('id'), c.get('session')!.username ?? 'organiser'),
    }),
  );

  app.all('/api/*', () => {
    throw notFound('No such endpoint');
  });

  // ---- built front-end --------------------------------------------------------------------
  const rel = relative(process.cwd(), resolve(DIST));
  if (existsSync(resolve(DIST, 'index.html'))) app.use('/*', serveStatic({ root: rel }));
  app.get('*', async (c) => {
    if (!existsSync(resolve(DIST, 'index.html'))) {
      return c.text('The front-end is not built yet. Run: npm run build', 503);
    }
    const res = await serveStatic({ path: `${rel}/index.html` })(c, async () => undefined);
    return res ?? c.text('Not found', 404);
  });

  return app;
}
