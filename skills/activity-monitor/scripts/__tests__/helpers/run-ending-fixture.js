import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fixture as databaseFixture } from '../../../../comm-bridge/scripts/__tests__/c4-v2-test-helpers.js';
import { SupervisorRunEndings } from '../../supervisor-run-endings.js';

export async function runEndingFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ending-reconcile-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const f = { root, now: 2_000_000, alerts: [], errors: [], diagnostics: [], fileReads: [], identityReads: [],
    live: new Map(), hidden: new Set(), context: { configuration: { mode: 'multi' }, transition: null,
      fences: [], scenes: [{ sessionGroup: 'origin', present: true }] } };
  const { db, store } = databaseFixture(t, { now: () => f.now });
  Object.assign(f, { db, store });
  f.deps = { db: store, env: { ZYLOS_DIR: root }, now: () => f.now,
    readIdentity: group => { f.identityReads.push(group); return f.live.get(group) ?? { present: false }; },
    isObservable: group => !f.hidden.has(group),
    readFile: async (file, ...options) => { f.fileReads.push(path.basename(path.dirname(file))); return fs.readFile(file, ...options); },
    diagnostic: event => f.diagnostics.push(event), alert: event => f.alerts.push(event), reportError: error => f.errors.push(error) };
  f.restart = () => f.service = new SupervisorRunEndings(f.deps);
  f.restart();
  f.file = group => path.join(root, 'activity-monitor', 'session-groups', group, 'current-session.json');
  f.write = async (group = 'test:a', runId = 'r1', ts = f.now - 1000) => {
    const file = f.file(group); await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ runId, ts }));
  };
  f.add = async (group = 'test:a', runId = 'r1', ts) => {
    assertTaken(store.takeSlot(group, { runId, k: 10000 })); await f.write(group, runId, ts);
  };
  f.step = async (delta = 0) => { f.now += delta; await f.service.advance(f.context); await Promise.resolve(); };
  f.slots = () => store.listSlotOccupancy();
  f.records = (...groups) => store.listRunEndings(groups.length ? groups : ['test:a', 'test:b', 'origin']);
  f.failures = () => f.alerts.filter(event => event.event === 'run_ending_reconciliation_failed');
  return f;
}
function assertTaken(result) {
  if (!result.taken) throw new Error(`Fixture failed to reserve slot: ${result.reason}`);
}
