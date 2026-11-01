import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import maintenance from '../upgrade-maintenance.cjs';
import { validateUpgradeHandoff } from '../upgrade-admission.js';
import { inspectUpgradeSource, installUpgradeTarget, runUpgradeEntry, validateUpgradeNpmPrefix } from '../upgrade-entry.js';
import { rejectLegacySchemaProbe } from '../../../skills/comm-bridge/scripts/upgrade-admission.js';

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ue-')));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  const installedRoot = path.join(root, 'p/lib/node_modules/zylos');
  const tempDir = path.join(root, 'target');
  const zylosDir = path.join(root, 'h/zylos');
  for (const dir of [installedRoot, tempDir]) {
    fs.mkdirSync(path.join(dir, 'skills/core'), {recursive:true});
    fs.mkdirSync(path.join(dir, 'cli'), {recursive:true});
    fs.writeFileSync(path.join(dir, 'cli/zylos.js'), '#!/usr/bin/env node\n', {mode:0o755});
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({name:'zylos', version:dir === installedRoot ? '0.9.3' : '0.9.4', bin:{zylos:'./cli/zylos.js'}}));
  }
  fs.mkdirSync(path.join(root, 'p/bin'), {recursive:true});
  fs.symlinkSync('../lib/node_modules/zylos/cli/zylos.js', path.join(root, 'p/bin/zylos'));
  fs.mkdirSync(path.join(zylosDir, '.claude/skills/core/node_modules'), {recursive:true});
  const input = {schemaVersion:1, fromVersion:'0.9.3', installedRoot, tempDir, zylosDir};
  const calls = [];
  const deps = {
    maintenance:{...maintenance, preflightExternalTools:() => calls.push('tools')},
    cleanup:() => ({removed:[]}),
    probe:() => ({needsMigration:false, databases:[{}, {}, {}]}),
    preflight:() => calls.push('preflight'),
    rehearse:() => calls.push('rehearse'),
  };
  return {root, input, deps, calls};
}

test('handoff rejects unsupported sources and malformed paths before discovery or writes', async t => {
  const f = fixture(t);
  for (const version of ['0.9.2', '0.9.3-beta.1', 'invalid']) {
    const result = await runUpgradeEntry({...f.input, fromVersion:version}, {
      maintenance:{discover:() => assert.fail('discovery before admission')},
    });
    assert.equal(result.success, false);
    assert.equal(result.code, 'UPGRADE_SOURCE_TOO_OLD');
    assert.match(result.error, /--branch release\/0\.9\.3/);
    assert.deepEqual(result.persisted, []);
  }
  assert.throws(() => validateUpgradeHandoff({...f.input, tempDir:'relative'}), {code:'INVALID_UPGRADE_HANDOFF'});
  assert.throws(() => validateUpgradeHandoff({...f.input, skillsDir:path.join(f.root, 'other-skills')}), {code:'INVALID_UPGRADE_HANDOFF'});
  assert.equal(fs.existsSync(path.join(f.input.zylosDir, '.backup')), false);
});

test('source inspection carries the installed identity and uses only necessary rehearsal', t => {
  const f = fixture(t);
  const ctx = inspectUpgradeSource(f.input, f.deps);
  assert.equal(ctx.coreDir, f.input.installedRoot);
  assert.equal(ctx.tempDir, f.input.tempDir);
  assert.equal(ctx.from, '0.9.3');
  assert.equal(ctx.to, '0.9.4');
  assert.equal(ctx.targetOwned, true);
  assert.equal(ctx.databaseMode, 'unchanged');
  assert.deepEqual(f.calls, ['tools', 'preflight']);
  f.calls.length = 0;
  const migrating = inspectUpgradeSource(f.input, {...f.deps, probe:() => ({needsMigration:true, databases:[{}, {}, {}]})});
  assert.equal(migrating.databaseMode, 'migrate');
  assert.deepEqual(f.calls, ['tools', 'preflight', 'rehearse']);
});

