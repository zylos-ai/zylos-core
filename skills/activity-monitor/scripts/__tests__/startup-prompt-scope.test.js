import test from 'node:test';
import * as startupPrompt from '../session-start-prompt.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixture as storeFixture } from '../../../comm-bridge/scripts/__tests__/c4-v2-test-helpers.js';
import { enqueueStartupPrompt, isMigrationPending } from '../session-start-prompt.js';

test('migration is pending only when readable prompt content remains', () => {
  for (const content of ['', ' \n\t']) {
    assert.equal(isMigrationPending({ readFileSync: () => content }), false);
  }
  assert.equal(isMigrationPending({ readFileSync: () => '# Required action\n' }), true);
  assert.equal(isMigrationPending({ readFileSync() { throw Object.assign(Error('missing'), { code: 'ENOENT' }); } }), false);
});

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
  { name: 'handoff with an old outbound latest row', handoff: true, rows: [row('out', 31)], sent: true },
  { name: 'incoming at twenty-nine minutes', rows: [row('in', 29)], sent: true },
  { name: 'incoming at exactly thirty minutes', rows: [row('in', 30)], sent: true },
  { name: 'incoming at thirty-one minutes', rows: [row('in', 31)], sent: false },
  { name: 'latest outbound within the window', rows: [row('out', 29)], sent: false },
  { name: 'no recent conversations', rows: [], sent: false },
  { name: 'latest id inbound wins despite older timestamp', rows: [row('out', 1, { id: 1 }), row('in', 2, { id: 999 })], sent: true },
  { name: 'latest id outbound wins despite older timestamp', rows: [row('in', 1, { id: 1 }), row('out', 2, { id: 999 })], sent: false },
  { name: 'SQLite timestamp is interpreted as UTC', rows: [row('in', 29, { timestamp: '2026-11-10 23:31:00' })], sent: true },
  { name: 'system notice after an inbound does not answer it', rows: [row('in', 2, { id: 1 }), row('out', 1, { id: 2, delivery_action: 'system_notice' })], sent: true },
  { name: 'notice-only endpoint does not need a reply', rows: [row('out', 1, { delivery_action: 'system_notice' })], sent: false },
  { name: 'other channel output does not hide unanswered input', rows: [row('in', 2, { id: 1 }), row('out', 1, { id: 2, channel: 'lark' })], sent: true },
  { name: 'other endpoint output does not hide unanswered input', rows: [row('in', 2, { id: 1 }), row('out', 1, { id: 2, endpoint_id: 'another' })], sent: true },
  { name: 'every endpoint has been answered', rows: [row('in', 3, { id: 1 }), row('out', 2, { id: 2 }), row('out', 1, { id: 3, endpoint_id: 'another' })], sent: false },
  { name: 'checkpoint-covered input still needs a reply', rows: [row('in', 2)], checkpoint: true, sent: true },
  { name: 'pending input also counts as a conversation', rows: [row('in', 2, { status: 'pending' })], sent: true },
  { name: 'inbound labelled system notice still counts', rows: [row('in', 2, { delivery_action: 'system_notice' })], sent: true },
  { name: 'unanswered endpoint is not limited to six newest rows', rows: [row('in', 20, { id: 1 }), ...Array.from({ length: 7 }, (_, i) => row('out', 1, { id: i + 2, endpoint_id: 'busy-endpoint' }))], sent: true },
  { name: 'C4 read failure without handoff', rows: null, sent: true },
  { name: 'C4 read failure with handoff', handoff: true, rows: null, sent: true },
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

test('resume does not enqueue another startup prompt', async () => {
  const result = await enqueueStartupPrompt('resume', {
    execFile: async () => assert.fail('resume must not enqueue'),
  });
  assert.equal(result.reason, 'source');
});

