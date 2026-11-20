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

// Boundary: documented completion command and subsequent real readers. This
// verifies command semantics, not an authenticated model following instructions.
// Run for completion instructions/marker readers; unrelated changes may skip.
test('documented completion removes only the marker and preserves the empty fifth shard', t => {
  const f = fixture(t); f.child('fresh');
  f.write('.claude/skills/onboarding-fixture/package.json','{"type":"module"}');
  f.write('.claude/skills/onboarding-fixture/scripts/send.js','process.exit(0);\n');
  const sent = spawnSync(process.execPath,[path.join(repo,'skills/comm-bridge/scripts/c4-send.js'),'onboarding-fixture','private'],
    {env:f.env,cwd:repo,input:'Security notice fixture',encoding:'utf8',timeout:15000,maxBuffer:65536});
  assert.equal(sent.error,undefined); assert.equal(sent.status,0,sent.stderr);
  assert.ok(fs.existsSync(f.marker),'thread deletes the marker only after the successful receipt');
  const command = template.match(/```sh\n([^`]+)\n```/)[1];
  assert.match(template,/successfully sent via C4/); assert.match(template,/Do not delete it before sending or when c4-send fails/);
  for (let repeat = 0; repeat < 2; repeat++) {
    const result = spawnSync('/bin/sh',['-c',command],{env:f.env,encoding:'utf8',timeout:5000});
    assert.equal(result.status,0,result.stderr);
  }
  assert.equal(fs.existsSync(f.marker),false);
  const result = f.inspect();
  assert.equal(result.pending,false); assert.equal(result.body,''); assert.equal(result.scopeRead,true);
  assert.notEqual(result.prompt.reason,'onboarding_pending');
  assert.equal(f.child('shard'),'=== ZYLOS STARTUP CONTEXT [5/5] onboarding ===\n');
});

// Boundary: actual old-instance deployment with stale pending states. Run for
// init upgrade/reader changes; unrelated changes may skip. No installers or services.
test('old instances ignore pending states and rerun never creates a marker', t => {
  const f = fixture(t);
  f.write('.zylos/config.json',JSON.stringify({session_mode:'single'}));
  const states = ['memory/state.md','memory/session-groups/origin/state.md'];
  for (const state of states) f.write(state,'- Status: pending\n');
  f.child('rerun');
  for (const group of [undefined,'origin','telegram:other']) {
    const result=f.inspect(group); assert.equal(result.pending,false); assert.equal(result.body,''); assert.equal(result.scopeRead,true);
    assert.notEqual(result.prompt.reason,'onboarding_pending');
  }
  assert.equal(fs.existsSync(f.marker),false);
  for (const state of states) {
    assert.equal(fs.readFileSync(path.join(f.env.ZYLOS_DIR,state),'utf8'),'- Status: pending\n');
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

// Boundary: generated Claude/Codex hook configuration and actual AGY shared
// startup path. Run for shard/hook membership changes; unrelated changes may
// skip. Authenticated CLI attachment is deliberately a separate reviewer gate.
test('Claude Codex and Antigravity hooks include the shared fifth onboarding block', t => {
  const f=fixture(t); f.child('fresh');
  const hooks=JSON.parse(f.child('hooks').trim().split('\n').at(-1));
  for (const runtime of ['claude','codex']) {
    const core = hooks[runtime].filter(g => g.hooks.some(h => h.command.includes('session-start-orchestrator.js')));
    assert.equal(core.length, runtime === 'claude' ? 3 : 1);
    for (const group of core) assert.equal(group.hooks.filter(h=>h.command.endsWith('--shard onboarding')).length,1);
  }
  assert.equal(hooks.agy.length,1); assert.match(hooks.agy[0].command,/agy-hooks.js.*SessionStart/);
  assert.ok(f.child('agy').includes(`=== ZYLOS STARTUP CONTEXT [5/5] onboarding ===\n${template}`));
  fs.unlinkSync(f.marker);
  assert.match(f.child('agy'),/=== ZYLOS STARTUP CONTEXT \[5\/5\] onboarding ===\n\n/);
});
