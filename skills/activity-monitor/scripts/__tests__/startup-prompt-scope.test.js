import test from 'node:test';
import assert from 'node:assert/strict';
import { enqueueStartupPrompt, isMigrationPending } from '../session-start-prompt.js';

test('migration is pending only when readable prompt content remains', () => {
  for (const content of ['', ' \n\t']) {
    assert.equal(isMigrationPending({ readFileSync: () => content }), false);
  }
  assert.equal(isMigrationPending({ readFileSync: () => '# Required action\n' }), true);
  assert.equal(isMigrationPending({ readFileSync() { throw Object.assign(Error('missing'), { code: 'ENOENT' }); } }), false);
});

for (const sessionGroup of [null, 'origin', 'telegram:g-100123']) {
  test(`startup prompt targets its current scope: ${sessionGroup ?? 'single'}`, async () => {
    let call;
    const result = await enqueueStartupPrompt('startup', {
      onboardingPending: () => false,
      migrationPending: () => false,
      scopeReader: async () => ({ sessionGroup }),
      execFile: async (...args) => { call = args; return { stdout: '{"ok":true,"id":7}' }; },
    });
    assert.deepEqual(result.startupControlIds, [7]);
    const argv = call[1];
    assert.equal(argv.filter(arg => arg === '--group').length, sessionGroup ? 1 : 0);
    if (sessionGroup) assert.equal(argv[argv.indexOf('--group') + 1], sessionGroup);
    const prompt = argv[argv.indexOf('--content') + 1];
    assert.match(prompt, /read the supplied handoff in full before resuming work/);
    assert.match(prompt, /read working-memory paths on demand/);
    assert.doesNotMatch(prompt, /read the supplied handoff and working-memory paths on demand/);
    assert.doesNotMatch(prompt, /startup memory.*already injected/);
  });
}

test('resume does not enqueue another startup prompt', async () => {
  const result = await enqueueStartupPrompt('resume', {
    execFile: async () => assert.fail('resume must not enqueue'),
  });
  assert.equal(result.reason, 'source');
});

test('migration startup prompt keeps its existing instruction-only content', async () => {
  let call;
  await enqueueStartupPrompt('startup', {
    onboardingPending: () => false, migrationPending: () => true,
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
