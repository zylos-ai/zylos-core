import test from 'node:test';
import assert from 'node:assert/strict';
import { SupervisorLifecycle } from '../supervisor-lifecycle.js';
import { routerFixture } from '../../../comm-bridge/scripts/__tests__/helpers/router-fixture.js';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SyncObserver } from '../sync-observer.js';
import { appendEvent } from '../../../../cli/lib/event-log.js';
import { supervisorDiagnosticPath } from '../../../../cli/lib/session-group-paths.js';
import { PRE_RECLAIM_CHECK_PROMPT } from '../reclaim-prompts.js';
import * as syncPrompts from '../../../zylos-memory/scripts/sync-prompts.js';

// These cases extend the same isolated real C4/Router boundary above. Run for
// Sync observability/deadline changes; skip for unrelated UI. Fresh runner HOME,
// ZYLOS_DIR, PM2_HOME and TMPDIR are read back before opening any fixture; no
// runtime process, socket, PM2 service or external account is accessed.
function observableFixture(t) {
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) assert.ok(process.env[key]?.includes('zylos-tests-'), `${key} must be isolated`);
  const f = routerFixture(t);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-observation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ZYLOS_DIR: root }, file = supervisorDiagnosticPath(env);
  const observer = new SyncObserver({ env, now: f.now }); t.after(() => observer.close());
  const scene = { sessionGroup: 'origin', present: true, ready: true, runtime: 'claude',
    runId: 'run', sessionId: 'session', runDir: path.join(root, 'run') };
  const lifecycle = new SupervisorLifecycle({ env, db: f.db, syncObserver: observer,
    requests: { read: () => [] }, observeGroup: () => scene,
    bindTarget: () => ({ expectedRunId: 'run', tmuxTarget: { serverGeneration: '1:1', sessionId: '$1', paneId: '%1' } }), groupRunDir: () => scene.runDir,
    readSyncMarker: () => ({ held: false, stale: false }), prompts: { ...syncPrompts, PRE_RECLAIM_CHECK_PROMPT },
    diagnostic: row => appendEvent(file, { v: 1, ts: f.now(), ...row }),
  }, { now: f.now });
  const context = { configuration: { mode: 'multi' }, scenes: [scene], fences: [], restartRequests: [], transition: null };
  const alerts = () => f.sqlite.prepare("SELECT content,session_group FROM control_queue WHERE content LIKE 'Memory Sync alert:%'").all();
  const events = type => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse)
    .filter(row => row.event === 'sync_alert' && (!type || row.type === type)) : [];
  const restart = async () => {
    lifecycle.d.syncObserver.close();
    const next = new SyncObserver({ env, now: f.now }); t.after(() => next.close());
    lifecycle.d.syncObserver = next;
    lifecycle.syncAlertEpisodes = new (await import('../sync-alert-episodes.js')).SyncAlertEpisodes({ env, now: f.now });
  };
  return { ...f, root, scene, lifecycle, context, observer, file, alerts, events, restart };
}

test('pre-reclaim group and Origin Sync survive six minutes and expire after fifteen', async t => {
  const f = observableFixture(t);
  // 16 is above the default Sync threshold of 15, so release prepares a group Sync.
  f.db.getUnsummarizedRange = () => ({ count: 16, firstAt: f.now(), firstConversationId: 1 });
  f.db.getOriginSyncBacklog = () => ({ total: 1, groups: [{ pendingCheckpoints: 0, firstAt: f.now() }] });
  const intent = { controlIds: [] };
  await f.lifecycle.prepareRelease(f.scene, f.context, intent);
  const rows = f.sqlite.prepare('SELECT id,raw_content,ack_deadline_at FROM control_queue ORDER BY id').all();
  assert.equal(rows.length, 3);
  for (const row of rows.slice(1)) assert.equal(row.ack_deadline_at, Math.floor(f.now() / 1000) + 900);
  f.advance(360000); f.db.expireTimedOutControls(Math.floor(f.now() / 1000));
  for (const row of rows.slice(1)) assert.equal(f.db.getControlById(row.id).status, 'pending');
  f.advance(541000); f.db.expireTimedOutControls(Math.floor(f.now() / 1000));
  for (const row of rows.slice(1)) assert.equal(f.db.getControlById(row.id).status, 'timeout');
  await f.lifecycle.syncAlerts(f.context);
  assert.equal(f.alerts().length, 0);
  assert.deepEqual(f.events('control_timeout').map(row => row.kind).sort(), ['group', 'origin']);
  const reasons = fs.readFileSync(f.file, 'utf8').trim().split('\n').map(JSON.parse).filter(row => row.event === 'sync_triggered');
  assert.equal(reasons.length, 2); assert.ok(reasons.every(row => row.reason.includes('pre_reclaim')));
});

