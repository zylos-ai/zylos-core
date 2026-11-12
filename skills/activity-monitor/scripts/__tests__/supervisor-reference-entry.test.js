import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startSupervisor } from '../supervisor-main.js';
import { REFERENCE_REORG_PROMPT, ORIGIN_SYNC_PROMPT, GROUP_SYNC_PROMPT } from '../../../zylos-memory/scripts/sync-prompts.js';

// Integration boundary: real entry construction -> Supervisor -> lifecycle ->
// filesystem helper and actual prompt loading, with an owned Supervisor socket.
// Run for reference proposal dependency wiring/startup isolation; unrelated UI
// changes may skip. Runner isolates HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR before
// import; fixture paths are checked below. Queue/runtime are in-memory, no tmux
// or database is opened. Scheduling is disabled and t.after stops/removes all.
for (const mode of ['single', 'multi']) for (const unreadable of [false, true]) {
  test(`${mode} entry keeps Sync working with ${unreadable ? 'an old-file lookup failure' : 'existing old reference files'}`, { timeout: 10000 }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reorg-entry-'));
    const env = { ...process.env, HOME: path.join(root, 'home'), ZYLOS_DIR: path.join(root, 'z'),
      PM2_HOME: path.join(root, 'pm2'), TMPDIR: path.join(root, 'tmp'), TMUX_TMPDIR: path.join(root, 'tmp') };
    for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR']) {
      assert.ok(env[key].startsWith(root + path.sep));
      fs.mkdirSync(env[key], { recursive: true });
    }
    const socket = path.join(env.ZYLOS_DIR, 'activity-monitor/am.sock');
    assert.ok(Buffer.byteLength(socket) < 104);
    t.diagnostic(JSON.stringify({ paths: Object.fromEntries(['HOME','ZYLOS_DIR','PM2_HOME','TMPDIR','TMUX_TMPDIR'].map(key => [key,env[key]])), socket, tmux: 'unused', database: 'unused' }));
    const reference = path.join(env.ZYLOS_DIR, 'memory/reference');
    fs.mkdirSync(path.dirname(reference), { recursive: true });
    if (unreadable) fs.writeFileSync(reference, 'not a directory');
    else {
      fs.mkdirSync(reference);
      fs.writeFileSync(path.join(reference, 'projects.md'), 'legacy project');
    }
    const state = path.join(env.ZYLOS_DIR, 'memory/reference-reorg-state.json');
    const rows = [], logs = [], now = Date.parse('2026-11-11T10:00:00Z');
    let service;
    t.after(async () => { try { await service?.stop(); } finally { fs.rmSync(root, { recursive: true, force: true }); } });
    const scene = { sessionGroup: mode === 'single' ? null : 'origin', present: true, ready: true,
      runtime: 'claude', runId: 'entry-run', sessionId: 'entry-session', runDir: root, state: 'idle', usagePercent: 0 };
    const db = {
      getOriginNeed: () => ({ controls: { count: 0 }, inbound: { oldestAt: null } }),
      getModeTransition: () => null, listDrainFences: () => [], getDrainFence: () => null,
      listSlotOccupancy: () => [], pruneSlots: () => ({ deletedHeld: 0, deletedOrphans: [] }),
      listPendingContinuations: () => [], listRunEndings: () => [], getLastCompletedModeTransition: () => null,
      listPendingSessionGroups: () => [], getControlById: () => null,
      getOriginSyncBacklog: () => ({ total: 0, groups: [] }),
      resolveSessionLaunchConfig: () => ({ runtime: 'claude', mode: 'default' }),
      insertControl: (content, options) => {
        assert.equal(fs.existsSync(state), false, 'the helper does not create a state file');
        rows.push({ content, ...options }); return { id: rows.length };
      },
    };
    service = await startSupervisor({ env, now: () => now, db,
      readMode: () => ({ mode, keyPresent: true }), readConfig: () => ({ session_mode: mode, runtime: 'claude' }),
      readConfiguration: () => ({ mode, runtime: 'claude', capacity: 2 }), resolveTargetRuntime: () => 'claude',
      scenes: { observe: async () => [], observeGroup: async () => scene, readIdentity: async () => scene,
        listRuns: async () => [], readRun: async () => null },
      legacyStatus: { tick() {}, close() {} }, machineTasks: { tick() {}, stop() {} },
      readSyncMarker: () => ({ held: false, stale: false }),
      log: value => logs.push(value), loopOptions: { schedule: () => 1, cancel() {} },
    });
    assert.equal(service.server.listening, true);
    await service.supervisor.lifecycle.syncScope(scene, mode === 'single' ? 'global' : 'origin',
      { count: 60, nonempty: true, firstAt: now, firstConversationId: 1 },
      { configuration: { mode }, scenes: [scene], fences: [], restartRequests: [], transition: null });
    const sync = mode === 'single' ? GROUP_SYNC_PROMPT : ORIGIN_SYNC_PROMPT;
    assert.deepEqual(rows.map(row => row.content), unreadable ? [sync] : [REFERENCE_REORG_PROMPT, sync]);
    assert.equal(rows.at(-1).priority, 2);
    if (unreadable) assert.ok(logs.some(row => row.phase === 'reference-reorganization' && row.error === 'ENOTDIR'));
    else {
      assert.equal(rows[0].priority, 3); assert.equal(rows[0].appendAckSuffix, false);
      assert.equal(rows[0].sessionGroup, mode === 'single' ? null : 'origin');
    }
  });
}
