/**
 * Where routes live in the address bar. The normal build uses plain paths (`/d/abc`). A static
 * host with no server-side fallback (the GitHub Pages demo) builds with VITE_ROUTING=hash, so the
 * same routes live after a `#` (`/#/d/abc`) and deep links survive a reload.
 */
export const HASH_ROUTING = import.meta.env.VITE_ROUTING === 'hash';

/** The route (path and query) that the address bar currently points at. */
export function currentUrl(): URL {
  if (!HASH_ROUTING) return new URL(location.href);
  const route = location.hash.replace(/^#/, '');
  return new URL(route.startsWith('/') ? route : `/${route}`, location.origin);
}

/** The value for an `href` or `history` call that points at a route such as `/d/abc?x=1`. */
export const hrefFor = (route: string): string => (HASH_ROUTING ? `#${route}` : route);

/** The reverse of `hrefFor`: turns an `href` attribute back into a route. */
export const routeOf = (href: string): string =>
  HASH_ROUTING && href.startsWith('#') ? href.slice(1) || '/' : href;
