import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { HealthStore } from '../health-store.js';

// legacy singleton takeover: crash at the real atomic publish boundary,
// preserving original notice destination and never replaying an uncertain send.
for (const status of ['pending', 'sending']) for (const phase of ['before', 'after']) {
  test(`health singleton migration ${status}, SIGKILL ${phase} rename is idempotent`, { timeout: 10000 }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'health-migration-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const store = new HealthStore({ zylosDir: root, now: () => 100000 });
    const state = store.read();
    state.health = 'rate_limited'; state.reason = 'rate_limit_unclassified';
    state.last_processed = { received_at: 90000, event_id: 'old-event' };
    state.pending_notice = { event_id: 'old-event', conversation_id: 12, channel: 'fake', endpoint: 'frozen-target',
      health: 'rate_limited', reason: 'rate_limit_unclassified', notice: { noticeCode: 'rate_limited' },
      created_at: 90000, session_id: 'old-session', claude_pid: 123, error: 'rate_limit', status };
    state.last_notice_outcome = { event_id: 'prior-event', status: 'sent', observed_at: 80000 };
    store.write(state);
    const file = store.file, raw = JSON.parse(fs.readFileSync(file));
    const { pendingNotice, ...oldHook } = raw.hook.groups.origin;
    delete raw.hook.groups; Object.assign(raw.hook, oldHook); raw.pendingNotice = pendingNotice;
    fs.writeFileSync(file, JSON.stringify(raw)); const original = fs.readFileSync(file, 'utf8');
    const script = `import fs from 'node:fs';
      import { HealthStore } from ${JSON.stringify(new URL('../health-store.js', import.meta.url).href)};
      const original = fs.renameSync;
      fs.renameSync = (from, to) => {
        if (to !== process.env.MIGRATION_FILE) return original(from, to);
        if (process.env.MIGRATION_PHASE === 'after') original(from, to);
        fs.writeSync(1, 'publish-boundary\\n');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      };
      new HealthStore({ zylosDir: process.env.MIGRATION_ROOT, now: () => 100001 }).read();`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, MIGRATION_FILE: file, MIGRATION_ROOT: root, MIGRATION_PHASE: phase }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    let errors = ''; child.stderr.on('data', data => { errors += data; });
    await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw new Error(errors || 'child exited before publish'); })]);
    if (phase === 'before') assert.equal(fs.readFileSync(file, 'utf8'), original);
    else assert.ok(JSON.parse(fs.readFileSync(file)).hook.groups.origin);
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    const recovered = new HealthStore({ zylosDir: root, now: () => 100002 }).read();
    assert.equal(recovered.health, 'rate_limited'); assert.equal(recovered.last_processed.event_id, 'old-event');
    assert.deepEqual(Object.keys(recovered.groups), ['origin']);
    if (status === 'pending') {
      assert.equal(recovered.pending_notice.status, 'pending'); assert.equal(recovered.pending_notice.endpoint, 'frozen-target');
      assert.equal(recovered.pending_notice.conversation_id, 12); assert.equal(recovered.last_notice_outcome.event_id, 'prior-event');
    } else {
      assert.equal(recovered.pending_notice, undefined); assert.equal(recovered.last_notice_outcome.status, 'uncertain');
      assert.equal(recovered.last_notice_outcome.event_id, 'old-event');
    }
    const saved = fs.readFileSync(file, 'utf8'); new HealthStore({ zylosDir: root, now: () => 100003 }).read();
    assert.equal(fs.readFileSync(file, 'utf8'), saved);
  });
}
