import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const [mode, fixture] = process.argv.slice(2);
const root = fs.realpathSync(fixture);
for (const [key, leaf] of [['HOME', 'home'], ['ZYLOS_DIR', 'home/zylos'], ['PM2_HOME', 'pm2'], ['TMPDIR', 'tmp'], ['CODEX_HOME', 'home/.codex']]) {
  assert.equal(process.env[key], path.join(root, leaf));
}
assert.equal(process.env.PATH, path.join(root, 'empty-bin'));
assert.equal(fs.readdirSync(process.env.PATH).length, 0, 'No real package, runtime or service executable is reachable');
try {
  if (mode === 'reset') {
    const { resetManagedState } = await import('../../cli/commands/init.js');
    resetManagedState();
  } else if (mode === 'component') {
    const { uninstallComponent } = await import('../../cli/commands/component.js');
    await uninstallComponent(['fixture', '--yes', '--purge', '--json']);
  } else if (mode === 'self' || mode === 'self-preserve') {
    const { selfUninstall } = await import('../../cli/commands/self-uninstall.js');
    if (mode === 'self-preserve') {
      const readline = (await import('node:readline')).default;
      const previous = readline.createInterface;
      const answers = ['y', 'n'];
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
      readline.createInterface = () => ({
        question(_question, answer) { assert.ok(answers.length); queueMicrotask(() => answer(answers.shift())); }, close() {},
      });
      try { await selfUninstall([]); assert.equal(answers.length, 0); }
      finally { readline.createInterface = previous; }
    } else await selfUninstall(['--force']);
  } else throw new Error('Unknown fixture operation');
  console.log(JSON.stringify({ ok: true }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, code: error.code, message: error.message }));
}