for (const source of ['startup', 'clear']) test(`${source} migration prompt keeps its existing instruction-only content`, async () => {
  let call;
  await enqueueStartupPrompt(source, {
    onboardingPending: () => false, migrationPending: () => true,
    recentReader: () => assert.fail('migration must not read recent conversations'),
    scopeReader: async () => ({ sessionGroup: 'telegram:one' }),
    execFile: async (...args) => { call = args; return { stdout: '{"ok":true,"id":8}' }; },
  });
  const argv = call[1];
  assert.equal(argv[argv.indexOf('--content') + 1], [
    "A pending instruction migration was injected into this session's startup context.",
    'Treat it as the active task for this turn and execute its Required action now.',
    'Do not merely acknowledge or summarize it.',
    'Follow the steps in the migration prompt: read the system template, compare with ZYLOS.md,',
    'extract user-only content, and run `zylos migrate-instructions --apply --user-content <file>`.',
    'If genuinely blocked, report the concrete blocker.',
    'Meanwhile, reply to your human partner if they are waiting for your reply,',
    'and do not query c4.db for recent conversations unless explicitly required.',
  ].join(' '));
});

for (const source of ['startup', 'clear']) test(`${source} onboarding skip does not inspect scope or recent conversations`, async () => {
  const result = await enqueueStartupPrompt(source, {
    onboardingPending: () => true,
    scopeReader: () => assert.fail('onboarding must not read scope'),
    recentReader: () => assert.fail('onboarding must not read recent conversations'),
    execFile: () => assert.fail('onboarding must not enqueue'),
  });
  assert.deepEqual(result, { skipped: true, reason: 'onboarding_pending', startupControlIds: [] });
});

// Default-reader integration: private on-disk C4 through its public module, then
// real enqueue/close on repeated reads. Run for DB export/lifecycle or startup
// reader changes; pure prompt wording may skip. Official runner isolates all four
// home/instance/PM2/temp paths; no tmux/PM2/HTTP starts. Test closes C4 and runner
// removes its private DB; no child or background loop is created.
test('default startup reader reopens private C4 and ignores checkpoint coverage', async t => {
  const dbPath = path.join(process.env.ZYLOS_DIR, 'comm-bridge', 'c4.db');
  assert.ok(dbPath.startsWith(runnerRoot + path.sep));
  console.info('default reader isolation', JSON.stringify({ database: dbPath, tmux: 'unused',
    HOME: process.env.HOME, ZYLOS_DIR: process.env.ZYLOS_DIR, PM2_HOME: process.env.PM2_HOME, TMPDIR: process.env.TMPDIR }));
  const db = await import('../../../comm-bridge/scripts/c4-db.js');
  t.after(() => db.close());
  const c = db.getDb();
  assert.equal(c.name, dbPath);
  c.prepare(`INSERT INTO conversations(id,timestamp,direction,channel,endpoint_id,content,status,session_group)
    VALUES(1,?,'in','telegram','private','question','delivered','origin')`).run(new Date(clock - 29 * 60000).toISOString());
  db.createCheckpoint('origin', 1, 'already covered');
  assert.equal(c.open, true);
  const scope = { mode: 'multi', sessionGroup: 'origin', memoryDir: path.join(runnerRoot, 'no-handoff') };
  let enqueues = 0;
  const options = { onboardingPending: () => false, migrationPending: () => false,
    scopeReader: async () => scope, now: () => clock,
    execFile: async () => { enqueues++; return { stdout: '{"ok":true,"id":8}' }; } };
  assert.equal((await enqueueStartupPrompt('startup', options)).skipped, false);
  assert.equal(c.open, false, 'default reader must close the handle it used');
  const replyConnection = db.getDb();
  assert.notEqual(replyConnection, c, 'the next read must reopen C4');
  replyConnection.prepare(`INSERT INTO conversations(id,timestamp,direction,channel,endpoint_id,content,status,session_group)
    VALUES(2,?,'out','telegram','private','reply','delivered','origin')`).run(new Date(clock).toISOString());
  assert.equal(replyConnection.open, true);
  assert.equal((await enqueueStartupPrompt('clear', options)).reason, 'nothing_pending');
  assert.equal(replyConnection.open, false, 'default reader must close on a skip too');
  assert.equal(enqueues, 1);
});
