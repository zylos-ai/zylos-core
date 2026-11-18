import test from 'node:test';
import assert from 'node:assert/strict';
import { createInstalledVersionReader } from '../installed-versions.js';

test('version commands run concurrently and refreshes share pending work', async () => {
  const calls = [];
  const releases = [];
  const read = createInstalledVersionReader({ run: (command, args, options) => {
    calls.push(command);
    assert.deepEqual(args, ['--version']);
    assert.equal(options.timeout, 5000);
    return new Promise(resolve => releases.push(() => resolve({ stdout: command === 'codex' ? 'codex-cli 1.2.3\n' : command === 'agy' ? 'Antigravity CLI 1.5.10\n' : '2.3.4 (CLI)\n' })));
  } });
  const first = read();
  assert.equal(read(), first);
  assert.equal(calls.length, 4);
  releases.forEach(release => release());
  assert.deepEqual(await first, { zylos: '2.3.4 (CLI)', claude: '2.3.4', codex: '1.2.3', agy: '1.5.10' });
});

test('failed version refreshes retain previous versions', async () => {
  let fail = false;
  const read = createInstalledVersionReader({ run: async () => {
    if (fail) throw new Error('unavailable');
    return { stdout: '1.2.3' };
  } });
  await read();
  fail = true;
  assert.deepEqual(await read(), { zylos: '1.2.3', claude: '1.2.3', codex: '1.2.3', agy: '1.2.3' });
});
