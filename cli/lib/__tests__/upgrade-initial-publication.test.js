import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beginUpgrade, maintenance as m, maintenanceFor, protectedDataReady } from '../upgrade-protection.js';
import { createCoreDbSnapshot } from '../core-db-backup.js';

function attachSnapshot(f) {
  const result=createCoreDbSnapshot({zylosDir:f.root,transactionId:f.ctx.transactionId});
  f.ctx.dbBackupDir=result.dbBackupDir;f.ctx.dbManifest=result.manifest;
  m.update(f.ctx.transactionDir,f.ctx.journal,{dbBackupDir:result.dbBackupDir,snapshotManifestHash:m.hash(path.join(result.dbBackupDir,'manifest.json'))});
}

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-publication-')));
  let ctx;
  t.after(() => {
    try { ctx?.releaseControl?.(); }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  const coreDir = path.join(root, 'old-package');
  const tempDir = path.join(root, 'new-package');
  const skillsDir = path.join(root, '.claude', 'skills');
  for (const dir of [path.join(coreDir, 'skills', 'core'), path.join(tempDir, 'skills', 'core'), path.join(coreDir, 'cli', 'lib'), path.join(skillsDir, 'core')]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(coreDir, 'package.json'), '{"version":"old"}');
  fs.writeFileSync(path.join(coreDir, 'cli', 'lib', 'core-db-backup-worker.js'), '// fixture');
  for (const name of ['.zylos', '.backup']) {
    fs.mkdirSync(path.join(root, name), { recursive: true });
    fs.chmodSync(path.join(root, name), 0o775);
  }
  const services = m.services;
  m.services = () => [];
  t.after(() => { m.services = services; });
  ctx = { coreDir, tempDir, from: 'old', to: 'new' };
  return { root, skillsDir, ctx };
}

test('ordinary unconfigured adoption deploys bootstrap and atomically publishes a live controller', t => {
  const f = fixture(t);
  beginUpgrade(f.ctx, { zylosDir: f.root, skillsDir: f.skillsDir });
  assert.equal(fs.existsSync(path.join(f.root, '.zylos/upgrade/bootstrap.cjs')), true);
  assert.equal(f.ctx.bootCapability, undefined);
  const current = m.transaction(f.root, f.ctx.transactionDir);
  assert.equal(current.phase, 'preparing');
  assert.equal(current.installationIntent, false);
  if (!m.canRecognizeProcesses()) {
    assert.equal(f.ctx.releaseControl.withOwnership(f.ctx.transactionDir, () => 'owned'), 'owned');
    assert.throws(() => m.acquire(f.ctx.transactionDir), /admission retained/);
  } else assert.equal(m.alive(m.read(path.join(f.ctx.transactionDir, 'controller.json'))), true);
  assert.equal(fs.readdirSync(path.join(f.root, '.backup/self-upgrade-staging')).length, 0);
});

test('transaction recovery is durably saved before the first journal is published', t => {
  const f = fixture(t), synced = new Set(), sync = fs.fsyncSync, rename = fs.renameSync;
  let checked = false;
  fs.fsyncSync = fd => {
    if (process.platform === 'linux') synced.add(fs.readlinkSync('/proc/self/fd/' + fd));
    return sync(fd);
  };
  fs.renameSync = (source, destination) => {
    if (path.basename(destination) === 'journal.json' && !checked) {
      checked = true;
      for (const name of ['runner.cjs', 'maintenance.cjs', 'finalizer.cjs']) {
        const file = path.join(path.dirname(destination), name);
        assert.equal(fs.existsSync(file), true);
        if (process.platform === 'linux') assert.equal(synced.has(file), true, name + ' was not fsynced first');
      }
    }
    return rename(source, destination);
  };
  try { beginUpgrade(f.ctx, {zylosDir:f.root, skillsDir:f.skillsDir}); }
  finally { fs.fsyncSync = sync; fs.renameSync = rename; }
  assert.equal(checked, true);
  for (const [name, hash] of Object.entries(f.ctx.journal.recoveryHashes)) assert.equal(m.hash(path.join(f.ctx.transactionDir,name)), hash);
});

test('initial metadata error publishes no transaction and leaves ordinary databases available', t => {
  const f = fixture(t);
  fs.symlinkSync(path.join(f.root, 'foreign'), path.join(f.skillsDir, 'invalid'));
  fs.mkdirSync(path.join(f.ctx.tempDir, 'skills', 'invalid'));
  assert.throws(() => beginUpgrade(f.ctx, { zylosDir: f.root, skillsDir: f.skillsDir }), /individual real directory/);
  assert.equal(m.discover(f.root).blocked, false);
  assert.doesNotThrow(() => m.assertCoreDatabaseAvailable(f.root));
});

test('journal write failure stays outside discovery and cannot poison normal database access', t => {
  const f = fixture(t);
  const update = m.update;
  m.update = () => { throw Error('injected initial journal failure'); };
  try {
    assert.throws(() => beginUpgrade(f.ctx, { zylosDir: f.root, skillsDir: f.skillsDir }), /initial journal failure/);
  } finally { m.update = update; }
  assert.deepEqual(m.discover(f.root).diagnostics, []);
  assert.equal(m.discover(f.root).blocked, false);
  assert.equal(fs.readdirSync(path.join(f.root, '.backup/self-upgrade')).length, 0);
  assert.equal(fs.readdirSync(path.join(f.root, '.backup/self-upgrade-staging')).length, 0);
});

test('retired capability configuration does not gate protected publication', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, '.zylos/upgrade'), { mode: 0o700 });
  m.durable(path.join(f.root, '.zylos/upgrade/capability.json'), { formatVersion: 1 });
  beginUpgrade(f.ctx, { zylosDir: f.root, skillsDir: f.skillsDir });
  assert.equal(f.ctx.preInstallProtection, true);
});

