import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const repo = path.resolve(import.meta.dirname, '..');
const driver = path.join(import.meta.dirname, 'helpers/init-onboarding.js');
const template = fs.readFileSync(path.join(repo, 'templates/onboarding.md'), 'utf8');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onboard-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, HOME: path.join(root, 'home'), ZYLOS_DIR: path.join(root, 'home/zylos'),
    PM2_HOME: path.join(root, 'pm2'), TMPDIR: path.join(root, 'tmp'), TMUX_TMPDIR: path.join(root, 'tmp'), ZYLOS_PACKAGE_ROOT: repo };
  for (const k of ['ZYLOS_RUN_ID','ZYLOS_SESSION_GROUP','TMUX','CLAUDE_SESSION_ID','CODEX_SESSION_ID','CODEX_HOME']) delete env[k];
  for (const k of ['HOME','ZYLOS_DIR','PM2_HOME','TMPDIR','TMUX_TMPDIR']) {
    fs.mkdirSync(env[k], { recursive: true });
    assert.ok(fs.realpathSync(env[k]).startsWith(fs.realpathSync(root) + path.sep), k);
  }
  t.diagnostic('isolation ' + JSON.stringify({ ...Object.fromEntries(['HOME','ZYLOS_DIR','PM2_HOME','TMPDIR'].map(k => [k,env[k]])),
    database: path.join(env.ZYLOS_DIR,'comm-bridge/c4.db'), tmux: 'none', services: 'none' }));
  const child = (action, group) => {
    const result = spawnSync(process.execPath, [driver, action], { env: { ...env, ...(group ? { ZYLOS_SESSION_GROUP: group } : {}) },
      cwd: repo, encoding: 'utf8', timeout: 20000, maxBuffer: 131072 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
  };
  const inspect = group => JSON.parse(child('inspect', group).trim().split('\n').at(-1));
  const write = (name, bytes) => {
    const file = path.join(env.ZYLOS_DIR, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file,bytes); return file;
  };
  return { env, child, inspect, write, marker: path.join(env.ZYLOS_DIR,'.zylos/onboarding-pending') };
}

// Boundary: actual template deployment + both marker readers + shard CLI output.
// Run for init/onboarding/template/shard membership changes; unrelated changes
// may skip. Official runner and each case isolate all paths before children;
// no tmux/PM2/network/model launches. Children are bounded and joined before cleanup.
test('fresh init seeds Origin and pending marker; every group receives the fifth shard', t => {
  const f = fixture(t); f.child('fresh');
  assert.ok(fs.existsSync(f.marker));
  const state = fs.readFileSync(path.join(f.env.ZYLOS_DIR,'memory/session-groups/origin/state.md'),'utf8');
  assert.match(state,/scope=origin/); assert.doesNotMatch(state,/onboarding|Status: pending/i);
  assert.equal(fs.existsSync(path.join(f.env.ZYLOS_DIR,'memory/state.md')),false);
  assert.equal(fs.existsSync(path.join(f.env.ZYLOS_DIR,'.zylos/instructions/onboarding.md')),false);
  for (const group of [undefined,'origin','telegram:other']) {
    const result = f.inspect(group);
    assert.equal(result.pending,true); assert.equal(result.body,template); assert.equal(result.position,5);
    assert.equal(result.scopeRead,false); assert.equal(result.prompt.reason,'onboarding_pending');
    assert.deepEqual(result.names,['identity','custom','references','c4-conversations','onboarding']);
    assert.equal(f.child('shard',group),`=== ZYLOS STARTUP CONTEXT [5/5] onboarding ===\n${template.trimEnd()}\n`);
  }
});

// Boundary: deployed Origin preservation and completed-instance rerun. Run for
// template-deployment changes; unrelated changes may skip. Files only, private paths.
test('rerun preserves Origin progress and never recreates completed onboarding', t => {
  const f=fixture(t); f.child('fresh');
  const state=f.write('memory/session-groups/origin/state.md','owner progress\n');
  fs.unlinkSync(f.marker); f.child('rerun');
  assert.equal(fs.existsSync(f.marker),false); assert.equal(fs.readFileSync(state,'utf8'),'owner progress\n');
  fs.unlinkSync(state); f.child('rerun');
  assert.equal(fs.existsSync(state),false); assert.equal(fs.existsSync(f.marker),false);
});
