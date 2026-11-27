import type { Runtime } from './runtime.ts';

const isApi = (input: RequestInfo | URL): boolean => {
  const raw = input instanceof Request ? input.url : String(input);
  const u = new URL(raw, location.href);
  return u.origin === location.origin && u.pathname.startsWith('/api/');
};

/**
 * Makes the page's own front-end talk to the in-page server: `fetch('/api/...')` and
 * `EventSource('/api/.../stream')` are answered by the Hono app's `fetch` handler instead of the network.
 * Every other request (scripts, styles, the WASM file) still goes to the network, i.e. to this site.
 */
export function installApi(rt: Runtime): void {
  const you = rt.client('you');
  const realFetch = window.fetch.bind(window);

  window.fetch = (input, init) =>
    isApi(input) ? rt.request(you, input instanceof URL ? input.href : input, init) : realFetch(input, init);

  class DemoEventSource extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 2;
    readyState = 0;
    readonly withCredentials = false;
    onopen: ((e: Event) => void) | null = null;
    onerror: ((e: Event) => void) | null = null;
    onmessage: ((e: MessageEvent) => void) | null = null;
    private readonly ctl = new AbortController();

    constructor(readonly url: string) {
      super();
      void this.run();
    }

    private emit(e: Event) {
      this.dispatchEvent(e);
      if (e.type === 'open') this.onopen?.(e);
      if (e.type === 'error') this.onerror?.(e);
      if (e.type === 'message') this.onmessage?.(e as MessageEvent);
    }

    private async run() {
      try {
        const res = await rt.request(you, this.url, { signal: this.ctl.signal });
        if (!res.ok || !res.body) throw new Error(`stream failed (${res.status})`);
        this.readyState = 1;
        this.emit(new Event('open'));
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += value;
          let cut: number;
          while ((cut = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, cut);
            buf = buf.slice(cut + 2);
            let event = 'message';
            const data: string[] = [];
            for (const line of block.split('\n')) {
              if (line.startsWith('event:')) event = line.slice(6).trim();
              else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
            }
            if (this.readyState !== 2) this.emit(new MessageEvent(event, { data: data.join('\n') }));
          }
        }
      } catch {
        if (this.readyState !== 2) this.emit(new Event('error'));
      }
    }

    close() {
      this.readyState = 2;
      this.ctl.abort();
    }
  }

  (window as unknown as { EventSource: unknown }).EventSource = DemoEventSource;

  // The organiser dashboard's "Export CSV" is a plain download link; serve it from the in-page server too.
  document.addEventListener(
    'click',
    (e) => {
      const a = (e.target as Element | null)?.closest('a[download]');
      if (!(a instanceof HTMLAnchorElement)) return;
      const href = a.getAttribute('href') ?? '';
      if (!href.startsWith('/api/')) return;
      e.preventDefault();
      void rt.request(you, href).then(async (res) => {
        const url = URL.createObjectURL(await res.blob());
        const tmp = document.createElement('a');
        tmp.href = url;
        tmp.download = (href.split('/').slice(-2, -1)[0] ?? 'tiketi') + '.csv';
        document.body.append(tmp);
        tmp.click();
        tmp.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      });
    },
    true,
  );
}
