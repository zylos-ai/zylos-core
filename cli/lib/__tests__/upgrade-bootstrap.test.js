import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
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
    if(extra.phase!=='upgrade_complete') fs.writeFileSync(path.join(stable,'active.json'),JSON.stringify({formatVersion:1,transactionId:id,transactionDir:dir}),{mode:0o600});
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

function installFrozenRunner(dir, source) {
  const files = {
    'runner.cjs': source,
    'maintenance.cjs': "'use strict';\n",
    'installer.cjs': "'use strict';\n",
  };
  const hashes = {};
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content, {mode:0o600});
    hashes[name] = crypto.createHash('sha256').update(content).digest('hex');
  }
  const journalFile = path.join(dir, 'journal.json');
  const journal = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
  fs.writeFileSync(journalFile, JSON.stringify({...journal, nodePath:process.execPath, recoveryHashes:hashes}), {mode:0o600});
  return hashes;
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
  const executed = path.join(f.root, 'executed');
  installFrozenRunner(dir, `require('node:fs').writeFileSync(${JSON.stringify(executed)}, 'yes');`);
  const m = createRequire(import.meta.url)(path.join(f.stable, 'maintenance.cjs'));
  m.durable(path.join(dir, 'controller.json'), m.identity());
  const out = f.api.bootstrap(f.root, {once: true});
  assert.equal(out.controllerAlive, true);
  assert.equal(out.observing, true);
  assert.equal(fs.existsSync(executed), false);
});

test('once resumes exactly the attributed transaction and does not launch a runtime', {skip:process.platform==='darwin'}, t => {
  const f = fixture(t), dir = f.journal();
  const record = path.join(f.root, 'runner-args.json');
  installFrozenRunner(dir, `
    const fs=require('node:fs'),path=require('node:path');
    fs.writeFileSync(${JSON.stringify(record)},JSON.stringify(process.argv.slice(2)));
    const dir=process.argv[process.argv.length-1],root=path.resolve(dir,'../../..');
    fs.rmSync(path.join(root,'.zylos/upgrade/active.json'));
    fs.rmSync(dir,{recursive:true});
    process.stdout.write(JSON.stringify({success:true})+'\\n');
  `);
  const out = f.api.bootstrap(f.root, {once: true});
  assert.equal(out.active, false);
  assert.equal(out.resumed, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(record, 'utf8')), ['resume','--transaction-dir',dir]);
});

test('a failing frozen runner keeps recovery required and reports its exit status', {skip:process.platform==='darwin'}, t => {
  const f = fixture(t), dir = f.journal();
  installFrozenRunner(dir, 'process.exit(9);');
  const out = f.api.bootstrap(f.root, {once:true});
  assert.equal(out.active, true);
  assert.equal(out.recovery_required, true);
  assert.equal(out.code, 'UPGRADE_RECOVERY_REQUIRED');
  assert.match(out.error, /exited 9/);
});

test('a successful frozen runner must leave no transaction or active marker', {skip:process.platform==='darwin'}, t => {
  const f = fixture(t), dir = f.journal();
  installFrozenRunner(dir, `
    const fs=require('node:fs'),path=require('node:path');
    const dir=process.argv[process.argv.length-1],root=path.resolve(dir,'../../..');
    fs.rmSync(path.join(root,'.zylos/upgrade/active.json'));
  `);
  const out = f.api.bootstrap(f.root, {once:true});
  assert.equal(out.active, true);
  assert.equal(out.recovery_required, true);
  assert.equal(out.code, 'UPGRADE_RECOVERY_REQUIRED');
  assert.match(out.error, /clean terminal state/);
  assert.equal(fs.existsSync(dir), true);
});

test('changed frozen recovery material is rejected before runner execution', {skip:process.platform==='darwin'}, t => {
  const f = fixture(t), dir = f.journal();
  const executed = path.join(f.root, 'executed');
  installFrozenRunner(dir, `require('node:fs').writeFileSync(${JSON.stringify(executed)}, 'yes');`);
  fs.appendFileSync(path.join(dir, 'runner.cjs'), '\n// changed\n');
  const out = f.api.bootstrap(f.root, {once:true});
  assert.equal(out.recovery_required, true);
  assert.equal(out.code, 'UPGRADE_RECOVERY_REQUIRED');
  assert.match(out.error, /hash mismatch/);
  assert.equal(fs.existsSync(executed), false);
});

test('an existing descriptor must name the fixed layout and the same recovery hashes', {skip:process.platform==='darwin'}, t => {
  const f = fixture(t), dir = f.journal();
  const hashes = installFrozenRunner(dir, '');
  fs.writeFileSync(path.join(dir, 'descriptor.json'), JSON.stringify({
    formatVersion:1, transactionId:'tx', nodePath:process.execPath,
    runnerPath:path.join(dir, 'elsewhere.cjs'),
    driverClosureRoot:path.join(dir, 'sqlite-runtime'),
    workerPath:path.join(dir, 'sqlite-runtime/core-db-backup-worker.js'),
    driverPath:path.join(dir, 'sqlite-runtime/node_modules/better-sqlite3/lib/index.js'),
    hashes,
  }), {mode:0o600});
  const out = f.api.bootstrap(f.root, {once:true});
  assert.equal(out.recovery_required, true);
  assert.match(out.error, /fixed layout/);
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
