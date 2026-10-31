import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-package-recovery-'));
  const dir = path.join(root, '.backup/self-upgrade/tx'); fs.mkdirSync(dir, {recursive:true});
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  for (const [source, name] of [['upgrade-maintenance.cjs','maintenance.cjs'],['upgrade-recovery.cjs','runner.cjs']]) fs.copyFileSync(path.resolve('cli/lib',source),path.join(dir,name));
  const m = require(path.join(dir,'maintenance.cjs')), recovery = require(path.join(dir,'runner.cjs'));
  const j = {formatVersion:1, phase:'restored_data_ready', databaseMode:'unchanged', transactionId:'tx', zylosDir:root, installationIntent:true,
    nodePath:process.execPath, skillsDir:path.join(root,'.claude/skills'), dbBackupDir:path.join(root,'.backup/db/tx'), snapshotManifestHash:'a'.repeat(64),
    initialIdentity:{nodePath:process.execPath, packageJson:path.join(root,'package.json'),packageHash:'b'.repeat(64),cliRoot:path.join(root,'cli'),cliHash:'c'.repeat(64),workerPath:path.join(root,'cli/worker.js'),workerHash:'d'.repeat(64),ecosystemHash:null,databases:m.databasePaths(2).map(source=>({source,exists:true}))},
    coreManifest:[{name:'core',existedBefore:true,backedUp:true,originalHash:'e'.repeat(64)}],originalServices:[]};
  const events = [];
  m.restoreOriginalPackage = () => events.push('restore-package');
  m.start = () => events.push('start'); m.verifyServices = () => events.push('verify');
  m.stop = () => events.push('stop'); m.finishTerminal = () => ({complete:true});
  m.update(dir,j);
  return {dir,j,m,recovery,events};
}

test('restored READY validates or reinstalls the original program before starting and verifying services', t => {
  const f = fixture(t);
  const result = f.recovery.validateReady(f.dir,f.j);
  assert.deepEqual(f.events,['restore-package','start','verify']);
  assert.equal(result.completed,true); assert.equal(result.recovery_required,false);
  assert.equal(f.m.read(path.join(f.dir,'journal.json')).phase,'restored_complete');
});

test('original program restoration failure retains recovery isolation and cannot start services', t => {
  const f = fixture(t);
  f.m.restoreOriginalPackage = () => { throw Error('injected original package restoration failure'); };
  const result = f.recovery.validateReady(f.dir,f.j);
  assert.equal(result.recovery_required,true); assert.equal(result.completed,false);
  assert.match(result.error,/original package restoration failure/);
  assert.ok(f.events.length > 0);
  assert.ok(f.events.every(event => event === 'stop'), 'failed restoration must only isolate services');
  assert.equal(f.m.read(path.join(f.dir,'journal.json')).phase,'recovery_required');
});
