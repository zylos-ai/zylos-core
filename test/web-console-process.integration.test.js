import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { finalizeWebConsoleRemoval } from '../cli/lib/web-console-finalize.js';
import { savePm2ProcessList } from '../cli/lib/pm2-save.js';

// Covers native PM2 delete-by-id and startup persistence after a post-cutoff
// interruption. Run for cleanup/save ordering changes; skip when native PM2 is
// unavailable or isolation cannot be proved. No real upgrade or data is used.
// Every case isolates HOME, ZYLOS_DIR, PM2_HOME, short TMPDIR, private tmux socket
// and synthetic database paths; all children are stopped on failure/timeout.
test('native PM2 forward cleanup preserves another instance and survives resurrect', {
  skip:process.env.RUN_WEB_CONSOLE_NATIVE !== '1', timeout:60000,
}, async t => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wc-pm2-')));
  const root = path.join(base, 'zylos'), other = path.join(base, 'other');
  const old = {HOME:process.env.HOME, ZYLOS_DIR:process.env.ZYLOS_DIR, PM2_HOME:process.env.PM2_HOME, TMPDIR:process.env.TMPDIR, TMUX:process.env.TMUX};
  const env = {...process.env, HOME:path.join(base, 'home'), ZYLOS_DIR:root,
    PM2_HOME:path.join(base, 'pm2'), TMPDIR:path.join(base, 'tmp'), TMUX:''};
  for (const directory of [env.HOME, env.ZYLOS_DIR, env.PM2_HOME, env.TMPDIR]) {
    fs.mkdirSync(directory, {recursive:true});
    assert.ok(fs.realpathSync(directory).startsWith(base + path.sep));
  }
  console.log(JSON.stringify({isolation:{HOME:env.HOME, ZYLOS_DIR:root, PM2_HOME:env.PM2_HOME,
    TMPDIR:env.TMPDIR, tmuxSocket:path.join(base,'private-tmux'), database:path.join(root,'scheduler/scheduler.db')}}));
  const run = (command, args, options = {}) => execFileSync(command, args, {...options, env, encoding:'utf8', stdio:'pipe', timeout:10000});
  const pm2 = (...args) => run('pm2', args);
  t.after(() => {
    try { pm2('kill'); } finally {
      for (const [key,value] of Object.entries(old)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      fs.rmSync(base, {recursive:true, force:true});
    }
  });
  Object.assign(process.env, env);
  const script = owner => path.join(owner, '.claude/skills/web-console/scripts/server.cjs');
  for (const owner of [root,other]) {
    fs.mkdirSync(path.dirname(script(owner)), {recursive:true});
    fs.writeFileSync(script(owner), 'setInterval(() => {}, 1000);\n');
    pm2('start', script(owner), '--name', 'web-console', '--cwd', owner);
  }
  const list = () => {
    const output = pm2('jlist');
    const index = output.search(/(?:^|\n)\s*\[(?:\s*\{|\s*\])/);
    return JSON.parse(output.slice(index).trim());
  };
  assert.equal(list().filter(row => row.name === 'web-console').length, 2);
  pm2('save', '--force');
  pm2('kill');
  pm2('resurrect');
  assert.equal(list().filter(row => row.name === 'web-console').length, 2);
  const result = await finalizeWebConsoleRemoval({zylosDir:root, noCaddy:true}, {run, inspectTasks:()=>[]});
  assert.equal(result.pm2Changed, true);
  assert.equal(list().filter(row => row.name === 'web-console').length, 1);
  assert.equal(list().find(row => row.name === 'web-console').pm2_env.pm_exec_path, script(other));
  assert.equal(savePm2ProcessList({root, save:()=>pm2('save', '--force')}), true);
  pm2('kill');
  pm2('resurrect');
  const remaining = list().filter(row => row.name === 'web-console');
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].pm2_env.pm_exec_path, script(other));
});
