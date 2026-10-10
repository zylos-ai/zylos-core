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
  for (const [source, target] of [['upgrade-bootstrap.cjs', 'bootstrap.cjs'], ['upgrade-maintenance.cjs', 'maintenance.cjs']]) {
    fs.copyFileSync(new URL('../' + source, import.meta.url), path.join(stable, target));
    fs.chmodSync(path.join(stable, target), 0o600);
  }
  const api = createRequire(import.meta.url)(path.join(stable, 'bootstrap.cjs'));
  function journal(id = 'tx', extra = {}) {
    const dir = path.join(root, '.backup/self-upgrade', id);
    fs.mkdirSync(dir, {recursive: true, mode: 0o700});
    fs.writeFileSync(path.join(dir, 'journal.json'), JSON.stringify({formatVersion: 1, transactionId: id, zylosDir: root, phase: 'prepared', initialIdentity: {}, ...extra}), {mode: 0o600});
    return dir;
  }
  return {root, stable, api, journal};
}

function readyJournal(f, phase = 'new_data_ready', extra = {}) {
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
      databases: ['comm-bridge/c4.db', 'scheduler/scheduler.db', 'web-console/web-console.db'].map(source => ({ source, exists: true })),
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
  assert.equal(f.api.bootstrap(f.root, {once: true}).recovery_required, true);
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
  m.durable(path.join(dir, 'controller.json'), m.identity());
  const out = f.api.bootstrap(f.root, {once: true});
  assert.equal(out.controllerAlive, true);
  assert.equal(out.observing, true);
});

test('once resumes exactly the attributed transaction and does not launch a runtime', {skip:process.platform==='darwin'}, t => {
  const f = fixture(t), dir = f.journal();
  fs.writeFileSync(path.join(f.stable, 'recovery.cjs'), 'exports.resume = dir => ({resumed: dir});');
  const out = f.api.bootstrap(f.root, {once: true});
  assert.equal(out.resumed, dir);
  assert.equal(out.launched, undefined);
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
  for (const phase of ['new_data_ready', 'new_verifying', 'restored_data_ready', 'restored_verifying', 'upgrade_complete']) {
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

test('unexpected discovery exceptions preserve isolation without exposing exception text', t => {
  const f = fixture(t);
  const m = createRequire(import.meta.url)(path.join(f.stable, 'maintenance.cjs'));
  const discover = m.discover;
  m.discover = () => {throw Error('untrusted exception text');};
  try {
    const out = f.api.bootstrap(f.root, {once: true});
    assert.equal(out.recovery_required, true); assert.equal(out.blocked, true);
    assert.match(out.prompt, /file-only upgrade discovery unavailable/);
    assert.doesNotMatch(out.prompt, /untrusted exception text/);
  } finally {m.discover = discover;}
});

test('retired runtime-launch option fails clearly and cannot run a supervisor', t => {
  const f = fixture(t);
  const out = spawnSync(process.execPath, [path.join(f.stable, 'bootstrap.cjs'), '--root', f.root, '--launch-runtime'], {encoding: 'utf8'});
  assert.equal(out.status, 1);
  assert.match(JSON.parse(out.stdout).error, /existing boot chain/);
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
