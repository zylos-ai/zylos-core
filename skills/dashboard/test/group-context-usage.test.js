import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectStatus } from '../../../cli/lib/status-view.js';
import { createSessionReader } from '../../../cli/lib/session-state-reader-async.js';
import { publishContextSample } from '../../activity-monitor/scripts/context-monitor.js';
import { createGroupSnapshot } from '../src/lib/workbench/group-snapshot.js';

// The real chain behind a group's context use: the statusLine hook publishes the session's sample into the
// group's run directory, Core's session reader reads it back against the live run and session, and the
// workbench snapshot puts it on the group's row. Only tmux identity, C4 and the event store are fixed answers.
// Covers: an idle group (no new sample since its last request) and a group whose session has changed.
// Run for changes to the session reader, the statusLine hook or the group snapshot. Temporary root only.
const GROUP = 'dashboard:854b9f9c-0c1e-4c43-9a51-2f0d2f7c5e01';
const identity = { present: true, ready: true, runtime: 'claude', runId: 'd0278609-51d2-4963-aa96-77ec76f8069f', sessionId: 'session-1',
  createdAt: 1800000000, serverGeneration: 'generation', tmuxSessionId: '$1', paneId: '%1', tmuxName: 'zylos-group', launchConfig: { runtime: 'claude', mode: 'default' } };
// The fields Claude Code hands its statusLine command that the dashboard reads.
const statusLine = { session_id: 'session-1', model: { id: 'claude-opus-4-1', display_name: 'Opus' },
  context_window: { used_percentage: 37, context_window_size: 200000 }, version: '2.0.0' };

function fixture(t, { live = identity } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-context-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ZYLOS_DIR: root, ZYLOS_SESSION_GROUP: GROUP, ZYLOS_RUN_ID: identity.runId };
  const writtenAt = 1800000000000;
  publishContextSample(JSON.stringify(statusLine), { env, now: writtenAt });
  let clock = writtenAt;
  const reader = createSessionReader({ env: { ZYLOS_DIR: root }, now: () => clock,
    open: async () => ({ close: async () => {} }), observe: async () => live });
  const cli = {
    runC4Db: async args => args[0] === 'groups'
      ? { ok: true, readAt: clock, data: { groups: [{ sessionGroup: GROUP, componentName: 'dashboard', lastActivityAt: writtenAt }], hasOlder: false } }
      : { ok: true, readAt: clock, data: { groups: [], globalFence: null } },
    readOverrides: async () => ({ ok: true, readAt: clock, data: { baseline: { runtime: 'claude' }, runtime: [], model: [] } }),
  };
  const service = createGroupSnapshot({ zylosDir: root, now: () => clock, cli,
    store: { latestEventByType: () => null, queryEvents: () => [] }, c4Reader: { getInboundTimes: () => [] },
    loadCoreModule: async name => {
      if (name === 'config.js') return { readSessionMode: () => ({ mode: 'multi' }) };
      if (name === 'session-state-reader.js') return reader;
      return { collectStatus: options => collectStatus({ ...options, mode: () => ({ mode: 'multi' }), now: () => clock,
        resolveRoot: () => root, list: () => [{ sessionGroup: GROUP }], health: () => ({ missing: true }),
        facts: async () => ({ originNeed: null }), configIssue: () => null }) };
    } });
  return { root, service, wait: ms => { clock += ms; } };
}

test('an idle group keeps its last context use from the statusLine sample', async t => {
  const f = fixture(t);
  const sample = JSON.parse(fs.readFileSync(path.join(f.root, 'activity-monitor', 'session-groups', GROUP, 'statusline.json'), 'utf8'));
  assert.deepEqual(sample.zylos, { v: 1, runId: identity.runId, sessionGroup: GROUP, capturedAt: 1800000000000 });
  f.wait(42000);
  const row = (await f.service.getSnapshot()).rows.find(item => item.sessionGroup === GROUP);
  assert.equal(row.contextPct, 37);
  assert.equal(row.contextReason, undefined);
});

test('a group whose session changed since the sample shows no context use', async t => {
  const f = fixture(t, { live: { ...identity, sessionId: 'session-2' } });
  f.wait(42000);
  const row = (await f.service.getSnapshot()).rows.find(item => item.sessionGroup === GROUP);
  assert.equal(row.contextPct, null);
  assert.equal(row.contextReason, 'usage_unreadable');
});
