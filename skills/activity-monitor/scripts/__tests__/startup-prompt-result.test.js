import test from 'node:test';
import * as startupPrompt from '../session-start-prompt.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { publishBootstrapReady } from '../bootstrap-ready.js';
import { enqueueStartupPrompt } from '../session-start-prompt.js';
import { fixture as storeFixture } from '../../../comm-bridge/scripts/__tests__/c4-v2-test-helpers.js';
import { routerFixture } from '../../../comm-bridge/scripts/__tests__/helpers/router-fixture.js';

// Publication/consumer integration: actual startup producer, atomic READY write
// and Router adoption, with fixture identities and in-memory C4. Run for startup
// outcome propagation; unrelated UI may skip. Root runner isolates all home,
// instance, PM2, temp and socket paths before imports. No terminal/service starts;
// t tears down the router, database and private READY directory.
for (const outcome of ['skipped', 'failed', 'legacy']) {
  test(`startup ${outcome} outcome has the corresponding adoption diagnostic once`, async t => {
    const f = routerFixture(t); f.put('origin'); const live = f.put('a');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-result-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const record = await publishBootstrapReady({ source: 'startup', session_id: live.sessionId }, {
      env: { ZYLOS_RUN_ID: live.runId }, scopeReader: async () => ({ dir }), identityReader: async () => ({}), now: f.now,
      enqueue: outcome === 'skipped'
        ? source => enqueueStartupPrompt(source, { onboardingPending: () => true, execFile: () => assert.fail('skip must not enqueue') })
        : async () => { throw new Error('private fixture queue unavailable'); },
    });
    if (outcome === 'legacy') delete record.startupPrompt;
    f.current.set('a', record);
    const router = f.create(); await router.initialize(); await f.rounds(3);
    const events = f.events.filter(row => row.session_group === 'a' && row.event.startsWith('startup_prompt_'));
    assert.equal(events.length, 1);
    assert.equal(events[0].event, outcome === 'skipped' ? 'startup_prompt_skipped' : 'startup_prompt_missing');
    assert.equal(events[0].reason, outcome === 'skipped' ? 'onboarding_pending' : outcome === 'failed' ? 'enqueue_failed' : 'unknown');
    assert.equal(record.startupControlIds.length, 0);
  });
}

// Real enqueue policy -> atomic READY publication, with private handoff/run paths,
// private SQLite query and no child/network/service/terminal start. Run for
// startup skip/publication changes; unrelated rendering or queue internals skip.
// The official runner owns HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR before imports;
// every case checks these paths and deletes its private READY files on teardown.
for (const source of ['startup', 'clear']) for (const sessionGroup of [null, 'origin', 'telegram:ready']) {
  for (const last of ['empty', 'out', 'old-in']) test(`${source} publishes nothing_pending for ${sessionGroup ?? 'single'} with ${last} recent conversations`, async t => {
    const runnerRoot = path.dirname(process.env.HOME);
    assert.match(path.basename(runnerRoot), /^zylos-tests-/);
    for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) assert.ok(process.env[key]?.startsWith(runnerRoot + path.sep), key);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-ready-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const memoryDir = path.join(root, 'memory'); fs.mkdirSync(memoryDir);
    const scope = { dir: path.join(root, 'run'), memoryDir, sessionGroup, mode: sessionGroup ? 'multi' : 'single' };
    const time = Date.parse('2026-11-11T00:00:00.000Z');
    const { db, store } = storeFixture(t);
    assert.equal(db.name, ':memory:');
    if (last !== 'empty') db.prepare(`INSERT INTO conversations
      (direction,timestamp,channel,endpoint_id,content,status,session_group)
      VALUES(?,?,?,?,?,'delivered',?)`).run(last === 'out' ? 'out' : 'in',
        new Date(time - (last === 'old-in' ? 31 : 1) * 60000).toISOString(),
        'telegram', 'fixture', 'private row', sessionGroup ?? 'origin');
    console.info('READY publication isolation', JSON.stringify({
      HOME: process.env.HOME, ZYLOS_DIR: process.env.ZYLOS_DIR, PM2_HOME: process.env.PM2_HOME,
      TMPDIR: process.env.TMPDIR, readyFile: path.join(scope.dir, 'current-session.json'),
      handoff: path.join(memoryDir, 'handoff.md'), database: db.name, tmux: 'unused',
    }));
    const record = await publishBootstrapReady({ source, session_id: 'session-fixture' }, {
      env: { ZYLOS_RUN_ID: 'run-fixture' }, scopeReader: async () => scope,
      identityReader: async () => ({}), now: () => time,
      enqueue: actualSource => enqueueStartupPrompt(actualSource, {
        onboardingPending: () => false, migrationPending: () => false,
        scopeReader: async () => scope, now: () => time,
        recentReader: (scope, time) => startupPrompt.readStartupPendingReply(scope, time, { database: store }),
        execFile: () => assert.fail('nothing pending must not enqueue'),
      }),
    });
    const saved = JSON.parse(fs.readFileSync(path.join(scope.dir, 'current-session.json'), 'utf8'));
    for (const value of [record, saved]) {
      assert.deepEqual(value.startupPrompt, { state: 'skipped', reason: 'nothing_pending' });
      assert.equal(value.startupControlIds.length, 0);
      assert.equal(value.runId, 'run-fixture');
      assert.equal(value.sessionId, 'session-fixture');
    }
    assert.deepEqual(fs.readdirSync(scope.dir), ['current-session.json']);
  });
}