test('symlink deployment root records canonical transaction identities', t => {
  const f = fixture(t), alias = f.root + '-alias';
  fs.symlinkSync(f.root, alias);
  t.after(() => fs.unlinkSync(alias));
  beginUpgrade(f.ctx, { zylosDir: alias, skillsDir: path.join(alias, '.claude/skills') });
  assert.equal(f.ctx.journal.zylosDir, f.root);
  assert.equal(f.ctx.journal.skillsDir, f.skillsDir);
  assert.equal(m.discover(alias).diagnostics.length, 0);
});

test('data-ready refreshes context while retaining installing isolation', t => {
  const f = fixture(t);
  beginUpgrade(f.ctx, { zylosDir: f.root, skillsDir: f.skillsDir });
  attachSnapshot(f);
  const active = maintenanceFor(f.ctx), preflight = active.preflight;
  active.preflight = () => ({ success: true });
  m.update(f.ctx.transactionDir,f.ctx.journal,{phase:'installing',installationIntent:true});
  m.marker(f.root,f.ctx.transactionDir,f.ctx.journal);
  try { protectedDataReady(f.ctx,{migrate:()=>({databases:[]}),verify:()=>({databases:[]})}); } finally { active.preflight = preflight; }
  assert.equal(f.ctx.journal.phase, 'installing');
  m.update(f.ctx.transactionDir, f.ctx.journal, { ecosystemCreationIntent: { test: true } });
  assert.equal(m.read(path.join(f.ctx.transactionDir, 'journal.json')).phase, 'installing');
  assert.throws(()=>m.assertCoreDatabaseAvailable(f.root),/maintenance/);
});

