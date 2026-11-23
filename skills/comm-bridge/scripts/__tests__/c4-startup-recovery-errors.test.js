import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {test} from 'node:test';

const hookSource = new URL('../c4-session-init.js', import.meta.url);

function fixture(t, bootstrap) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hook-recovery-')));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  const stable = path.join(root, '.zylos/upgrade');
  const hook = path.join(root, 'hook/c4-session-init.js');
  for (const directory of [stable, path.dirname(hook), path.join(root, 'home'), path.join(root, 'pm2'), path.join(root, 'tmp')]) {
    fs.mkdirSync(directory, {recursive:true, mode:0o700});
  }
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  fs.copyFileSync(hookSource, hook);
  fs.writeFileSync(path.join(stable, 'active.json'), '{}', {mode:0o600});
  fs.writeFileSync(path.join(stable, 'maintenance.cjs'), 'module.exports = {};\n', {mode:0o600});
  fs.writeFileSync(path.join(stable, 'bootstrap.cjs'), bootstrap, {mode:0o600});
  return {root, stable, hook};
}

function runHook(f) {
  // No C4, SQLite, PM2 or runtime modules exist in this fixture. Reaching normal
  // startup imports would fail, so success proves the file-only recovery boundary.
  const env = {
    HOME:path.join(f.root, 'home'), ZYLOS_DIR:f.root, PM2_HOME:path.join(f.root, 'pm2'),
    TMPDIR:path.join(f.root, 'tmp'), TMUX_TMPDIR:path.join(f.root, 'tmp'), PATH:process.env.PATH,
  };
  const result = spawnSync(process.execPath, [f.hook], {
    cwd:f.root, env, encoding:'utf8', timeout:10000, maxBuffer:64*1024,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /=== UPGRADE RECOVERY TASK ===/);
  assert.equal(result.stderr, '');
  return result.stdout;
}

function details(output) {
  const start = output.lastIndexOf('\n{\n');
  const end = output.indexOf('\n=== END UPGRADE RECOVERY TASK ===', start);
  assert.ok(start >= 0 && end > start, 'displayed recovery block includes structured diagnostics');
  return JSON.parse(output.slice(start + 1, end));
}

// Boundary: real hook entry, trusted bootstrap failure, no normal database graph.
// Run when hook recovery formatting/discovery changes; unrelated routing may skip.
test('startup hook displays the discovery error code, cause and next action without loading C4', t => {
  const f = fixture(t, `exports.bootstrap = () => { throw Object.assign(Error('EACCES: cleanup code denied'), {
    code:'UPGRADE_RECOVERY_REQUIRED', next:'Run zylos recovery status, then zylos recovery resume.'
  }); };\n`);
  const output = runHook(f);
  assert.deepEqual(details(output), {
    code:'UPGRADE_RECOVERY_REQUIRED', error:'EACCES: cleanup code denied',
    next:'Run zylos recovery status, then zylos recovery resume.',
  });
  assert.equal(fs.existsSync(path.join(f.stable, 'active.json')), true);
});