test('source mismatch and linked installation layouts refuse before preflight', t => {
  const f = fixture(t);
  assert.throws(() => inspectUpgradeSource({...f.input, fromVersion:'0.9.4'}, f.deps), {code:'INVALID_UPGRADE_HANDOFF'});
  fs.writeFileSync(path.join(f.input.tempDir, 'package.json'), JSON.stringify({name:'another-package', version:'0.9.4'}));
  assert.throws(() => inspectUpgradeSource(f.input, f.deps), {code:'INVALID_UPGRADE_HANDOFF'});
  assert.deepEqual(f.calls, []);
  const linked = path.join(f.root, 'linked/lib/node_modules/zylos');
  fs.mkdirSync(path.dirname(linked), {recursive:true});
  fs.symlinkSync(f.input.installedRoot, linked);
  assert.throws(() => inspectUpgradeSource({...f.input, installedRoot:linked}, f.deps), {code:'UNSUPPORTED_INSTALL_LAYOUT'});
  assert.equal(fs.existsSync(path.join(f.input.zylosDir, '.backup')), false);
});

test('an unfinished transaction prevents a new target installation', async t => {
  const f = fixture(t);
  const result = await runUpgradeEntry(f.input, {
    maintenance:{discover:() => ({candidates:[{transactionId:'older'}], diagnostics:[], marker:null})},
    inspect:() => assert.fail('source inspection of blocked upgrade'),
  });
  assert.equal(result.code, 'UPGRADE_RECOVERY_REQUIRED');
  assert.equal(result.recovery_required, true);
  assert.equal(result.rollback.performed, false);
});

test('installation intent opens only after a valid archive is packed', () => {
  const events = [];
  const ctx = {tempDir:'/isolated/target', protectedNpmCli:'/isolated/npm-cli.js'};
  installUpgradeTarget(ctx, {
    runInstaller:(_ctx, options) => {
      events.push(options.stage);
      if (options.stage === 'pack') {
        assert.ok(options.args.includes('--ignore-scripts'));
        return JSON.stringify([{filename:'zylos-0.9.4.tgz'}]);
      }
      assert.deepEqual(events, ['pack', 'intent', 'install']);
      assert.deepEqual(options.args, ['install', '-g', '/isolated/target/zylos-0.9.4.tgz']);
      return '';
    },
    markInstallationIntent:() => events.push('intent'),
  });
  assert.deepEqual(events, ['pack', 'intent', 'install']);
  for (const output of ['not json', '[]', '[{"filename":"../outside.tgz"}]']) {
    let calls = 0;
    assert.throws(() => installUpgradeTarget(ctx, {
      runInstaller:() => { calls += 1; return output; },
      markInstallationIntent:() => assert.fail('intent for invalid archive'),
    }));
    assert.equal(calls, 1);
  }
});

test('target execution preserves recovery materials before installation and delegates failure compensation', async t => {
  const f = fixture(t);
  const events = [];
  let ctx;
  const result = await runUpgradeEntry(f.input, {
    maintenance:{discover:() => ({candidates:[], diagnostics:[], marker:null})},
    inspect:() => (ctx = {...f.input, coreDir:f.input.installedRoot, from:'0.9.3', to:'0.9.4'}),
    resolveNpm:() => '/isolated/npm-cli.js',
    validateNpm:() => {},
    begin:context => { context.transactionDir = path.join(f.root, 'transaction'); events.push('begin'); },
    savePackage:() => events.push('package'),
    saveCode:() => events.push('skills'),
    prepare:() => events.push('snapshot'),
    install:() => { assert.deepEqual(events, ['begin', 'package', 'skills', 'snapshot']); events.push('install'); },
    finalize:() => { events.push('finalize'); return {success:false, error:'target finalization failed'}; },
    recover:context => { assert.equal(context, ctx); events.push('recover'); return {attempted:true, completed:true, recovery_required:false}; },
  });
  assert.equal(result.success, false);
  assert.equal(result.rollback.performed, true);
  assert.equal(result.rollback.completed, true);
  assert.deepEqual(events, ['begin', 'package', 'skills', 'snapshot', 'install', 'finalize', 'recover']);
});


