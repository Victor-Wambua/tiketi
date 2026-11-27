/**
 * Node timers return an object with `.unref()`; browser timers return a number. The two server
 * files that call `.unref()` get these wrappers instead (the demo build prepends an import).
 */
export interface Timer {
  id: number;
  unref(): Timer;
  ref(): Timer;
}

const wrap = (id: number): Timer => ({
  id,
  unref() {
    return this;
  },
  ref() {
    return this;
  },
});

export const setTimeout = (fn: () => void, ms?: number): Timer => wrap(window.setTimeout(fn, ms));
export const setInterval = (fn: () => void, ms?: number): Timer => wrap(window.setInterval(fn, ms));
export const clearTimeout = (t: Timer | undefined): void => {
  if (t) window.clearTimeout(t.id);
};
export const clearInterval = (t: Timer | undefined): void => {
  if (t) window.clearInterval(t.id);
};
