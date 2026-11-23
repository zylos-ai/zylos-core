import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beginUpgrade, maintenance as m, protectedSuccess, saveProtectedCode } from '../upgrade-protection.js';
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
  ctx = { coreDir, tempDir, from: 'old', to: 'new', firstTakeover:true, dashboardOwnerManaged:false };
  return { root, skillsDir, ctx };
}

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
      for (const name of ['runner.cjs', 'maintenance.cjs', 'installer.cjs','remove-owned-tree.mjs']) {
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

test('protected success finishes through the staging-loaded controller and clears its active marker', t => {
  const f=fixture(t);
  beginUpgrade(f.ctx,{zylosDir:f.root,skillsDir:f.skillsDir});
  saveProtectedCode(f.ctx);attachSnapshot(f);
  f.ctx.maintenance.update(f.ctx.transactionDir,f.ctx.journal,{phase:'installing',installationIntent:true});
  f.ctx.maintenance.marker(f.root,f.ctx.transactionDir,f.ctx.journal);
  const code=path.join(f.ctx.transactionDir,'code');assert.equal(fs.existsSync(code),true);
  const result=protectedSuccess(f.ctx);
  assert.deepEqual(result,{complete:true,warnings:[]});
  assert.equal(fs.existsSync(code),false);
  assert.equal(fs.existsSync(path.join(f.root,'.zylos/upgrade/active.json')),false);
  assert.equal(f.ctx.maintenance.read(path.join(f.ctx.transactionDir,'journal.json')).cleanup.complete,true);
  assert.equal(f.ctx.maintenance.discover(f.root).candidates.length,0);
});
