import { ApiError, get, post, uid } from '../api.ts';
import { announce, h } from '../dom.ts';
import {
  ScanEngine,
  type GateApi,
  type KV,
  type ServerScan,
  type ScanRequest,
  type Verdict,
} from '../gate/engine.ts';
import { fmtTime, fmtWhen } from '../format.ts';
import { navigate, type Page } from '../router.ts';
import { currentUser, refreshSession } from '../session.ts';

interface Config {
  publicKey: string;
  departures: { id: string; startsAt: number; title: string; venue: string }[];
}

const storage: KV = {
  get: (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* private mode: the queue lives only in memory */
    }
  },
};

const api: GateApi = {
  async scan(r: ScanRequest) {
    return (
      await post<{ scan: ServerScan }>(
        '/api/gate/scans',
        {
          code: r.code,
          gate: r.gate,
          departureId: r.departureId,
          clientScanId: r.clientScanId,
          scannedAt: r.scannedAt,
        },
        r.clientScanId,
      )
    ).scan;
  },
  async batch(reqs: ScanRequest[]) {
    return (
      await post<{ results: { clientScanId: string | null; scan: ServerScan }[] }>(
        '/api/gate/scans/batch',
        { scans: reqs.map((r) => ({ ...r, offline: true })) },
        uid(),
      )
    ).results;
  },
  manifest: (id: string) => get(`/api/gate/manifest/${id}`),
};

declare global {
  interface Window {
    BarcodeDetector?: new (o: { formats: string[] }) => {
      detect(v: HTMLVideoElement): Promise<{ rawValue: string }[]>;
    };
  }
}

