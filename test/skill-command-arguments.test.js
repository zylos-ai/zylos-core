import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = fileURLToPath(new URL('../', import.meta.url));
const documents = [
  ['skills/new-session/SKILL.md', 2],
  ['skills/comm-bridge/references/c4-control.md', 1],
];
const cases = [
  { name: 'unset', values: {} },
  { name: 'empty', values: { ZYLOS_SESSION_GROUP: '', ZYLOS_RUN_ID: '' } },
  { name: 'group only', values: { ZYLOS_SESSION_GROUP: 'multica' } },
  { name: 'run only', values: { ZYLOS_RUN_ID: 'run-id' } },
  { name: 'group and run', values: { ZYLOS_SESSION_GROUP: 'multica', ZYLOS_RUN_ID: 'run-id' } },
  { name: 'quoted values', values: { ZYLOS_SESSION_GROUP: 'group with * spaces', ZYLOS_RUN_ID: 'run with ? spaces' } },
];

// Cross-skill documentation contract: run when these examples change; unrelated
// product changes can skip it. Only parameter tails reach printf, never Node or
// c4-control. The runner supplies private HOME/ZYLOS_DIR/PM2_HOME/TMPDIR; shells
// skip startup files, have bounded output/time, and create no service or database.
for (const [file, count] of documents) {
  const text = fs.readFileSync(new URL(file, new URL('../', import.meta.url)), 'utf8');
  const commands = text.split('\n').filter(line => line.startsWith('node ')
    && line.includes('/c4-control.js enqueue ') && line.includes('--no-ack-suffix'));

  test(`${file} retains its session-switch examples`, () => assert.equal(commands.length, count));

  for (const [index, command] of commands.entries()) {
    const tail = command.slice(command.indexOf('--no-ack-suffix') + '--no-ack-suffix'.length).trim();
    for (const shell of ['bash', 'zsh']) {
      test(`${file} example ${index + 1} keeps optional arguments separate in ${shell}`, t => {
        const args = shell === 'bash' ? ['--noprofile', '--norc'] : ['-f'];
        const env = Object.fromEntries(['PATH', 'HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']
          .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
        const probe = spawnSync(shell, [...args, '-c', ':'], { env, cwd: repo, timeout: 5000 });
        if (probe.error?.code === 'ENOENT') {
          t.skip(`${shell} is not installed`);
          return;
        }
        assert.ifError(probe.error);
        assert.equal(probe.status, 0, probe.stderr?.toString());
        assert.match(tail, /^\$\{/);
        // Limit execution to variable expansions/quotes/whitespace, so a changed
        // example cannot accidentally introduce a command into this print probe.
        assert.match(tail, /^[\w\s${}:+"-]+$/);
        for (const { name, values } of cases) {
          const expected = [];
          if (values.ZYLOS_SESSION_GROUP) expected.push('--group', values.ZYLOS_SESSION_GROUP);
          if (values.ZYLOS_RUN_ID) expected.push('--target-run', values.ZYLOS_RUN_ID);
          const result = spawnSync(shell, [...args, '-c',
            `set -- ${tail}\nprintf 'argc=%s\\n' "$#"\nif [ "$#" -gt 0 ]; then printf '[%s]' "$@"; fi`],
          { env: { ...env, ...values }, cwd: repo, encoding: 'utf8', timeout: 5000, maxBuffer: 8192 });
          assert.ifError(result.error);
          assert.equal(result.status, 0, `${name}: ${result.stderr}`);
          assert.equal(result.stdout, `argc=${expected.length}\n${expected.map(value => `[${value}]`).join('')}`, name);
        }
      });
    }
  }
}