for (const from of ['0.9.3', '1.0.0']) for (const firstTakeover of [false,true]) test(`data-ready uses persisted takeover=${firstTakeover} from source ${from}`, t => {
  const f = fixture(t);
  f.ctx.from = from;
  f.ctx.firstTakeover = firstTakeover;
  f.ctx.dashboardOwnerManaged = !firstTakeover;
  beginUpgrade(f.ctx, {zylosDir:f.root, skillsDir:f.skillsDir});
  assert.equal(f.ctx.journal.firstTakeover,firstTakeover);
  assert.equal(f.ctx.journal.dashboardOwnerManaged,!firstTakeover);
  f.ctx.firstTakeover = !firstTakeover;
  f.ctx.dashboardOwnerManaged = firstTakeover;
  attachSnapshot(f);
  const active = maintenanceFor(f.ctx), preflight = active.preflight;
  active.preflight = () => ({success:true});
  m.update(f.ctx.transactionDir, f.ctx.journal, {phase:'installing', installationIntent:true});
  m.marker(f.root, f.ctx.transactionDir, f.ctx.journal);
  let checked = false;
  try {
    protectedDataReady(f.ctx, {migrate:()=>{}, verify: payload => {
      checked = true;
      assert.equal(payload.dashboardOwnerManaged, !firstTakeover);
      assert.equal(payload.requireCurrent, true);
      return {databases:[]};
    }});
  } finally { active.preflight = preflight; }
  assert.equal(checked, true);
});

test('controller acquisition failure removes only its unpublished staging attempt', t => {
  const f = fixture(t), stagingRoot = path.join(f.root, '.backup/self-upgrade-staging');
  fs.mkdirSync(stagingRoot, {recursive:true, mode:0o700});
  const unrelated = path.join(stagingRoot, 'prior-attempt');
  fs.mkdirSync(unrelated, {mode:0o700});fs.writeFileSync(path.join(unrelated, 'note'), 'keep');
  const admission = m.canRecognizeProcesses() ? '/controller.guard' : '/controller.json';
  const open = fs.openSync;
  fs.openSync = (file, ...args) => {
    if (String(file).endsWith(admission)) throw Error('injected controller failure');
    return open(file, ...args);
  };
  try {
    assert.throws(() => beginUpgrade(f.ctx, {zylosDir:f.root, skillsDir:f.skillsDir}), /injected controller failure/);
  } finally {fs.openSync = open;}
  assert.deepEqual(fs.readdirSync(stagingRoot), ['prior-attempt']);
  assert.equal(fs.readFileSync(path.join(unrelated, 'note'), 'utf8'), 'keep');
  assert.deepEqual(fs.readdirSync(path.join(f.root, '.backup/self-upgrade')), []);
  assert.equal(m.discover(f.root).blocked, false);
  beginUpgrade(f.ctx, {zylosDir:f.root, skillsDir:f.skillsDir});
  assert.equal(f.ctx.preInstallProtection, true);
});

test('migration failure retains installing isolation and never reaches READY', t => {
  const f=fixture(t);
  beginUpgrade(f.ctx,{zylosDir:f.root,skillsDir:f.skillsDir});
  attachSnapshot(f);
  m.update(f.ctx.transactionDir,f.ctx.journal,{phase:'installing',installationIntent:true});
  m.marker(f.root,f.ctx.transactionDir,f.ctx.journal);
  let verified=false;
  assert.throws(()=>protectedDataReady(f.ctx,{migrate:()=>{throw Error('injected owner migration failure');},verify:()=>{verified=true;}}),/owner migration failure/);
  assert.equal(verified,false);
  assert.equal(m.transaction(f.root,f.ctx.transactionDir).phase,'installing');
  assert.throws(()=>m.assertCoreDatabaseAvailable(f.root),/maintenance|upgrade|blocked/i);
});

test('changed active identity after migration prevents READY publication', t => {
  const f=fixture(t);
  beginUpgrade(f.ctx,{zylosDir:f.root,skillsDir:f.skillsDir});
  attachSnapshot(f);
  m.update(f.ctx.transactionDir,f.ctx.journal,{phase:'installing',installationIntent:true});
  m.marker(f.root,f.ctx.transactionDir,f.ctx.journal);
  const active=maintenanceFor(f.ctx),preflight=active.preflight;
  active.preflight=()=>({success:true});
  try {
    assert.throws(()=>protectedDataReady(f.ctx,{migrate:()=>{},verify:()=>{
      m.durable(path.join(f.root,'.zylos/upgrade/active.json'),{formatVersion:1,transactionId:'other',transactionDir:f.ctx.transactionDir});
    }}),/changed before data-ready/);
  } finally {active.preflight=preflight;}
  assert.equal(m.transaction(f.root,f.ctx.transactionDir).phase,'installing');
});