export async function gatePage(): Promise<Page> {
  const me = (await refreshSession()) ?? currentUser();
  if (!me) {
    navigate('/login?next=/gate', true);
    return { title: 'Gate', el: h('div') };
  }

  // Public key and departures are cached so the page still works with no signal.
  let config: Config | null;
  try {
    config = await get<Config>('/api/gate/config');
    storage.set('tiketi.gate.config', JSON.stringify(config));
  } catch (e) {
    if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
      navigate('/login?next=/gate', true);
      return { title: 'Gate', el: h('div') };
    }
    const cached = storage.get('tiketi.gate.config');
    config = cached ? (JSON.parse(cached) as Config) : null;
  }
  if (!config) {
    return {
      title: 'Gate scanner',
      el: h(
        'div',
        { class: 'page' },
        h('h1', null, 'Gate scanner'),
        h(
          'p',
          { class: 'notice bad', role: 'alert' },
          'Could not load the scanner setup and nothing is cached on this device. Connect once to set it up.',
        ),
      ),
    };
  }
  const cfg = config;

  const gateInput = h('input', {
    id: 'gate-name',
    value: storage.get('tiketi.gate.name') ?? 'Gate A',
    maxlength: 40,
    autocomplete: 'off',
  });
  const depSelect = h(
    'select',
    { id: 'dep' },
    ...cfg.departures.map((d) => h('option', { value: d.id }, `${d.title} · ${fmtWhen(d.startsAt)}`)),
  );
  const offlineBox = h('input', { type: 'checkbox', id: 'force-offline' });
  const online = h('span', { class: 'chip ok' }, 'Online');
  const queueChip = h('span', { class: 'chip' }, '0 queued');
  const listInfo = h('p', { class: 'hint' });
  const verdictBox = h(
    'div',
    { class: 'verdict', role: 'status', 'aria-live': 'assertive' },
    h('div', { class: 'big', 'aria-hidden': 'true' }, '…'),
    h('h2', null, 'Ready to scan'),
    h('p', null, 'Scan a ticket QR code or type its code below.'),
  );
  const logEl = h('ul', { class: 'log', 'aria-label': 'Recent scans' });
  const syncMsg = h('p', { class: 'hint', role: 'status' });

  let engine: ScanEngine;
  const forceOffline = () => offlineBox.checked || !navigator.onLine;

  function makeEngine() {
    engine = new ScanEngine(
      {
        storage,
        api,
        publicKey: () => cfg.publicKey,
        now: () => Date.now(),
        newId: uid,
        isOffline: forceOffline,
        clockTime: fmtTime,
      },
      { gate: gateInput.value.trim() || 'Gate', departureId: depSelect.value },
    );
    void engine.refreshManifest().then(paintStatus);
    paintStatus();
    paintLog();
  }

  function paintStatus() {
    const off = forceOffline();
    online.className = `chip ${off ? 'warn' : 'ok'}`;
    online.textContent = off ? 'Offline mode' : 'Online';
    queueChip.textContent = `${engine.queueLength} queued`;
    queueChip.className = `chip ${engine.queueLength ? 'warn' : ''}`;
    listInfo.textContent = engine.manifestSize
      ? `Ticket list on this device: ${engine.manifestSize} tickets (updated ${engine.manifestAge !== null ? Math.max(0, Math.round(engine.manifestAge / 60000)) : '?'} min ago).`
      : 'No ticket list downloaded yet for this departure.';
  }

  function paintLog() {
    logEl.replaceChildren(
      ...engine.log
        .slice(0, 8)
        .map((v) =>
          h(
            'li',
            null,
            h('time', null, fmtTime(v.at)),
            h(
              'span',
              null,
              `${v.seat ? `Seat ${v.seat}: ` : ''}${v.kind === 'admitted' ? 'admitted' : v.kind === 'duplicate' ? 'already used' : 'rejected'}${v.source === 'offline' ? ' (offline)' : ''}`,
            ),
          ),
        ),
    );
    if (engine.log.length === 0) logEl.replaceChildren(h('li', { class: 'muted' }, 'Nothing scanned yet.'));
  }

  function showVerdict(v: Verdict) {
    const cls = v.kind === 'admitted' ? 'ok' : v.kind === 'duplicate' ? 'warn' : 'bad';
    const icon = v.kind === 'admitted' ? '✓' : v.kind === 'duplicate' ? '!' : '✕';
    const title =
      v.kind === 'admitted'
        ? `Let in${v.seat ? `: seat ${v.seat}` : ''}`
        : v.kind === 'duplicate'
          ? 'Already used'
          : 'Do not admit';
    verdictBox.className = `verdict ${cls}`;
    verdictBox.dataset.kind = v.kind;
    verdictBox.replaceChildren(
      h('div', { class: 'big', 'aria-hidden': 'true' }, icon),
      h('h2', null, title),
      h('p', null, v.message),
    );
    if (v.holder) verdictBox.append(h('p', null, v.holder));
    announce(`${title}. ${v.message}`);
    paintStatus();
    paintLog();
  }

  async function submit(code: string) {
    if (!code.trim()) return;
    try {
      showVerdict(await engine.handle(code));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) navigate('/login?next=/gate', true);
      else
        showVerdict({
          kind: 'rejected',
          reason: 'error',
          message: e instanceof ApiError ? e.message : 'Something went wrong. Try again.',
          source: 'offline',
          at: Date.now(),
        });
    }
  }

  async function sync() {
    syncMsg.textContent = 'Syncing…';
    const r = await engine.sync();
    syncMsg.textContent =
      r.sent === 0
        ? r.remaining
          ? 'Still offline: scans are kept safely on this device.'
          : 'Nothing to sync.'
        : `Synced ${r.sent} scan${r.sent === 1 ? '' : 's'}${r.conflicts ? `. ${r.conflicts} conflict${r.conflicts === 1 ? '' : 's'}: the same ticket was admitted twice while offline. The organiser has been flagged.` : '.'}`;
    paintStatus();
    paintLog();
  }

  // manual entry
  const codeInput = h('input', {
    id: 'code',
    name: 'code',
    autocomplete: 'off',
    autocapitalize: 'none',
    spellcheck: 'false',
    placeholder: 'TK1.…',
    class: 'mono',
  });
  const form = h(
    'form',
    {
      class: 'stack',
      onSubmit: (e: Event) => {
        e.preventDefault();
        const v = codeInput.value;
        codeInput.value = '';
        void submit(v);
        codeInput.focus();
      },
    },
    h('div', { class: 'field' }, h('label', { for: 'code' }, 'Ticket code (manual entry)'), codeInput),
    h('button', { class: 'btn primary', type: 'submit' }, 'Check ticket'),
  );

  // camera
  const video = h('video', { playsinline: '', muted: '', 'aria-label': 'Camera view' });
  const camBox = h('div', { class: 'camera', hidden: '' }, video, h('div', { class: 'frame' }));
  const camBtn = h('button', { class: 'btn', type: 'button' }, 'Scan with camera');
  const camMsg = h(
    'p',
    { class: 'hint' },
    window.BarcodeDetector
      ? 'Camera scanning uses the browser’s built-in QR detector.'
      : 'This browser has no built-in QR detector, so use manual entry.',
  );
  let stopCam: (() => void) | null = null;
  if (!window.BarcodeDetector || !navigator.mediaDevices?.getUserMedia) camBtn.disabled = true;
  camBtn.addEventListener('click', async () => {
    if (stopCam) {
      stopCam();
      return;
    }
    try {
      const Detector = window.BarcodeDetector!;
      const detector = new Detector({ formats: ['qr_code'] });
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      video.srcObject = stream;
      await video.play();
      camBox.hidden = false;
      camBtn.textContent = 'Stop camera';
      let last = '';
      let lastAt = 0;
      const timer = window.setInterval(async () => {
        try {
          const found = await detector.detect(video);
          const raw = found[0]?.rawValue;
          if (raw && (raw !== last || Date.now() - lastAt > 4000)) {
            last = raw;
            lastAt = Date.now();
            void submit(raw);
          }
        } catch {
          /* frame not ready */
        }
      }, 250);
      stopCam = () => {
        window.clearInterval(timer);
        stream.getTracks().forEach((t) => t.stop());
        camBox.hidden = true;
        camBtn.textContent = 'Scan with camera';
        stopCam = null;
      };
    } catch {
      camMsg.textContent = 'Could not start the camera. Check the permission, or use manual entry.';
    }
  });

  depSelect.addEventListener('change', makeEngine);
  gateInput.addEventListener('change', () => {
    storage.set('tiketi.gate.name', gateInput.value);
    makeEngine();
  });
  offlineBox.addEventListener('change', () => {
    paintStatus();
    if (!forceOffline()) void sync();
  });
  const onNet = () => {
    paintStatus();
    if (!forceOffline()) void sync();
  };
  window.addEventListener('online', onNet);
  window.addEventListener('offline', onNet);

  const el = h(
    'div',
    { class: 'page' },
    h(
      'header',
      { class: 'stack' },
      h('span', { class: 'eyebrow' }, `Signed in as ${me.displayName}`),
      h('h1', null, 'Gate scanner'),
      h('div', { class: 'row' }, online, queueChip),
    ),
    h(
      'div',
      { class: 'layout-2' },
      h(
        'section',
        { class: 'stack', 'aria-label': 'Scanner' },
        verdictBox,
        camBox,
        h('div', { class: 'row' }, camBtn),
        camMsg,
        h('div', { class: 'card' }, form),
      ),
      h(
        'aside',
        { class: 'side stack' },
        h(
          'section',
          { class: 'card stack' },
          h('div', { class: 'field' }, h('label', { for: 'dep' }, 'Departure'), depSelect),
          h('div', { class: 'field' }, h('label', { for: 'gate-name' }, 'This gate'), gateInput),
          h(
            'div',
            { class: 'row' },
            offlineBox,
            h('label', { for: 'force-offline' }, 'Work offline (simulate no signal)'),
          ),
          listInfo,
        ),
        h(
          'section',
          { class: 'card stack' },
          h('h2', null, 'Offline queue'),
          h(
            'p',
            { class: 'muted' },
            'Scans made without a connection are checked against the downloaded ticket list, then sent for reconciliation when the connection returns.',
          ),
          h('button', { class: 'btn', type: 'button', onClick: () => void sync() }, 'Sync now'),
          syncMsg,
        ),
        h('section', { class: 'card stack' }, h('h2', null, 'Recent scans'), logEl),
      ),
    ),
  );

  if (cfg.departures.length === 0) {
    el.querySelector('.layout-2')?.replaceWith(
      h('p', { class: 'notice warn' }, 'No departures are open for scanning right now.'),
    );
    return { title: 'Gate scanner', el };
  }
  makeEngine();
  const poll = window.setInterval(() => {
    paintStatus();
    if (!forceOffline() && engine.queueLength) void sync();
  }, 15_000);

  return {
    title: 'Gate scanner',
    el,
    destroy() {
      stopCam?.();
      window.clearInterval(poll);
      window.removeEventListener('online', onNet);
      window.removeEventListener('offline', onNet);
    },
  };
}
