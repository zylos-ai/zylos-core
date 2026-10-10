import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {applyUpgradePrompt,shellArgument,upgradeStartupPrompt} from '../runtime/upgrade-context.js';
test('Codex recovery replaces the sole positional startup prompt and shell quoting preserves hostile text',()=>{
 const prompt="recovery $(false) `false` 'quotes'\nnext line";
 const args=applyUpgradePrompt(['--no-daemon','old startup prompt'],prompt,1);
 assert.deepEqual(args,['--no-daemon',prompt]);
 const result=spawnSync('/bin/sh',['-c','printf %s '+shellArgument(prompt)],{encoding:'utf8'});
 assert.equal(result.status,0);assert.equal(result.stdout,prompt);
 assert.throws(()=>applyUpgradePrompt(['--no-daemon'],prompt,1),/prompt index/);
});
test('partial skill deployment does not import diagnostics, formatting, registry, or C4 before file recovery',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'upgrade-startup-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const stable=path.join(root,'.zylos/upgrade'),hook=path.join(root,'hook/c4-session-init.js');fs.mkdirSync(stable,{recursive:true,mode:0o700});fs.mkdirSync(path.dirname(hook));
 fs.writeFileSync(path.join(root,'package.json'),'{"type":"module"}');
 fs.copyFileSync(path.resolve('skills/comm-bridge/scripts/c4-session-init.js'),hook);
 for(const [source,target] of [['upgrade-bootstrap.cjs','bootstrap.cjs'],['upgrade-maintenance.cjs','maintenance.cjs']]){fs.copyFileSync(path.resolve('cli/lib',source),path.join(stable,target));fs.chmodSync(path.join(stable,target),0o600);}
 const dir=path.join(root,'.backup/self-upgrade/tx');fs.mkdirSync(dir,{recursive:true,mode:0o700});fs.writeFileSync(path.join(dir,'journal.json'),'{broken',{mode:0o600});
 // An explicit directory alias exercises this entry-point boundary on Linux too.
 const alias=path.join(root,'hook-alias');fs.symlinkSync(path.dirname(hook),alias,'dir');
 for(const entry of [hook,path.join(alias,'c4-session-init.js')]) {
  const result=spawnSync(process.execPath,[entry],{encoding:'utf8',env:{HOME:root,ZYLOS_DIR:root,PATH:process.env.PATH}});
  assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/UPGRADE RECOVERY TASK/);assert.match(result.stdout,/SYSTEM RECOVERY TASK/);assert.match(result.stdout,/diagnostics/);
 }
});

test('lost stable directories with transaction materials cue recovery before normal runtime or C4 imports', t => {
 for (const missing of ['.zylos', '.zylos/upgrade']) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'upgrade-lost-stable-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'.backup/self-upgrade/tx'),{recursive:true,mode:0o700});
  if (missing === '.zylos/upgrade') fs.mkdirSync(path.join(root,'.zylos'),{mode:0o700});
  assert.match(upgradeStartupPrompt(root), /Upgrade discovery failed/, missing);
  const hook=path.join(root,'hook/c4-session-init.js');fs.mkdirSync(path.dirname(hook));
  fs.writeFileSync(path.join(root,'package.json'),'{"type":"module"}');
  fs.copyFileSync(path.resolve('skills/comm-bridge/scripts/c4-session-init.js'),hook);
  const result=spawnSync(process.execPath,[hook],{encoding:'utf8',env:{ZYLOS_DIR:root,PATH:process.env.PATH}});
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/UPGRADE RECOVERY TASK/);
  assert.match(result.stdout,/Upgrade discovery failed/);
  assert.match(result.stdout,/Do not query C4/);
 }
});

 test('nonblocking recovery cue remains available alongside normal context', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-available-startup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stable = path.join(root, '.zylos/upgrade');
  fs.mkdirSync(stable, { recursive: true });
  fs.chmodSync(stable, 0o700);
  fs.writeFileSync(path.join(stable, 'active.json'), '{}', {mode: 0o600});
  for (const file of ['maintenance.cjs']) fs.writeFileSync(path.join(stable, file), '// fixture dependency\n', {mode: 0o600});
  fs.writeFileSync(path.join(stable, 'bootstrap.cjs'), "exports.bootstrap = () => ({ active: true, blocked: false, prompt: 'cleanup task' });\n");
  fs.chmodSync(path.join(stable, 'bootstrap.cjs'), 0o600);
  assert.equal(upgradeStartupPrompt(root), 'cleanup task');
});

