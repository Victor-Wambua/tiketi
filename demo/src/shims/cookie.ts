import type { Context } from 'hono';

/**
 * Cookies for the in-page server. A browser will not let a script set a `Cookie` request header or
 * read a `Set-Cookie` response header, so the demo's fetch adapter keeps one cookie jar per
 * simulated client and passes it through these two headers instead. Same names, same options.
 */
export const REQUEST_HEADER = 'x-demo-cookie';
export const RESPONSE_HEADER = 'x-demo-set-cookie';

interface CookieOpts {
  maxAge?: number;
  [key: string]: unknown;
}

export function getCookie(c: Context, key?: string): string | undefined | Record<string, string> {
  const jar: Record<string, string> = {};
  for (const part of (c.req.header(REQUEST_HEADER) ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) jar[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return key === undefined ? jar : jar[key];
}

export function setCookie(c: Context, name: string, value: string, opts: CookieOpts = {}): void {
  c.header(RESPONSE_HEADER, JSON.stringify({ name, value, maxAge: opts.maxAge ?? null }), { append: true });
}

export function deleteCookie(c: Context, name: string, _opts?: CookieOpts): string | undefined {
  c.header(RESPONSE_HEADER, JSON.stringify({ name, value: '', maxAge: 0 }), { append: true });
  return undefined;
}
