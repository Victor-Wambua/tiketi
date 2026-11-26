import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NetworkError } from '../src/web/api.ts';
import { ScanEngine, type GateApi, type KV, type ScanRequest } from '../src/web/gate/engine.ts';
import { processScan, gateManifest } from '../src/server/gate.ts';
import { all, one } from '../src/server/db.ts';
import { Client, DEP, MIN, buy, makeEnv, type Env } from './helpers.ts';

/** A gate device: its own storage, its own network switch, talking to the real server code. */
function device(env: Env, gate: string, departureId = DEP) {
  const mem = new Map<string, string>();
  const storage: KV = { get: (k) => mem.get(k) ?? null, set: (k, v) => void mem.set(k, v) };
  const net = { up: true };
  let n = 0;
  const api: GateApi = {
    async scan(r: ScanRequest) {
      if (!net.up) throw new NetworkError();
      return processScan(env.ctx, {
        code: r.code,
        gate: r.gate,
        staffId: null,
        departureId: r.departureId,
        clientScanId: r.clientScanId,
        clientScannedAt: r.scannedAt,
      });
    },
    async batch(reqs: ScanRequest[]) {
      if (!net.up) throw new NetworkError();
      return [...reqs]
        .sort((a, b) => a.scannedAt - b.scannedAt)
        .map((r) => ({
          clientScanId: r.clientScanId,
          scan: processScan(env.ctx, {
            code: r.code,
            gate: r.gate,
            staffId: null,
            departureId: r.departureId,
            clientScanId: r.clientScanId,
            clientScannedAt: r.scannedAt,
            offline: true,
          }),
        }));
    },
    async manifest(id: string) {
      if (!net.up) throw new NetworkError();
      return gateManifest(env.ctx, id) as never;
    },
  };
  const engine = new ScanEngine(
    {
      storage,
      api,
      publicKey: () => env.ctx.keys.publicKeyB64url,
      now: () => env.clock.now(),
      newId: () => `${gate.replace(/\W/g, '')}-${(n += 1).toString().padStart(6, '0')}`,
      isOffline: () => !net.up,
      clockTime: (ms) => new Date(ms).toISOString().slice(11, 16),
    },
    { gate, departureId },
  );
  return { engine, net, storage };
}

test('online: admitted by the server, then the local one-time cache stops a replay without another round trip', async () => {
  const env = makeEnv();
  const b = await buy(env, new Client(env.app), ['1']);
  const g = device(env, 'Gate A');
  const first = await g.engine.handle(b.tickets[0]!.code);
  assert.deepEqual([first.kind, first.source], ['admitted', 'server']);
  g.net.up = false; // even with no network the replay is caught
  const replay = await g.engine.handle(b.tickets[0]!.code);
  assert.deepEqual([replay.kind, replay.reason], ['duplicate', 'duplicate_local']);
  assert.match(replay.message, /Already scanned at \d\d:\d\d at Gate A/);
});

test('offline: signature checked in the browser, admitted from the cached list, queued, then reconciled on sync', async () => {
  const env = makeEnv();
  const b = await buy(env, new Client(env.app), ['2', '3']);
  const g = device(env, 'Gate A');
  assert.equal(await g.engine.refreshManifest(), true);
  g.net.up = false;

  const v = await g.engine.handle(b.tickets[0]!.code);
  assert.deepEqual([v.kind, v.reason, v.source], ['admitted', 'admitted_offline', 'offline']);
  assert.equal(g.engine.queueLength, 1);
  assert.equal((await g.engine.handle(b.tickets[0]!.code)).reason, 'duplicate_local');
  assert.equal(g.engine.queueLength, 1, 'a replay is not queued twice');
  assert.equal(
    one<{ admitted_at: number | null }>(
      env.ctx.db,
      `SELECT admitted_at FROM tickets WHERE id = ?`,
      b.tickets[0]!.id,
    )!.admitted_at,
    null,
    'server has not heard yet',
  );

  assert.deepEqual(
    await g.engine.sync(),
    { sent: 0, conflicts: 0, remaining: 1 },
    'still offline: nothing lost',
  );
  g.net.up = true;
  env.clock.advance(2 * MIN);
  const r = await g.engine.sync();
  assert.deepEqual(r, { sent: 1, conflicts: 0, remaining: 0 });
  assert.equal(
    one<{ admitted_gate: string }>(
      env.ctx.db,
      `SELECT admitted_gate FROM tickets WHERE id = ?`,
      b.tickets[0]!.id,
    )!.admitted_gate,
    'Gate A',
  );
  // and a second device now gets the server's answer
  const other = device(env, 'Gate B');
  assert.equal((await other.engine.handle(b.tickets[0]!.code)).kind, 'duplicate');
});

test('offline rejects forged codes, wrong departures, unlisted tickets and codes when no list was ever downloaded', async () => {
  const env = makeEnv();
  const b = await buy(env, new Client(env.app), ['4']);
  const parts = b.tickets[0]!.code.split('.');
  const g = device(env, 'Gate A');
  g.net.up = false;
  assert.equal((await g.engine.handle(b.tickets[0]!.code)).reason, 'no_list');
  g.net.up = true;
  await g.engine.refreshManifest();
  g.net.up = false;
  assert.equal(
    (await g.engine.handle([...parts.slice(0, 3), '5', ...parts.slice(4)].join('.'))).reason,
    'invalid',
  );
  assert.equal((await g.engine.handle('not a ticket')).reason, 'invalid');
  const late = await buy(env, new Client(env.app), ['6']); // issued after the list was downloaded
  assert.equal((await g.engine.handle(late.tickets[0]!.code)).reason, 'not_in_list');
  const wrong = device(env, 'Gate A', 'dep-elsewhere');
  assert.equal((await wrong.engine.handle(b.tickets[0]!.code)).reason, 'wrong_departure');
  assert.equal(g.engine.queueLength, 0);
});

