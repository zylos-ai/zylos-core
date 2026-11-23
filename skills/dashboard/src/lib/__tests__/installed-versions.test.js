import test from 'node:test';
import assert from 'node:assert/strict';
import { createInstalledVersionReader } from '../installed-versions.js';
import { getRuntime } from '../../../../../cli/lib/runtime/index.js';

function probeRuntime(id, execFile) {
  return getRuntime(id).then(rt => rt.install.probeVersion({
    profile: 'dashboard', env: { [`${id.toUpperCase()}_BIN`]: process.execPath }, execFile,
  }));
}

test('version commands run concurrently and refreshes share pending work', async () => {
  const calls = new Set();
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const read = createInstalledVersionReader({
    run: async (command, args, options) => {
      calls.add(command);
      assert.deepEqual(args, ['--version']);
      assert.equal(options.timeout, 5000);
      await pending;
      return { stdout: '2.3.4 (CLI)\n' };
    },
    probe: id => {
      calls.add(id);
      return probeRuntime(id, async (command, args, options) => {
        assert.equal(command, process.execPath);
        assert.deepEqual(args, ['--version']);
        assert.equal(options.timeout, 5000);
        await pending;
        const stdout = { claude: '2.3.4 (CLI)\n', codex: 'codex-cli 1.2.3\n', agy: 'Antigravity CLI 1.5.10\n' }[id];
        return { stdout };
      });
    },
  });
  const first = read();
  assert.equal(read(), first);
  assert.deepEqual(calls, new Set(['zylos', 'claude', 'codex', 'agy']));
  release();
  assert.deepEqual(await first, { zylos: '2.3.4 (CLI)', claude: '2.3.4', codex: '1.2.3', agy: '1.5.10' });
});

test('failed version refreshes retain previous versions', async () => {
  let fail = false;
  const results = [];
  const execute = async () => {
    if (fail) throw new Error('unavailable');
    return { stdout: '1.2.3' };
  };
  const read = createInstalledVersionReader({
    run: execute,
    probe: async id => {
      const result = await probeRuntime(id, execute);
      results.push([id, result]);
      return result;
    },
  });
  await read();
  fail = true;
  assert.deepEqual(await read(), { zylos: '1.2.3', claude: '1.2.3', codex: '1.2.3', agy: '1.2.3' });
  const failed = new Map(results.slice(3));
  for (const id of ['claude', 'codex', 'agy']) {
    assert.deepEqual(failed.get(id), { installed: true, version: null, probeFailed: true });
  }
});
