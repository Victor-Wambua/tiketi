import { currentUrl } from '../../../src/web/base.ts';
import { h } from '../../../src/web/dom.ts';
import { fmtWhen } from '../../../src/web/format.ts';
import type { Runtime } from '../runtime.ts';

const MIN = 60_000;

/** Wipes anything an earlier page load left in this browser: the in-page database starts empty each time. */
export function clearBrowserState(): void {
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith('tiketi.')) localStorage.removeItem(k);
    sessionStorage.clear();
  } catch {
    /* storage blocked: nothing to clear */
  }
}

/** The persistent banner's controls. The statement and links are plain HTML in index.html. */
export function mountDemoTools(rt: Runtime): void {
  const slot = document.getElementById('demo-actions');
  if (!slot) return;

  const clock = h('span', { class: 'demo-clock', role: 'status' });
  const paint = () => {
    const ahead = Math.round(rt.clock.offsetMs / MIN);
    clock.textContent = ahead > 0 ? `Demo clock: ${fmtWhen(rt.clock.now())} (${ahead} min ahead)` : '';
  };

  const skip = h(
    'button',
    {
      type: 'button',
      class: 'demo-btn',
      title: 'Holds last 10 minutes. This moves the demo clock forward so you can see one expire.',
      onClick: () => {
        rt.skipAhead(10 * MIN);
        paint();
      },
    },
    'Skip ahead 10 min',
  );
  const reset = h(
    'button',
    {
      type: 'button',
      class: 'demo-btn',
      title: 'Throws away this tab’s data and loads fresh sample data.',
      onClick: () => {
        history.replaceState(null, '', location.pathname + location.search);
        location.reload();
      },
    },
    'Reset sample data',
  );
  slot.replaceChildren(skip, reset, clock);

  // Mark the banner link for the page being shown, the way the app's own nav does.
  const markCurrent = () => {
    const here = `#${currentUrl().pathname}`;
    for (const a of document.querySelectorAll<HTMLAnchorElement>('.demo-tools a')) {
      if (a.getAttribute('href') === here) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
  };
  window.addEventListener('popstate', markCurrent);
  document.addEventListener('click', () => queueMicrotask(markCurrent));
  markCurrent();
}
