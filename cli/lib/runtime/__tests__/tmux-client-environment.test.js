import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { runTmuxCommand } from '../tmux-connection.js';

test('tmux clients omit only session identity and preserve the caller environment', async () => {
  const names = ['ZYLOS_RUN_ID', 'ZYLOS_MODEL_CONFIG', 'ZYLOS_SESSION_GROUP', 'ZYLOS_OTHER_VALUE'];
  const previous = names.map(name => process.env[name]);
  try {
    for (const name of names) process.env[name] = `value-${name}`;
    const expected = { ...process.env };
    for (const name of names.slice(0, 3)) delete expected[name];
    for (const noServerStart of [true, false]) {
      // Node is the client executable here: inspect the actual spawned process,
      // including both command options, without mocking child_process.
      const output = await runTmuxCommand(['list-sessions'], {
        binary: fileURLToPath(new URL('./fixtures/client-environment.js', import.meta.url)), noServerStart,
      });
      assert.deepEqual(JSON.parse(output), expected);
      for (const name of names) assert.equal(process.env[name], `value-${name}`);
    }
  } finally {
    names.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name];
      else process.env[name] = previous[index];
    });
  }
});
