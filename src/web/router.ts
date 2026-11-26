export interface Page {
  title: string;
  el: HTMLElement;
  /** Called when the page is replaced: stop timers, close streams. */
  destroy?: () => void;
}

export interface RouteCtx {
  params: Record<string, string>;
  query: URLSearchParams;
}

type Loader = (ctx: RouteCtx) => Promise<Page> | Page;
interface Route {
  re: RegExp;
  keys: string[];
  load: Loader;
}

const routes: Route[] = [];
let current: Page | null = null;
let outlet: HTMLElement;
let token = 0;

export function route(pattern: string, load: Loader) {
  const keys: string[] = [];
  const src = pattern.replace(/:([a-z]+)/g, (_m, k: string) => {
    keys.push(k);
    return '([^/]+)';
  });
  routes.push({ re: new RegExp(`^${src}/?$`), keys, load });
}

export function navigate(path: string, replace = false) {
  if (replace) history.replaceState(null, '', path);
  else history.pushState(null, '', path);
  void render();
}

export async function render() {
  const my = ++token;
  const url = new URL(location.href);
  let page: Page | null = null;
  for (const r of routes) {
    const m = r.re.exec(url.pathname);
    if (!m) continue;
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1] ?? '')]));
    page = await r.load({ params, query: url.searchParams });
    break;
  }
  if (my !== token) {
    page?.destroy?.(); // a newer navigation won the race
    return;
  }
  current?.destroy?.();
  current = page;
  outlet.replaceChildren();
  if (page) {
    outlet.append(page.el);
    document.title = `${page.title} · Tiketi`;
    const heading = page.el.querySelector<HTMLElement>('h1');
    if (heading) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
  }
  window.scrollTo(0, 0);
}

export function start(el: HTMLElement) {
  outlet = el;
  document.addEventListener('click', (e) => {
    const a = (e.target as Element | null)?.closest('a[data-link]');
    if (
      !(a instanceof HTMLAnchorElement) ||
      e.defaultPrevented ||
      e.button !== 0 ||
      e.metaKey ||
      e.ctrlKey ||
      e.shiftKey
    )
      return;
    e.preventDefault();
    navigate(a.getAttribute('href') ?? '/');
  });
  window.addEventListener('popstate', () => void render());
  void render();
}