test('a refreshed list makes the scanner refuse a transferred ticket offline', async () => {
  const env = makeEnv();
  const c = new Client(env.app);
  const b = await buy(env, c, ['7']);
  const oldCode = b.tickets[0]!.code;
  await c.post(`/api/tickets/${b.tickets[0]!.id}/transfer`, { newHolderName: 'Joy Wambui' });
  const g = device(env, 'Gate A');
  await g.engine.refreshManifest();
  g.net.up = false;
  assert.equal((await g.engine.handle(oldCode)).reason, 'stale_version');
});

test('the honest limit: a transfer after the last sync is invisible offline, and the server rejects that scan at reconciliation', async () => {
  const env = makeEnv();
  const c = new Client(env.app);
  const b = await buy(env, c, ['8']);
  const oldCode = b.tickets[0]!.code;
  const g = device(env, 'Gate A');
  await g.engine.refreshManifest();
  g.net.up = false;
  await c.post(`/api/tickets/${b.tickets[0]!.id}/transfer`, { newHolderName: 'Joy Wambui' }); // happens while the gate is offline
  const v = await g.engine.handle(oldCode);
  assert.equal(v.kind, 'admitted', 'offline cannot know about the transfer');
  g.net.up = true;
  await g.engine.sync();
  const row = one<{ result: string }>(env.ctx.db, `SELECT result FROM scans WHERE offline = 1`)!;
  assert.equal(row.result, 'stale_version', 'recorded as a rejected scan for the organiser to see');
  assert.equal(
    one<{ admitted_at: number | null }>(env.ctx.db, `SELECT admitted_at FROM tickets`)!.admitted_at,
    null,
    'the new holder can still enter',
  );
});

test('two gates admit the same ticket while offline: both people are in, the collision is reported, the earlier entry is canonical', async () => {
  const env = makeEnv();
  const b = await buy(env, new Client(env.app), ['9']);
  const a = device(env, 'Gate A');
  const bb = device(env, 'Gate B');
  await a.engine.refreshManifest();
  await bb.engine.refreshManifest();
  a.net.up = false;
  bb.net.up = false;
  env.clock.advance(MIN);
  assert.equal((await a.engine.handle(b.tickets[0]!.code)).kind, 'admitted');
  env.clock.advance(2 * MIN);
  assert.equal(
    (await bb.engine.handle(b.tickets[0]!.code)).kind,
    'admitted',
    'neither device can know about the other',
  );
  env.clock.advance(MIN);
  bb.net.up = true;
  a.net.up = true;
  const rb = await bb.engine.sync(); // the later scanner reports first
  const ra = await a.engine.sync();
  assert.equal(rb.conflicts + ra.conflicts, 1);
  const t = one<{ admitted_gate: string }>(env.ctx.db, `SELECT admitted_gate FROM tickets`)!;
  assert.equal(t.admitted_gate, 'Gate A');
  const flagged = all<{ gate: string }>(
    env.ctx.db,
    `SELECT gate FROM scans WHERE conflict = 1 ORDER BY gate`,
  );
  assert.deepEqual(
    flagged.map((s) => s.gate),
    ['Gate A', 'Gate B'],
  );
});

test('a connection that drops mid-scan falls back to the offline decision; retrying sync never double-counts', async () => {
  const env = makeEnv();
  const b = await buy(env, new Client(env.app), ['10']);
  const g = device(env, 'Gate A');
  await g.engine.refreshManifest();
  g.net.up = false; // looks "online" to the browser, but requests fail
  const v = await g.engine.handle(b.tickets[0]!.code);
  assert.equal(v.reason, 'admitted_offline');
  g.net.up = true;
  await g.engine.sync();
  await g.engine.sync();
  assert.equal(all(env.ctx.db, `SELECT * FROM scans WHERE result = 'admitted'`).length, 1);
});

test('queued scans survive a page reload (storage round trip)', async () => {
  const env = makeEnv();
  const b = await buy(env, new Client(env.app), ['11']);
  const g = device(env, 'Gate A');
  await g.engine.refreshManifest();
  g.net.up = false;
  await g.engine.handle(b.tickets[0]!.code);
  const reloaded = new ScanEngine(
    {
      storage: g.storage,
      api: {
        scan: async () => {
          throw new NetworkError();
        },
        batch: async () => {
          throw new NetworkError();
        },
        manifest: async () => {
          throw new NetworkError();
        },
      },
      publicKey: () => env.ctx.keys.publicKeyB64url,
      now: () => env.clock.now(),
      newId: () => 'x',
      isOffline: () => true,
      clockTime: () => '00:00',
    },
    { gate: 'Gate A', departureId: DEP },
  );
  assert.equal(reloaded.queueLength, 1);
  assert.equal((await reloaded.handle(b.tickets[0]!.code)).reason, 'duplicate_local');
});