test('tmux launcher preserves ordinary prompt for available databases and replaces it during isolation', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-launcher-context-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stable = path.join(root, '.zylos/upgrade');
  fs.mkdirSync(stable, { recursive: true });
  fs.chmodSync(stable, 0o700);
  fs.writeFileSync(path.join(stable, 'active.json'), '{}', {mode: 0o600});
  for (const file of ['maintenance.cjs']) fs.writeFileSync(path.join(stable, file), '// fixture dependency\n', {mode: 0o600});
  for (const blocked of [false, true]) {
    fs.writeFileSync(path.join(stable, 'bootstrap.cjs'), `exports.bootstrap = () => ({ active: true, blocked: ${blocked}, prompt: 'recovery prompt' });\n`);
    fs.chmodSync(path.join(stable, 'bootstrap.cjs'), 0o600);
    const specPath = path.join(root, 'spec.json');
    fs.writeFileSync(specPath, JSON.stringify({
      command: process.execPath,
      args: ['-e', 'console.log(process.argv[1])', 'ordinary prompt'],
      promptIndex: 2,
      cwd: root,
      env: { PATH: process.env.PATH },
    }));
    const result = spawnSync(process.execPath, [path.resolve('cli/lib/runtime/tmux-launcher.js'), specPath], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), blocked ? 'recovery prompt' : 'ordinary prompt\n\nrecovery prompt');
  }
});

test('C4 checkpoint hook reads normal context after READY but isolates blocked recovery', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-c4-context-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stable = path.join(root, '.zylos/upgrade');
  const scripts = path.join(root, 'skills/comm-bridge/scripts');
  const registry = path.join(root, 'skills/activity-monitor/scripts');
  for (const dir of [stable, scripts, registry]) fs.mkdirSync(dir, { recursive: true });
  fs.chmodSync(stable, 0o700);
  fs.writeFileSync(path.join(stable, 'active.json'), '{}', {mode: 0o600});
  for (const file of ['maintenance.cjs']) fs.writeFileSync(path.join(stable, file), '// fixture dependency\n', {mode: 0o600});
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  fs.copyFileSync(path.resolve('skills/comm-bridge/scripts/c4-session-init.js'), path.join(scripts, 'c4-session-init.js'));
  fs.writeFileSync(path.join(scripts, 'c4-diagnostic.js'), 'export function logHookTiming() {}\n');
  fs.writeFileSync(path.join(scripts, 'session-format.js'), 'export const formatSection = (label, text) => label + ": " + text;\n');
  fs.writeFileSync(path.join(registry, 'shard-registry.js'), 'export const withinBudget = () => true;\n');
  fs.writeFileSync(path.join(scripts, 'c4-db.js'), 'export const getLastCheckpoint = () => ({summary: "ordinary checkpoint"}); export function close() {}\n');
  for (const blocked of [false, true]) {
    fs.writeFileSync(path.join(stable, 'bootstrap.cjs'), `exports.bootstrap = () => ({active: true, blocked: ${blocked}, prompt: 'isolated recovery'});\n`);
    fs.chmodSync(path.join(stable, 'bootstrap.cjs'), 0o600);
    const runner = path.join(root, 'runner.js');
    fs.writeFileSync(runner, 'import {emitC4Checkpoint} from "./skills/comm-bridge/scripts/c4-session-init.js"; console.log(await emitC4Checkpoint());\n');
    const result = spawnSync(process.execPath, [runner], {encoding: 'utf8', env: {ZYLOS_DIR: root, PATH: process.env.PATH}});
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, blocked ? /UPGRADE RECOVERY TASK/ : /ordinary checkpoint/);
    if (blocked) assert.doesNotMatch(result.stdout, /ordinary checkpoint/);
    else assert.match(result.stdout, /UPGRADE RECOVERY TASK/);
  }
});

function stableFixture(t, body) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-trusted-context-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const stable = path.join(root, '.zylos/upgrade');
  fs.mkdirSync(stable, {recursive: true, mode: 0o700});
  fs.writeFileSync(path.join(stable, 'active.json'), '{}', {mode: 0o600});
  for (const file of ['maintenance.cjs']) {
    fs.writeFileSync(path.join(stable, file), '// fixture dependency\n', {mode: 0o600});
  }
  const entry = path.join(stable, 'bootstrap.cjs');
  fs.writeFileSync(entry, body, {mode: 0o600});
  return {root, stable, entry};
}

