import test from 'node:test';
import assert from 'node:assert/strict';
import { enqueueStartupPrompt } from '../session-start-prompt.js';

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
    assert.match(prompt, /read the supplied handoff and working-memory paths on demand/);
    assert.doesNotMatch(prompt, /startup memory.*already injected/);
  });
}

test('resume does not enqueue another startup prompt', async () => {
  const result = await enqueueStartupPrompt('resume', {
    execFile: async () => assert.fail('resume must not enqueue'),
  });
  assert.equal(result.reason, 'source');
});
