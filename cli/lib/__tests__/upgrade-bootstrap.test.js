import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
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

function readyJournal(f, phase = 'restored_data_ready', extra = {}) {
  const digest = 'a'.repeat(64);
  return f.journal('tx', {
    phase,
    nodePath: process.execPath,
    skillsDir: path.join(f.root, '.claude/skills'),
    installationIntent: true,
    dbBackupDir: path.join(f.root, '.backup/db/tx'),
    snapshotManifestHash: digest,
    coreManifest: [{ name: 'core', existedBefore: true, backedUp: true, originalHash: digest }],
    originalServices: [],
    initialIdentity: {
      nodePath: process.execPath,
      packageJson: path.join(f.root, 'package.json'), packageHash: digest,
      cliRoot: path.join(f.root, 'original-cli'), cliHash: digest,
      workerPath: path.join(f.root, 'original-cli/lib/worker.js'), workerHash: digest,
      ecosystemHash: null,
      databases: ['comm-bridge/c4.db', 'scheduler/scheduler.db', 'web-console/web-console.db', 'components/dashboard/dashboard.db'].map(source => ({ source, exists: true })),
    },
    ...extra,
  });
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

test('ambiguous transactions remain visible but cannot authorize recovery', t => {
  const f = fixture(t); f.journal('one'); f.journal('two');
  const out = f.api.bootstrap(f.root, {once: true});
  assert.equal(out.recovery_required, true);
  assert.match(out.error, /not unique/);
  assert.match(out.prompt, /one/); assert.match(out.prompt, /two/);
});

test('status and discovery do not depend on runtime capability or recovery module', t => {
  const f = fixture(t); f.journal();
  fs.writeFileSync(path.join(f.stable, 'capability.json'), '{broken');
  const out = f.api.bootstrap(f.root, {status: true});
  assert.equal(out.active, true);
  assert.match(out.prompt, /Normal C4\/database access is unavailable/);
  assert.equal(f.api.supervise, undefined);
  assert.equal(f.api.runtimeCapability, undefined);
});

test('live controller is observed without entering resume', {skip:process.platform==='darwin'}, t => {
  const f = fixture(t), dir = f.journal();
  const m = createRequire(import.meta.url)(path.join(f.stable, 'maintenance.cjs'));
  t.mock.method(m, 'canRecognizeProcesses', () => true);
  t.mock.method(m, 'alive', () => true);
  m.durable(path.join(dir, 'controller.json'), m.identity());
  const out = f.api.bootstrap(f.root, {once: true});
  assert.equal(out.controllerAlive, true);
  assert.equal(out.observing, true);
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

for (const mode of ['crash', 'invalid', 'remaining', 'cleanup-warning']) test(`once preserves the parent and rejects ${mode} recovery`, {timeout:10000}, t => {
  const f = runnerFixture(t, mode);
  const out = f.api.bootstrap(f.root, {once:true});
  assert.equal(out.recovery_required, true);
  assert.equal(out.code, 'UPGRADE_RECOVERY_REQUIRED');
  assert.match(out.next, /zylos recovery/);
  assert.match(out.prompt, /UPGRADE_RECOVERY_REQUIRED/);
  assert.match(out.prompt, /zylos recovery/);
  assert.equal(fs.existsSync(path.join(f.stable, 'active.json')), true);
  const receipt = JSON.parse(fs.readFileSync(f.receipt, 'utf8'));
  assert.notEqual(receipt.pid, process.pid);
  assert.equal(receipt.ppid, process.pid);
  if (mode === 'cleanup-warning') {
    assert.match(out.error, /EACCES: fixture code removal denied/);
    assert.match(out.prompt, /EACCES: fixture code removal denied/);
  }
});

// The frozen-module stub intentionally has no recoverBeforeUpgrade export.
// The stable sibling module must own execution, regardless of frozen exports.
test('once uses its stable helper when frozen transaction maintenance predates that helper', {timeout:10000}, t => {
  const f = runnerFixture(t, 'remaining', {legacy:true});
  const legacyFile = path.join(f.dir, 'maintenance.cjs');
  const legacy = createRequire(import.meta.url)(legacyFile);
  assert.equal(legacy.recoverBeforeUpgrade, undefined);
  assert.equal(typeof f.m.recoverBeforeUpgrade, 'function');
  const before = fs.readFileSync(path.join(f.dir, 'journal.json'), 'utf8');
  const out = f.api.bootstrap(f.root, {once:true});
  assert.equal(out.recovery_required, true);
  assert.equal(out.code, 'UPGRADE_RECOVERY_REQUIRED');
  assert.notEqual(JSON.parse(fs.readFileSync(f.receipt, 'utf8')).pid, process.pid);
  assert.equal(fs.readFileSync(path.join(f.dir, 'journal.json'), 'utf8'), before);
  for (const [name, hash] of Object.entries(f.hashes)) assert.equal(f.m.hash(path.join(f.dir, name)), hash, name);
});

// A timed-out CLI must not leave its recovery child behind. The private
// process group belongs only to this fixture and is reaped on every result.
function runOnceCli(f) {
  const child = spawnSync(process.execPath, [path.join(f.stable,'bootstrap.cjs'),'--root',f.root,'--once'], {
    encoding:'utf8', timeout:5000, killSignal:'SIGKILL', detached:true,
    env:{...process.env,HOME:f.root,ZYLOS_DIR:f.root,PM2_HOME:path.join(f.root,'pm2-home')},
  });
  if (child.pid) {
    try { process.kill(-child.pid,'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  return child;
}

// Linux exercises the non-injected CLI capability branch. On Mac the separate
// manual-recovery case below proves that automatic takeover remains forbidden.
for (const mode of ['crash', 'remaining', 'cleanup-warning']) test(`once CLI exits nonzero for ${mode} and retains the marker`, {skip:process.platform!=='linux', timeout:10000}, t => {
  const f = runnerFixture(t, mode);
  const child = runOnceCli(f);
  assert.equal(child.error, undefined);
  assert.equal(child.status, 1, child.stderr);
  const out = JSON.parse(child.stdout);
  assert.equal(out.code, 'UPGRADE_RECOVERY_REQUIRED');
  assert.equal(out.recovery_required, true);
  assert.match(out.next, /zylos recovery/);
  assert.match(out.prompt, /UPGRADE_RECOVERY_REQUIRED/);
  assert.equal(fs.existsSync(path.join(f.stable, 'active.json')), true);
  if (mode === 'cleanup-warning') assert.match(out.error, /EACCES: fixture code removal denied/);
});

test('once rejects changed transaction recovery code before executing it', {skip:process.platform==='darwin'}, t => {
  const f = fixture(t), dir = f.journal();
  const m = createRequire(import.meta.url)(path.join(f.stable, 'maintenance.cjs'));
  t.mock.method(m, 'canRecognizeProcesses', () => true);
  for (const [src, dest] of [['../../skills/comm-bridge/scripts/remove-owned-tree.js','remove-owned-tree.mjs'],['upgrade-maintenance.cjs','maintenance.cjs'], ['upgrade-installer.cjs','installer.cjs']]) fs.copyFileSync(new URL('../' + src, import.meta.url), path.join(dir, dest));
  fs.writeFileSync(path.join(dir, 'runner.cjs'), 'exports.resume = () => ({resumed:true});');
  const journal = m.read(path.join(dir, 'journal.json'));
  m.update(dir, journal, {recoveryHashes:Object.fromEntries(['runner.cjs','maintenance.cjs','installer.cjs','remove-owned-tree.mjs'].map(name => [name,m.hash(path.join(dir,name))]))});
  fs.appendFileSync(path.join(dir, 'runner.cjs'), '\nthrow Error("changed runner executed");');
  const out = f.api.bootstrap(f.root, {once:true});
  assert.equal(out.recovery_required, true);
  assert.equal(out.code, 'UPGRADE_RECOVERY_REQUIRED');
  assert.match(out.error, /transaction recovery material changed/);
  assert.match(out.next, /zylos recovery/);
});

test('restricted process visibility refuses automatic bootstrap recovery on Linux', {skip:process.platform!=='linux'}, t => {
  const f = fixture(t), dir = f.journal();
  const m = createRequire(import.meta.url)(path.join(f.stable, 'maintenance.cjs'));
  t.mock.method(m, 'canRecognizeProcesses', () => false);
  const executed = path.join(dir, 'runner-executed');
  fs.writeFileSync(path.join(dir, 'runner.cjs'), `exports.resume = () => { require('node:fs').writeFileSync(${JSON.stringify(executed)}, 'executed'); return {resumed:true}; };`);
  for (const name of ['maintenance.cjs', 'installer.cjs']) fs.writeFileSync(path.join(dir, name), 'module.exports = {};');
  fs.copyFileSync(new URL('../../../skills/comm-bridge/scripts/remove-owned-tree.js',import.meta.url),path.join(dir,'remove-owned-tree.mjs'));
  const journal = m.read(path.join(dir, 'journal.json'));
  m.update(dir, journal, {recoveryHashes:Object.fromEntries(['runner.cjs','maintenance.cjs','installer.cjs','remove-owned-tree.mjs'].map(name => [name,m.hash(path.join(dir,name))]))});
  const out = f.api.bootstrap(f.root, {once:true});
  assert.equal(fs.existsSync(executed), false);
  assert.equal(out.automaticResume, false);
  assert.equal(out.recovery_required, true);
  assert.equal(out.blocked, true);
  assert.match(out.error, /manual recovery/);
  assert.doesNotMatch(out.prompt, /--once/);
});

test('stale or invalid controller material leaves an isolated recovery cue', t => {
  for (const controller of ['{broken', JSON.stringify({pid: process.pid, boot: 'prior-boot', start: '0'})]) {
    const f = fixture(t), dir = f.journal();
    fs.writeFileSync(path.join(dir, 'controller.json'), controller, {mode: 0o600});
    const out = f.api.bootstrap(f.root);
    assert.equal(out.active, true); assert.equal(out.blocked, true);
    assert.match(out.prompt, /SYSTEM RECOVERY TASK/);
  }
});

test('READY provides a nonblocking recovery cue and terminal evidence ends discovery', t => {
  for (const phase of ['restored_data_ready', 'restored_verifying', 'upgrade_complete']) {
    const f = fixture(t);
    readyJournal(f, phase, phase === 'upgrade_complete' ? {
      cleanupPending: true,
      cleanup: {complete: true, markerRemoved: true, servicesRestored: true},
      terminalEvidence: {verified: true, kind: 'code_data_services'},
    } : {});
    const out = f.api.bootstrap(f.root);
    assert.equal(out.active, phase !== 'upgrade_complete', phase);
    if (!out.active) continue;
    assert.equal(out.blocked, false);
    assert.match(out.prompt, /Core database access is available/);
  }
});

// Discovery itself can fail before a transaction is attributable. Preserve the
// real filesystem diagnosis and an action in every actual bootstrap cue.
test('unexpected discovery errors retain code cause and next action in every bootstrap mode', t => {
  const f = fixture(t);
  const m = createRequire(import.meta.url)(path.join(f.stable, 'maintenance.cjs'));
  t.mock.method(m, 'discover', () => {throw Object.assign(Error('EACCES: fixture recovery discovery denied'), {code:'EACCES'});});
  for (const options of [{}, {status:true}, {once:true}]) {
    const out = f.api.bootstrap(f.root, options);
    assert.equal(out.recovery_required, true);
    assert.equal(out.blocked, true);
    assert.equal(out.code, 'EACCES');
    assert.match(out.error, /EACCES: fixture recovery discovery denied/);
    assert.match(out.next, /zylos recovery status/);
    assert.match(out.prompt, /EACCES: fixture recovery discovery denied/);
    assert.match(out.prompt, /zylos recovery status/);
  }
});

// Closed transactions need forward repair even before an explicit resume is
// attempted. Status and ordinary startup cues must not suggest compensation.
test('closed transaction startup and status recommend forward finalization instead of recovery resume', t => {
  const f = fixture(t);
  const m = createRequire(import.meta.url)(path.join(f.stable, 'maintenance.cjs'));
  t.mock.method(m, 'canRecognizeProcesses', () => true);
  const digest = 'a'.repeat(64);
  readyJournal(f, 'compensation_closed', {
    compensationCutoff:{formatVersion:1, closed:true, transactionId:'tx', snapshotManifestHash:digest,
      closedAt:'2026-10-27T00:00:00.000Z', writer:'finalizer'},
  });
  for (const options of [{}, {status:true}]) {
    const out = f.api.bootstrap(f.root, options);
    assert.equal(out.active, true);
    assert.match(out.prompt, /"zylos",\s*"upgrade",\s*"--resume-finalize"/);
    assert.doesNotMatch(out.prompt, /"zylos",\s*"recovery",\s*"resume"/);
    assert.equal(fs.existsSync(path.join(f.stable, 'active.json')), true);
  }
});

test('retired runtime-launch option fails clearly and cannot run a supervisor', t => {
  const f = fixture(t);
  const out = spawnSync(process.execPath, [path.join(f.stable, 'bootstrap.cjs'), '--root', f.root, '--launch-runtime'], {encoding: 'utf8'});
  assert.equal(out.status, 1);
  const error = JSON.parse(out.stdout).error;
  assert.match(error, /existing boot chain/);
  assert.match(error, /--status/);
  assert.match(error, /zylos recovery resume/);
  assert.doesNotMatch(error, /--once/);
});

 test('Mac discovery only offers status/manual recovery and once cannot invoke runner', {skip:process.platform!=='darwin'}, t=>{
 const f=fixture(t);f.journal();
 fs.writeFileSync(path.join(f.stable,'recovery.cjs'),"throw Error('runner must not load')");
 const out=f.api.bootstrap(f.root,{once:true});
 assert.equal(out.recovery_required,true);assert.equal(out.automaticResume,false);
 assert.match(out.error,/manual recovery/);assert.doesNotMatch(out.prompt,/--once/);
 assert.match(out.prompt,/"controllerAlive": null/);
 assert.match(out.prompt,/do not run automatic resume/);
 });

// Boundary: Linux performs actual interrupted takeover, real terminal cleanup,
// and outer rediscovery. Only unlinkSync within code/ is fault-injected in the child;
// no service, database, or installed package is touched. Run when recovery
// cleanup or its caller changes. Mac refusal is covered separately above.
test('once CLI reports a real runner cleanup failure with its cause and retained marker', {skip:process.platform!=='linux', timeout:10000}, t => {
  const f = runnerFixture(t, 'remaining');
  fs.copyFileSync(new URL('../../../test/fixtures/recovery-cleanup-runner.cjs', import.meta.url), path.join(f.dir, 'runner.cjs'));
  fs.copyFileSync(new URL('../upgrade-recovery.cjs', import.meta.url), path.join(f.dir, 'product-runner.cjs'));
  for (const name of ['runner.cjs', 'product-runner.cjs']) fs.chmodSync(path.join(f.dir, name), 0o600);
  fs.mkdirSync(path.join(f.dir, 'code'), {mode:0o700});
  fs.writeFileSync(path.join(f.dir, 'code', 'retained.txt'), 'retained test code\n', {mode:0o600});
  const hashes = Object.fromEntries(['runner.cjs','maintenance.cjs','installer.cjs','remove-owned-tree.mjs'].map(name => [name, f.m.hash(path.join(f.dir, name))]));
  readyJournal(f, 'upgrade_complete', {
    recoveryHashes:hashes,
    cleanup:{complete:false, codeRemoved:false, servicesRestored:true},
    terminalEvidence:{verified:true, kind:'code_data_services'},
  });
  const child = runOnceCli(f);
  assert.equal(child.error, undefined);
  assert.equal(child.status, 1, child.stderr);
  const out = JSON.parse(child.stdout);
  assert.equal(out.code, 'UPGRADE_RECOVERY_REQUIRED');
  assert.equal(out.recovery_required, true);
  assert.match(out.error, /EACCES: fixture code removal denied/);
  assert.match(out.prompt, /EACCES: fixture code removal denied/);
  assert.match(out.next, /zylos recovery/);
  assert.equal(fs.existsSync(path.join(f.stable, 'active.json')), true);
  assert.equal(fs.readFileSync(path.join(f.dir, 'code', 'retained.txt'), 'utf8'), 'retained test code\n');
  const saved = f.m.read(path.join(f.dir, 'journal.json'));
  assert.equal(saved.phase, 'upgrade_complete');
  assert.equal(saved.cleanup.complete, false);
  for (const [name, hash] of Object.entries(hashes)) {
    assert.equal(saved.recoveryHashes[name], hash, name);
    assert.equal(f.m.hash(path.join(f.dir, name)), hash, name);
  }
});
