import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SupervisorLifecycle } from '../skills/activity-monitor/scripts/supervisor-lifecycle.js';
import { SessionActivity } from '../skills/activity-monitor/scripts/session-activity.js';

// Boundary: real transcript sampling composed with lifecycle deferral. Run when
// idle reset, transcript activity or timestamp-only touches change; unrelated
// request parsing may skip. Private files, in-memory DB/transport and injected clock avoid live
// tmux/PM2/network; the official runner isolates every runtime path.
test('accepted deferral and transcript appends reset idle while timestamp-only touches preserve the deadline', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deferred-transcript-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  console.log('Transcript isolation:', JSON.stringify({ root, HOME: process.env.HOME, ZYLOS_DIR: process.env.ZYLOS_DIR, PM2_HOME: process.env.PM2_HOME, TMPDIR: process.env.TMPDIR, database: 'injected', transport: 'injected' }));
  let now = 2000000;
  const scene = { sessionGroup: 'a', runId: 'run-a', sessionId: 'session-1', runtime: 'claude',
    present: true, ready: true, processRunning: true, createdAt: 0, runDir: root,
    launchConfig: { runtime: 'claude', mode: 'default' } };
  const controls = [], fences = [];
  const context = { configuration: { mode: 'multi', hotTtlSeconds: 1800 }, scenes: [scene], fences, restartRequests: [] };
  const db = { getModeTransition: () => null, listDrainFences: () => fences,
    getLastActivity: () => ({ ts: 0 }), getUnsummarizedRange: () => ({ count: 0 }),
    resolveSessionLaunchConfig: () => scene.launchConfig,
    getControlById: id => controls.find(row => row.id === id),
    insertControl: (content, options) => { const row = { id: controls.length + 1, status: 'pending', content, ...options }; controls.push(row); return row; },
    setDrainFence: (group, fence) => fences.push({ sessionGroup: group, ...fence }) };
  const lifecycle = new SupervisorLifecycle({ db, observeGroup: () => scene, requests: { read: () => [] },
    bindTarget: () => ({ expectedRunId: scene.runId }),
    prompts: { PRE_RECLAIM_CHECK_PROMPT: 'check' } }, { now: () => now });
  const transcript = path.join(root, 'transcript.jsonl');
  fs.writeFileSync(transcript, '{}\n'); fs.utimesSync(transcript, 0, 0);
  const activity = new SessionActivity({ runDir: root, runId: 'run-a', sessionId: 'session-1', runtime: 'claude' });
  t.after(() => activity.close());
  activity.associateTranscript({ event: 'session_start', transcript_path: transcript });
  Object.assign(scene, activity.read(now - 5000));
  await lifecycle.checkTtl(scene, context);
  assert.equal((await lifecycle.deferReclaim({ sessionGroup: 'a', expectedRunId: 'run-a', reason: 'background watcher' }, context)).ok, true);
  for (const control of controls) control.status = 'done';
  Object.assign(scene, activity.read(now)); await lifecycle.checkTtl(scene, context);
  assert.equal(lifecycle.ttlPreparation.has('a'), false);
  assert.equal(lifecycle.ttlReset.get('a').at, now);
  assert.equal(fences.length, 0);
  now += 1000;
  fs.appendFileSync(transcript, '{}\n'); fs.utimesSync(transcript, now / 1000, now / 1000);
  Object.assign(scene, activity.read(now)); assert.equal(scene.lastActivityAt, now);
  await lifecycle.checkTtl(scene, context);
  assert.equal(lifecycle.ttlPreparation.has('a'), false);
  assert.equal(lifecycle.ttlReset.get('a').at, now - 1000); assert.equal(fences.length, 0);
  assert.equal(lifecycle.reclaimDeferrals.get('a').count, 1);
  const lastWriteAt = now, size = fs.statSync(transcript).size;
  now += 1799999;
  fs.utimesSync(transcript, now / 1000, now / 1000);
  assert.equal(fs.statSync(transcript).size, size);
  assert.ok(Math.abs(fs.statSync(transcript).mtimeMs - now) < 1, 'touch updates mtime within filesystem precision');
  Object.assign(scene, activity.read(now));
  assert.equal(scene.lastActivityAt, lastWriteAt);
  assert.equal(scene.state, 'idle');
  await lifecycle.checkTtl(scene, context);
  assert.equal(controls.length, 1, 'transcript activity postpones the next idle check');
  now += 1; Object.assign(scene, activity.read(now)); await lifecycle.checkTtl(scene, context);
  assert.equal(controls.length, 2);
  assert.equal(lifecycle.ttlPreparation.has('a'), true, 'touch does not postpone preparation at hotTtlSeconds');
});
