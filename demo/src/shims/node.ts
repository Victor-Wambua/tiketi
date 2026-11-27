/**
 * Stand-ins for the handful of Node built-ins the server imports. The server only touches the
 * file system to serve the built front-end and to load keys and layouts; the demo does none of that.
 */
export const existsSync = (_path: string): boolean => false;
export const mkdirSync = (_path: string, _opts?: unknown): void => undefined;
export const rmSync = (_path: string): void => undefined;

export const resolve = (...parts: string[]): string => parts.join('/');
export const relative = (_from: string, _to: string): string => '';
export const dirname = (p: string): string => p.replace(/\/[^/]*$/, '') || '.';

export const fileURLToPath = (u: string | URL): string => (typeof u === 'string' ? u : u.pathname);

type Listener = (...args: unknown[]) => void;

export class EventEmitter {
  private readonly listeners = new Map<string, Set<Listener>>();
  setMaxListeners(_n: number): this {
    return this;
  }
  on(event: string, cb: Listener): this {
    const set = this.listeners.get(event) ?? new Set<Listener>();
    set.add(cb);
    this.listeners.set(event, set);
    return this;
  }
  off(event: string, cb: Listener): this {
    this.listeners.get(event)?.delete(cb);
    return this;
  }
  emit(event: string, ...args: unknown[]): boolean {
    const set = this.listeners.get(event);
    if (!set?.size) return false;
    for (const cb of [...set]) cb(...args);
    return true;
  }
}

/** `util.promisify` for Node-style `(…args, cb)` functions. */
export function promisify<A extends unknown[], R>(
  fn: (...args: [...A, (err: Error | null, result: R) => void]) => void,
): (...args: A) => Promise<R> {
  return (...args: A) =>
    new Promise<R>((ok, fail) => {
      fn(...args, (err, result) => (err ? fail(err) : ok(result)));
    });
}
