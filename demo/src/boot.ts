import './polyfills.ts';
import './demo.css';
import { route } from '../../src/web/router.ts';
import { installApi } from './install.ts';
import { startRuntime } from './runtime.ts';
import { aboutPage } from './ui/about.ts';
import { clearBrowserState, mountDemoTools } from './ui/banner.ts';
import { gatePage } from './ui/gate.ts';
import { homePage } from './ui/home.ts';
import { racePage } from './ui/race.ts';

const boot = document.getElementById('boot');

// The skip link's `#main` would be read as a route in hash mode, so it moves focus by hand.
document.querySelector('.skip')?.addEventListener('click', (e) => {
  e.preventDefault();
  document.getElementById('main')?.focus();
});

try {
  clearBrowserState();
  const rt = await startRuntime();
  installApi(rt);
  mountDemoTools(rt);

  // Tickets and bookings from before a reload are gone with the in-memory database.
  if (/^#\/[tb]\//.test(location.hash)) history.replaceState(null, '', location.pathname + location.search);

  route('/', homePage);
  route('/demo', aboutPage);
  route('/demo/race', () => racePage(rt));
  route('/demo/gate', () => gatePage(rt));
  // Handle for debugging and for the demo's own tests.
  (window as unknown as { tiketiDemo: unknown }).tiketiDemo = rt;

  await import('../../src/web/main.ts');
  boot?.remove();
} catch (err) {
  console.error(err);
  if (boot) {
    boot.setAttribute('role', 'alert');
    boot.textContent = `The demo could not start in this browser (${err instanceof Error ? err.message : 'unknown error'}). It needs a recent browser with WebAssembly.`;
  }
}