test('legacy target schema probes reject old workers without claiming unavailable old-CLI interception', t => {
  const f = fixture(t);
  const worker = path.join(f.input.installedRoot, 'cli/lib/core-db-backup-worker.js');
  const metadata = path.join(f.input.installedRoot, 'package.json');
  for (const version of ['0.9.1', '0.9.2']) {
    fs.writeFileSync(metadata, JSON.stringify({name:'zylos', version}));
    assert.throws(() => rejectLegacySchemaProbe(['node', worker, JSON.stringify({action:'version-probe'})]), {code:'UPGRADE_SOURCE_TOO_OLD'});
  }
  fs.writeFileSync(metadata, JSON.stringify({name:'zylos', version:'0.9.3'}));
  assert.doesNotThrow(() => rejectLegacySchemaProbe(['node', worker, JSON.stringify({action:'version-probe'})]));
  fs.writeFileSync(metadata, JSON.stringify({name:'zylos', version:'0.9.0'}));
  assert.doesNotThrow(() => rejectLegacySchemaProbe(['node', worker, JSON.stringify({action:'offline-preflight'})]));
});


test('npm prefix inspection refuses a different global installation before replacement', t => {
  const f = fixture(t);
  const cli = path.join(f.root,'npm-cli.js');
  const ctx = {protectedNpmCli:cli,tempDir:f.input.tempDir,coreDir:f.input.installedRoot};
  fs.writeFileSync(cli,'console.log(' + JSON.stringify(path.join(f.root,'wrong/lib/node_modules')) + ');');
  assert.throws(() => validateUpgradeNpmPrefix(ctx),{code:'UNSUPPORTED_INSTALL_LAYOUT'});
  fs.writeFileSync(cli,'console.log(' + JSON.stringify(path.dirname(f.input.installedRoot)) + ');');
  assert.doesNotThrow(() => validateUpgradeNpmPrefix(ctx));
  assert.equal(fs.existsSync(path.join(f.input.zylosDir,'.backup')),false);
});


test('protected npm postinstall does not publish shared settings or Codex configuration', t => {
  const f = fixture(t);
  const home = path.join(f.root,'h');
  fs.mkdirSync(path.join(home,'.codex'),{recursive:true});
  fs.writeFileSync(path.join(home,'.codex/config.toml'),'keep = true\n');
  fs.writeFileSync(path.join(f.input.zylosDir,'.claude/settings.json'),'{"keep":true}');
  const before = maintenance.treeHash(home,{excludeNodeModules:false,includeModes:true});
  const result = spawnSync(process.execPath,[new URL('../../../scripts/postinstall.js',import.meta.url).pathname],{
    cwd:home,encoding:'utf8',env:{HOME:home,ZYLOS_DIR:f.input.zylosDir,ZYLOS_PROTECTED_INSTALL:'1',PATH:path.dirname(process.execPath)+':/usr/bin:/bin'},
  });
  assert.equal(result.status,0,result.stderr);
  assert.equal(maintenance.treeHash(home,{excludeNodeModules:false,includeModes:true}),before);
});


test('downloaded target entry loads and rejects an old handoff before target dependencies exist', t => {
  const f = fixture(t);
  const target = path.join(f.root,'without-dependencies');
  fs.mkdirSync(path.join(target,'cli/lib'),{recursive:true});
  fs.mkdirSync(path.join(target,'skills/comm-bridge/scripts'),{recursive:true});
  fs.writeFileSync(path.join(target,'package.json'),'{"type":"module","name":"zylos","version":"0.9.4"}');
  for (const name of ['upgrade-entry.js','upgrade-admission.js','core-db-backup.js','upgrade-protection.js','upgrade-package.js','upgrade-maintenance.cjs']) {
    fs.copyFileSync(new URL('../'+name,import.meta.url),path.join(target,'cli/lib',name));
  }
  fs.copyFileSync(new URL('../../../skills/comm-bridge/scripts/upgrade-admission.js',import.meta.url),path.join(target,'skills/comm-bridge/scripts/upgrade-admission.js'));
  const result = spawnSync(process.execPath,[path.join(target,'cli/lib/upgrade-entry.js')],{
    input:JSON.stringify({...f.input,fromVersion:'0.9.2',tempDir:target}),encoding:'utf8',
    env:{HOME:path.join(f.root,'h'),PATH:'/usr/bin:/bin'},
  });
  assert.equal(result.status,1,result.stderr);
  assert.equal(JSON.parse(result.stdout).code,'UPGRADE_SOURCE_TOO_OLD');
  assert.equal(fs.existsSync(path.join(target,'node_modules')),false);
  assert.equal(fs.existsSync(path.join(f.input.zylosDir,'.backup')),false);
});