test('untrusted stable module or directory never executes before fixed isolated fallback', t => {
  for (const attack of ['entry-writable', 'dependency-writable', 'entry-link', 'directory-link']) {
    const f = stableFixture(t, 'throw Error("must never execute");\n');
    const sentinel = path.join(f.root, 'executed');
    fs.writeFileSync(f.entry, `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'executed'); exports.bootstrap = () => ({active:false});\n`);
    if (attack === 'entry-writable') fs.chmodSync(f.entry, 0o666);
    if (attack === 'dependency-writable') fs.chmodSync(path.join(f.stable, 'maintenance.cjs'), 0o666);
    if (attack === 'entry-link') {
      const target = path.join(f.root, 'linked-bootstrap.cjs');
      fs.renameSync(f.entry, target);
      fs.symlinkSync(target, f.entry);
    }
    if (attack === 'directory-link') {
      const target = path.join(f.root, 'linked-upgrade');
      fs.renameSync(f.stable, target);
      fs.symlinkSync(target, f.stable);
    }
    assert.match(upgradeStartupPrompt(f.root), /Upgrade discovery failed/);
    assert.equal(fs.existsSync(sentinel), false, attack);
  }
});

test('throwing trusted discovery still launches runtime with isolated prompt instead of aborting', t => {
  const f = stableFixture(t, 'exports.bootstrap = () => {throw Error("discovery unavailable");};\n');
  const spec = path.join(f.root, 'spec.json');
  fs.writeFileSync(spec, JSON.stringify({
    command: process.execPath,
    args: ['-e', 'console.log(process.argv[1]); console.log(process.env.ZYLOS_UPGRADE_PROMPT_DELIVERED || "unset")', 'ordinary prompt'],
    promptIndex: 2,
    cwd: f.root,
    env: {PATH: process.env.PATH},
  }));
  const result = spawnSync(process.execPath, [path.resolve('cli/lib/runtime/tmux-launcher.js'), spec], {encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Upgrade discovery failed/);
  assert.match(result.stdout, /Do not query C4/);
  assert.match(result.stdout, /\nunset\n$/);
  assert.doesNotMatch(result.stdout, /ordinary prompt/);
});

test('each new session receives one recovery cue across C4 shards despite a stale runtime flag', t => {
  const f = stableFixture(t, 'exports.bootstrap = () => {throw Error("discovery unavailable");};\n');
  const scripts = path.join(f.root, 'hook');
  fs.mkdirSync(scripts);
  fs.writeFileSync(path.join(f.root, 'package.json'), '{"type":"module"}');
  fs.copyFileSync(path.resolve('skills/comm-bridge/scripts/c4-session-init.js'), path.join(scripts, 'c4-session-init.js'));
  const runner = path.join(f.root, 'runner.js');
  fs.writeFileSync(runner, 'import {emitC4Checkpoint,emitC4Conversations} from "./hook/c4-session-init.js"; console.log(await emitC4Checkpoint()); console.log(await emitC4Conversations());\n');
  for (const delivered of [false, true]) {
    const result = spawnSync(process.execPath, [runner], {encoding: 'utf8', env: {
      ZYLOS_DIR: f.root, PATH: process.env.PATH,
      ...(delivered ? {ZYLOS_UPGRADE_PROMPT_DELIVERED: '1'} : {}),
    }});
    assert.equal(result.status, 0, result.stderr);
    assert.equal((result.stdout.match(/SYSTEM RECOVERY TASK/g) || []).length, 1);
  }
});

test('nonblocking cue append preserves original prompt and avoids duplicate adapter cue', () => {
  const original = 'ordinary\n\nrecovery cue';
  assert.deepEqual(applyUpgradePrompt([original], 'recovery cue', 0, {append: true}), [original]);
});

 test('ordinary deployment skips incomplete or group-writable stable runtime discovery without upgrade materials', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-normal-context-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const stable = path.join(root, '.zylos/upgrade');
  fs.mkdirSync(stable, {recursive: true});
  fs.chmodSync(stable, 0o775);
  fs.writeFileSync(path.join(stable, 'bootstrap.cjs'), 'throw Error("ordinary startup must not load this");', {mode:0o664});
  assert.equal(upgradeStartupPrompt(root), null);
});
