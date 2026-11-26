type Child = Node | string | number | null | undefined | false;
type Props = Record<string, unknown> | null;

function apply(el: Element, props: Props) {
  if (!props) return;
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.setAttribute('class', String(value));
    else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key === 'value' && 'value' in el) (el as HTMLInputElement).value = String(value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
}

function append(el: Element, children: Child[]) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/** Builds an element. Text children are always inserted as text, never parsed as HTML. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Props,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  apply(el, props ?? null);
  append(el, children);
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
export function s<K extends keyof SVGElementTagNameMap>(
  tag: K,
  props?: Props,
  ...children: Child[]
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  apply(el, props ?? null);
  append(el, children);
  return el;
}

/** Inserts markup that this app itself generated (the server-rendered QR SVG). */
export function trustedSvg(markup: string): Element {
  const doc = new DOMParser().parseFromString(markup, 'image/svg+xml');
  return document.importNode(doc.documentElement, true);
}

export function clear(el: Element) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function announce(message: string) {
  const live = document.getElementById('live');
  if (!live) return;
  live.textContent = '';
  // A tick later so repeated identical messages are still read out.
  setTimeout(() => {
    live.textContent = message;
  }, 30);
}
