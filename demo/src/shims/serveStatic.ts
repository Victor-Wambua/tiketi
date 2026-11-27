import type { MiddlewareHandler } from 'hono';

/** The demo has no files to serve: the page itself is the front-end. */
export const serveStatic =
  (_opts?: unknown): MiddlewareHandler =>
  async (_c, next) => {
    await next();
  };
