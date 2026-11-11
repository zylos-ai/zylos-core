import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { enqueueStartupPrompt, isMigrationPending } from '../session-start-prompt.js';

test('migration is pending only when readable prompt content remains', () => {
  for (const content of ['', ' \n\t']) {
    assert.equal(isMigrationPending({ readFileSync: () => content }), false);
  }
  assert.equal(isMigrationPending({ readFileSync: () => '# Required action\n' }), true);
  assert.equal(isMigrationPending({ readFileSync() { throw Object.assign(Error('missing'), { code: 'ENOENT' }); } }), false);
});

// Pure startup policy boundary: official runner-owned paths, private handoff
// files and injected tail/clock/enqueue. No HTTP, C4 DB, PM2 or tmux is opened.
const runnerRoot = path.dirname(process.env.HOME);
assert.match(path.basename(runnerRoot), /^zylos-tests-/);
for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) {
  assert.ok(path.isAbsolute(process.env[key]), key);
  assert.ok(process.env[key].startsWith(runnerRoot + path.sep), key);
}
console.info('Startup policy isolation', JSON.stringify(Object.fromEntries(
  ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR'].map(key => [key, process.env[key]]))),
  'C4 DB/HTTP/PM2/tmux unused');
const clock = Date.parse('2026-11-11T00:00:00.000Z');
const row = (direction, minutes, extra = {}) => ({ direction, timestamp: new Date(clock - minutes * 60000).toISOString(),
  id: 123, content: 'PRIVATE MESSAGE NOT FOR THE STARTUP PROMPT', endpoint_id: 'private-endpoint', ...extra });
const policies = [
  { name: 'handoff with no recent conversations', handoff: true, rows: [], sent: true },
  { name: 'handoff with an old outbound latest row', handoff: true, rows: [row('out', 31)], sent: true },
  { name: 'incoming at twenty-nine minutes', rows: [row('in', 29)], sent: true },
  { name: 'incoming at exactly thirty minutes', rows: [row('in', 30)], sent: true },
  { name: 'incoming at thirty-one minutes', rows: [row('in', 31)], sent: false },
  { name: 'latest outbound within the window', rows: [row('out', 29)], sent: false },
  { name: 'no recent conversations', rows: [], sent: false },
  { name: 'latest timestamp outbound wins over the later array position inbound', rows: [row('out', 1, { id: 1 }), row('in', 2, { id: 999 })], sent: false },
  { name: 'latest timestamp inbound wins over the later array position outbound', rows: [row('in', 1, { id: 1 }), row('out', 2, { id: 999 })], sent: true },
  { name: 'SQLite timestamp is interpreted as UTC', rows: [row('in', 29, { timestamp: '2026-11-10 23:31:00' })], sent: true },
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
    const calls = []; let tailReads = 0;
    const result = await enqueueStartupPrompt(source, {
      onboardingPending: () => false, migrationPending: () => false,
      scopeReader: async () => scope, now: () => clock,
      recentReader: async received => {
        assert.equal(received, scope); tailReads++;
        if (!policy.rows) throw new Error('fixture C4 read failed');
        return { coverage: 0, conversations: policy.rows };
      },
      execFile: async (...args) => { assert.ok(calls.length < 2); calls.push(args); return { stdout: '{"ok":true,"id":7}' }; },
    });
    if (!policy.sent) {
      assert.equal(result.skipped, true);
      assert.equal(result.reason, 'nothing_pending');
      assert.equal(result.startupControlIds.length, 0);
      assert.equal(calls.length, 0);
      assert.equal(tailReads, 1);
      return;
    }
    assert.equal(result.skipped, false);
    assert.equal(result.startupControlIds.length, 1);
    assert.equal(result.startupControlIds[0], 7);
    assert.equal(calls.length, 1);
    assert.equal(tailReads, policy.handoff ? 0 : 1);
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
