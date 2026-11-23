import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import {test} from 'node:test';
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'core803-bootstrap-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const stable = path.join(root, '.zylos/upgrade');
  fs.mkdirSync(stable, {recursive: true, mode: 0o700});
  for (const [source, target] of [['upgrade-bootstrap.cjs', 'bootstrap.cjs'], ['../../skills/comm-bridge/scripts/remove-owned-tree.js','remove-owned-tree.mjs'],['upgrade-maintenance.cjs','maintenance.cjs']]) {
    fs.copyFileSync(new URL('../' + source, import.meta.url), path.join(stable, target));
    fs.chmodSync(path.join(stable, target), 0o600);
  }
  const api = createRequire(import.meta.url)(path.join(stable, 'bootstrap.cjs'));
  function journal(id = 'tx', extra = {}) {
    const dir = path.join(root, '.backup/self-upgrade', id);
    fs.mkdirSync(dir, {recursive: true, mode: 0o700});
    fs.writeFileSync(path.join(dir, 'journal.json'), JSON.stringify({formatVersion: 1, transactionId: id, zylosDir: root, phase: 'prepared', initialIdentity: {}, ...extra}), {mode: 0o600});
    if(extra.phase!=='upgrade_complete') fs.writeFileSync(path.join(stable,'active.json'),JSON.stringify({formatVersion:1,transactionId:id,transactionDir:dir}),{mode:0o600});
    return dir;
  }
  return {root, stable, api, journal};
}



test('malformed journals expose a fixed diagnostic cue and never resume', t => {
  const f = fixture(t), dir = f.journal();
  fs.writeFileSync(path.join(dir, 'journal.json'), '{broken');
  const out = f.api.bootstrap(f.root);
  assert.equal(out.recovery_required, true);
  assert.equal(out.blocked, true);
  assert.match(out.prompt, /SYSTEM RECOVERY TASK/);
  assert.match(out.prompt, /--status/);
  assert.match(out.prompt, /Do not query C4/);
  for (const options of [{}, {status:true}, {once:true}]) {
    const failed=f.api.bootstrap(f.root,options);
    assert.equal(failed.recovery_required,true);
    assert.equal(failed.code,'UPGRADE_RECOVERY_REQUIRED');
    for(const key of ['code','error','next']) assert.ok(failed.prompt.includes(JSON.stringify(failed[key]).slice(1,-1)));
  }
});

// Boundary: exercise the real stable bootstrap and its shared subprocess helper.
// Run for bootstrap/shared-executor changes; no Core services or database is used.
function runnerFixture(t, mode, {legacy = false} = {}) {
  const f = fixture(t), dir = f.journal();
  const m = createRequire(import.meta.url)(path.join(f.stable, 'maintenance.cjs'));
  t.mock.method(m, 'canRecognizeProcesses', () => true);
  fs.copyFileSync(new URL('../../../test/fixtures/recovery-bootstrap-runner.cjs', import.meta.url), path.join(dir, 'runner.cjs'));
  for (const [src, dest] of [['../../skills/comm-bridge/scripts/remove-owned-tree.js','remove-owned-tree.mjs'],['upgrade-maintenance.cjs','maintenance.cjs'], ['upgrade-installer.cjs','installer.cjs']]) {
    fs.copyFileSync(new URL('../' + src, import.meta.url), path.join(dir, dest));
    fs.chmodSync(path.join(dir, dest), 0o600);
  }
  if (legacy) fs.copyFileSync(new URL('../../../test/fixtures/upgrade-maintenance-legacy.cjs', import.meta.url), path.join(dir, 'maintenance.cjs'));
  fs.chmodSync(path.join(dir, 'runner.cjs'), 0o600);
  fs.writeFileSync(path.join(dir, 'fixture.json'), JSON.stringify({mode}), {mode:0o600});
  const journal = m.read(path.join(dir, 'journal.json'));
  m.update(dir, journal, {recoveryHashes:Object.fromEntries(['runner.cjs','maintenance.cjs','installer.cjs','remove-owned-tree.mjs'].map(name => [name,m.hash(path.join(dir,name))]))});
  return {...f, dir, m, hashes:{...journal.recoveryHashes}, receipt:path.join(f.root, 'fixture-child.json')};
}

test('once runs the attributed child and verifies clean completion including a preinstall abort', {timeout:10000}, t => {
  const f = runnerFixture(t, 'clean');
  fs.writeFileSync(path.join(f.stable, 'recovery.cjs'), 'throw Error("stable recovery must not execute");');
  const out = f.api.bootstrap(f.root, {once:true});
  assert.equal(out.active, false);
  assert.equal(out.resumed, true);
  assert.equal(out.completed, false);
  assert.equal(out.launched, undefined);
  const receipt = JSON.parse(fs.readFileSync(f.receipt, 'utf8'));
  assert.notEqual(receipt.pid, process.pid);
  assert.equal(receipt.ppid, process.pid);
  assert.equal(fs.existsSync(path.join(f.stable, 'active.json')), false);
});
