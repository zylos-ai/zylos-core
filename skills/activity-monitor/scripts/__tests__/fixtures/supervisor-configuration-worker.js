import fs from 'node:fs';
import path from 'node:path';
import { startSupervisor } from '../../supervisor-main.js';

const now = 200_000, controls = [], fences = new Map();
const scene = { sessionGroup: 'a', present: true, ready: true, runId: 'run-a', sessionId: 'session-a',
  runtime: 'claude', processRunning: true, state: 'idle', idleSince: 0, createdAt: 0, usagePercent: 50,
  runDir: path.join(process.env.ZYLOS_DIR, 'activity-monitor/session-groups/a') };
const db = { getModeTransition: () => null, listDrainFences: () => [...fences.values()],
  getDrainFence: group => fences.get(group) ?? null,
  setDrainFence: (group, value) => fences.set(group, { sessionGroup: group, ...value }),
  listPendingSessionGroups: () => [], getControlById: () => null,
  getLastActivity: () => ({ ts: now - 120_000 }), getUnsummarizedRange: () => ({ count: 0, firstAt: null }),
  insertControl: (content, options) => { const row = { id: controls.length + 1, content, ...options }; controls.push(row); return row; },
  resolveSessionLaunchConfig: () => ({ runtime: 'claude', mode: 'default' }) };
const service = await startSupervisor({ db, now: () => now,
  scenes: { observe: async () => [], observeGroup: async () => scene, listRuns: async () => [], readRun: async () => null },
  legacyStatus: { tick() {}, close() {} }, machineTasks: { tick() {}, stop() {} },
  readSyncMarker: () => ({ held: false, stale: false }),
  loopOptions: { schedule: () => 1, cancel() {} }, log() {},
  sendAlert: () => { throw new Error('External send forbidden'); },
});
try {
  if (service.supervisor.loop.configurationError) throw service.supervisor.loop.configurationError;
  const configuration = service.supervisor.loop.configuration;
  const context = { configuration };
  await service.supervisor.lifecycle.checkRotation(scene, context);
  await service.supervisor.lifecycle.checkTtl(scene, context);
  const file = path.join(process.env.ZYLOS_DIR, '.zylos/config.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...raw, session_mode: 'single', session_hot_ttl_seconds: 999,
    new_session_threshold: 99, sync_min_interval_seconds: 999 }));
  const refreshed = await service.supervisor.loop.deps.readConfiguration();
  process.stdout.write(JSON.stringify({ configuration, refreshed, controls, fences: [...fences.values()] }));
} finally {
  await service.stop();
}
