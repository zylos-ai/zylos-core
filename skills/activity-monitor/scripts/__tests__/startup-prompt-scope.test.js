import test from 'node:test';
import * as startupPrompt from '../session-start-prompt.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixture as storeFixture } from '../../../comm-bridge/scripts/__tests__/c4-v2-test-helpers.js';
import { enqueueStartupPrompt } from '../session-start-prompt.js';

// Startup policy/query integration: actual store SQL -> prompt producer with
// private handoff paths and an in-memory SQLite DB. Run for startup/query/scope
// changes; unrelated UI skips. Official runner isolates HOME/ZYLOS_DIR/PM2_HOME/
// short TMPDIR before imports; no HTTP/PM2/tmux starts. Teardown closes each DB
// and removes private files; no live DB, service, terminal or model is used.
const runnerRoot = path.dirname(process.env.HOME);
assert.match(path.basename(runnerRoot), /^zylos-tests-/);
for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) {
  assert.ok(path.isAbsolute(process.env[key]), key);
  assert.ok(process.env[key].startsWith(runnerRoot + path.sep), key);
}
console.info('Startup policy isolation', JSON.stringify(Object.fromEntries(
  ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR'].map(key => [key, process.env[key]]))),
  'C4 database=:memory:, HTTP/PM2/tmux unused');
const clock = Date.parse('2026-11-11T00:00:00.000Z');
const row = (direction, minutes, extra = {}) => ({ direction, timestamp: new Date(clock - minutes * 60000).toISOString(),
  id: 123, channel: 'telegram', content: 'PRIVATE MESSAGE NOT FOR THE STARTUP PROMPT', endpoint_id: 'private-endpoint', ...extra });
const policies = [
  { name: 'handoff with no recent conversations', handoff: true, rows: [], sent: true },
  { name: 'incoming at twenty-nine minutes', rows: [row('in', 29)], sent: true },
  { name: 'latest outbound within the window', rows: [row('out', 29)], sent: false },
];

for (const source of ['startup', 'clear']) for (const sessionGroup of [null, 'origin', 'telegram:g-100123']) for (const policy of policies) {
  test(`${source} in ${sessionGroup ?? 'single'} handles ${policy.name}`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-prompt-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const memoryDir = path.join(root, 'scope'); fs.mkdirSync(memoryDir);
    // An unrelated scope's handoff must not affect this scope's decision.
    fs.writeFileSync(path.join(root, 'handoff.md'), 'other scope');
    if (policy.handoff) fs.writeFileSync(path.join(memoryDir, 'handoff.md'), 'unfinished work');
    const scope = { sessionGroup, memoryDir, mode: sessionGroup ? 'multi' : 'single' };
    const { db, store } = storeFixture(t);
    assert.equal(db.name, ':memory:');
    const insert = db.prepare(`INSERT INTO conversations
      (id,timestamp,direction,channel,endpoint_id,content,status,delivery_action,session_group)
      VALUES (@id,@timestamp,@direction,@channel,@endpoint_id,@content,@status,@delivery_action,@session_group)`);
    for (const entry of policy.rows ?? []) insert.run({ status: 'delivered', delivery_action: null,
      session_group: sessionGroup ?? 'origin', ...entry });
    if (policy.checkpoint) store.createCheckpoint(sessionGroup ?? '*', 123, 'already summarized');
    // Recent input outside this multi scope must not prompt this session.
    if (sessionGroup) insert.run({ ...row('in', 1, { id: 1000 }), status: 'delivered',
      delivery_action: null, session_group: 'telegram:unrelated' });
    if (policy.rows && !policy.handoff) {
      // Assert SQL independently: fail-open must not hide a broken query.
      assert.equal(await startupPrompt.readStartupPendingReply(scope, clock, { database: store }), policy.sent);
    }
    const calls = []; let recentReads = 0;
    const result = await enqueueStartupPrompt(source, {
      onboardingPending: () => false, migrationPending: () => false,
      scopeReader: async () => scope, now: () => clock,
      recentReader: async (received, time) => {
        assert.equal(received, scope); assert.equal(time, clock); recentReads++;
        if (!policy.rows) throw new Error('fixture C4 read failed');
        return startupPrompt.readStartupPendingReply(received, time, { database: store });
      },
      execFile: async (...args) => { assert.ok(calls.length < 2); calls.push(args); return { stdout: '{"ok":true,"id":7}' }; },
    });
    if (!policy.sent) {
      assert.equal(result.skipped, true);
      assert.equal(result.reason, 'nothing_pending');
      assert.equal(result.startupControlIds.length, 0);
      assert.equal(calls.length, 0);
      assert.equal(recentReads, 1);
      return;
    }
    assert.equal(result.skipped, false);
    assert.equal(result.startupControlIds.length, 1);
    assert.equal(result.startupControlIds[0], 7);
    assert.equal(calls.length, 1);
    assert.equal(recentReads, policy.handoff ? 0 : 1);
    const argv = calls[0][1];
    assert.equal(argv.filter(arg => arg === '--group').length, sessionGroup ? 1 : 0);
    if (sessionGroup) assert.equal(argv[argv.indexOf('--group') + 1], sessionGroup);
    const prompt = argv[argv.indexOf('--content') + 1];
    assert.match(prompt, /human partner.*waiting.*reply/i);
    assert.match(prompt, /decide whether to reply/i);
    assert.match(prompt, /read working-memory paths on demand/i);
    assert.match(prompt, /do not query c4\.db for recent conversations/i);
    assert.doesNotMatch(prompt, /read the supplied handoff|no handoff is available/i);
    assert.doesNotMatch(prompt, /PRIVATE MESSAGE|private-endpoint|123/);
    if (policy.handoff) assert.match(prompt, /continue the unfinished work listed in the supplied handoff/i);
    else assert.doesNotMatch(prompt, /handoff|continue.*(?:ongoing|unfinished).*tasks/i);
  });
}

// Single-session Origin must query only its own unanswered conversations.
// In-memory store only; the existing policy matrix covers timing and routing.
test('single-session Origin pending replies are scoped by environment group', async t => {
  const { db, store } = storeFixture(t);
  const insert = db.prepare(`INSERT INTO conversations
    (id,timestamp,direction,channel,endpoint_id,content,status,session_group)
    VALUES (?,?,'in','telegram','private','question','delivered',?)`);
  const scope = { mode: 'single', sessionGroup: 'origin' };
  insert.run(1, new Date(clock - 60000).toISOString(), 'telegram:unrelated');
  assert.equal(await startupPrompt.readStartupPendingReply(scope, clock, { database: store }), false);
  insert.run(2, new Date(clock - 60000).toISOString(), 'origin');
  assert.equal(await startupPrompt.readStartupPendingReply(scope, clock, { database: store }), true);
});

