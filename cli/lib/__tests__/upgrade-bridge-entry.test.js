import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertSupportedUpgradeVersion, rejectLegacySchemaProbe } from '../../../skills/comm-bridge/scripts/upgrade-admission.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-bridge-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('source admission rejects old, malformed and pre-bridge prerelease versions', () => {
  for (const version of ['0.5.0', '0.8.3', '0.9.0', '0.9.1', '0.9.2', '0.9.3-beta.1', undefined, 'latest', '01.9.3']) {
    assert.throws(() => assertSupportedUpgradeVersion(version), error =>
      error.code === 'UPGRADE_SOURCE_TOO_OLD' && error.message.includes('zylos upgrade --self --branch release/0.9') && error.persisted.length === 0);
  }
  for (const version of ['0.9.3', '0.9.3+build.1', '0.9.4-beta.1', '0.10.0', '1.0.0-beta.1', '1.0.0']) {
    assert.equal(assertSupportedUpgradeVersion(version), version);
  }
});

test('schema probe rejects old installed caller before schema or driver access', t => {
  const root = fixture(t), worker = path.join(root, 'cli/lib/core-db-backup-worker.js');
  for (const version of ['0.9.1', '0.9.2']) {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version }));
    assert.throws(() => rejectLegacySchemaProbe(['node', worker, JSON.stringify({ action: 'version-probe' })]), { code: 'UPGRADE_SOURCE_TOO_OLD' });
  }
  fs.writeFileSync(path.join(root, 'package.json'), '{"version":"0.9.3"}');
  assert.doesNotThrow(() => rejectLegacySchemaProbe(['node', worker, '{"action":"version-probe"}']));
  assert.doesNotThrow(() => rejectLegacySchemaProbe(['node', '/unrelated/command.js']));
  assert.doesNotThrow(() => rejectLegacySchemaProbe(['node', worker, '{"action":"snapshot"}']));
});

test('importing the actual target schema rejects a legacy version-probe caller', t => {
  const root = fixture(t), worker = path.join(root, 'cli/lib/core-db-backup-worker.js');
  fs.mkdirSync(path.dirname(worker), {recursive:true});
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({version:'0.9.2'}));
  fs.writeFileSync(worker, `process.argv[2] = JSON.stringify({action:'version-probe'}); import(${JSON.stringify(path.resolve('skills/comm-bridge/scripts/c4-schema.js'))}).catch(error => { console.error(error.code); process.exitCode=1; });`);
  const child = spawnSync(process.execPath, [worker], {encoding:'utf8'});
  assert.equal(child.status, 1, child.stderr);
  assert.match(child.stderr, /UPGRADE_SOURCE_TOO_OLD/);
});

test('thin entry refuses recovery failure before checking or downloading updates', async () => {
  const {upgradeSelfCore} = await import('../../commands/component.js');
  let checked = false;
  const result = await upgradeSelfCore({skipConfirm:true}, {
    recoverBeforeUpgrade() {throw Object.assign(Error('recovery blocked'), {code:'UPGRADE_RECOVERY_REQUIRED'});},
    checkForCoreUpdates() {checked=true; return {success:true,hasUpdate:false};},
    console:{log(){},error(){}},
  });
  assert.equal(result, false);
  assert.equal(checked, false);
});

test('actual preinstall rejects legacy upgrades and allows fresh/new upgrades without target dependencies', t => {
  const root = fixture(t), script = path.resolve('scripts/preinstall.js');
  const env = { ...process.env, HOME: root, PM2_HOME: path.join(root, '.pm2') };
  delete env.ZYLOS_SKIP_POSTINSTALL;
  delete env.ZYLOS_UPGRADE_FROM_VERSION;
  const run = extra => spawnSync(process.execPath, [script], { env: { ...env, ...extra }, encoding: 'utf8' });
  assert.equal(run({}).status, 0);
  for (const value of ['', '0', 'true', '01', ' 1']) {
    const child=run({ZYLOS_SKIP_POSTINSTALL:value,ZYLOS_UPGRADE_FROM_VERSION:'0.9.2'});
    assert.equal(child.status,0,child.stderr);
  }
  for (const version of [undefined, '0.5.0', '0.8.3', '0.9.0', '0.9.1', '0.9.2']) {
    const child = run({ ZYLOS_SKIP_POSTINSTALL: '1', ...(version ? { ZYLOS_UPGRADE_FROM_VERSION: version } : {}) });
    assert.equal(child.status, 1);
    assert.match(child.stderr, /UPGRADE_SOURCE_TOO_OLD/);
    assert.match(child.stderr, /release\/0\.9/);
    assert.match(child.stderr, /Do not assume npm restored/);
  }
  for (const version of ['0.9.3', '1.0.0-beta.1', '1.0.0']) {
    assert.equal(run({ ZYLOS_SKIP_POSTINSTALL: '1', ZYLOS_UPGRADE_FROM_VERSION: version }).status, 0);
  }
  assert.deepEqual(fs.readdirSync(root), []);
});

test('thin entry forwards handoff, preserves environment and has no whole-command timeout', async t => {
  const { runDownloadedUpgrade } = await import('../../commands/component.js');
  const root = fixture(t);
  fs.mkdirSync(path.join(root, 'cli/lib'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  fs.writeFileSync(path.join(root, 'cli/lib/upgrade-entry.js'), '');
  const handoff = { schemaVersion: 1, fromVersion: '0.9.3', tempDir: root, installedRoot: '/installed', zylosDir: '/private' };
  assert.equal(runDownloadedUpgrade(handoff, { spawn(node, args, options) {
    assert.equal(node, process.execPath);
    assert.deepEqual(args, [path.join(root, 'cli/lib/upgrade-entry.js')]);
    assert.deepEqual(JSON.parse(options.input), handoff);
    assert.deepEqual(options.stdio, ['pipe', 'inherit', 'inherit']);
    assert.equal(options.env.NODE_OPTIONS, process.env.NODE_OPTIONS);
    assert.equal(Object.hasOwn(options, 'timeout'), false);
    return { status: 37 };
  } }), 37);
  fs.unlinkSync(path.join(root, 'cli/lib/upgrade-entry.js'));
  assert.throws(() => runDownloadedUpgrade(handoff, { spawn() { assert.fail('incomplete package executed'); } }), {message:'Incomplete target package: cli/lib/upgrade-entry.js'});
});

for (const phase of ['check-throw','check-result','download-throw','download-result','package-check']) test(`thin entry reports pretransaction ${phase} failure`,async t=>{
  const {upgradeSelfCore,runDownloadedUpgrade}=await import('../../commands/component.js');
  const root=fixture(t), output=[];
  const failure=()=>Object.assign(Error("Cannot read '/private/source/package.json'\nRequire stack: /private/source.js"),{code:'MODULE_NOT_FOUND'});
  const deps={
    zylosDir:root,recoverBeforeUpgrade(){},
    checkForCoreUpdates(){
      if(phase==='check-throw')throw failure();
      if(phase==='check-result')return {success:false,code:'ERR_INVALID_ARG_TYPE',message:failure().message};
      return {success:true,current:'0.9.3',latest:'1.0.0',hasUpdate:true};
    },
    downloadCoreToTemp(){
      if(phase==='download-throw')throw failure();
      if(phase==='download-result')return {success:false,code:'SQLITE_ERROR',error:failure().message};
      return {success:true,tempDir:root};
    },
    runDownloadedUpgrade(input){return runDownloadedUpgrade(input,{spawn(){assert.fail('incomplete target executed');}});},
    cleanupCoreTemp(directory){assert.equal(directory,root);},
    console:{log(value){output.push(JSON.parse(value));}}
  };
  assert.equal(await upgradeSelfCore({skipConfirm:true,jsonOutput:true},deps),false);
  assert.equal(output.length,1);
  assert.equal(output[0].success,false);
  assert.equal(output[0].code,'UPGRADE_FAILED');
  assert.deepEqual(output[0].persisted,[]);
  assert.doesNotMatch(output[0].error,/\/private\/|ENOENT|Require stack/);
  if(phase==='package-check')assert.equal(output[0].error,'Incomplete target package: package.json');
  else assert.equal(output[0].error,"Cannot read '<path>'");
  assert.equal(fs.existsSync(path.join(root,'.backup')),false);
});

test('up-to-date path never invokes removed same-version retry or downloader', async t => {
  const { upgradeSelfCore } = await import('../../commands/component.js');
  assert.equal(await upgradeSelfCore({ skipConfirm: true }, {
    zylosDir:fixture(t),
    checkForCoreUpdates: () => ({ success: true, current: '1.0.0', latest: '1.0.0', hasUpdate: false }),
    selectSameVersionRetry() { assert.fail('removed retry was invoked'); },
    downloadCoreToTemp() { assert.fail('up-to-date downloaded'); },
    console: { log() {} },
  }), true);
});

test('thin entry reports a missing deployment before checking or downloading', async t => {
  const {upgradeSelfCore}=await import('../../commands/component.js');
  const output=[];
  assert.equal(await upgradeSelfCore({skipConfirm:true,jsonOutput:true},{
    zylosDir:path.join(fixture(t),'missing'),
    checkForCoreUpdates(){assert.fail('missing deployment checked updates');},
    console:{log(value){output.push(JSON.parse(value));}}
  }),false);
  assert.equal(output[0].code,'ZYLOS_NOT_INITIALIZED');
  assert.deepEqual(output[0].persisted,[]);
  assert.equal(output[0].recovery_required,false);
  assert.match(output[0].error,/Initialize this deployment/);
  assert.doesNotMatch(output[0].error,/ENOENT|at |\/home\//);
});

test('thin entry retains recovery guidance and empty persisted list', async t => {
  const {upgradeSelfCore}=await import('../../commands/component.js');
  const output=[];
  assert.equal(await upgradeSelfCore({skipConfirm:true,jsonOutput:true},{
    zylosDir:fixture(t),
    recoverBeforeUpgrade(){throw Object.assign(Error('unfinished upgrade'),{code:'UPGRADE_RECOVERY_REQUIRED',recovery_required:true,next:'Run zylos recovery resume.'});},
    checkForCoreUpdates(){assert.fail('recovery rejection checked updates');},
    console:{log(value){output.push(JSON.parse(value));}}
  }),false);
  assert.equal(output[0].code,'UPGRADE_RECOVERY_REQUIRED');
  assert.deepEqual(output[0].persisted,[]);
  assert.equal(output[0].recovery_required,true);
  assert.match(output[0].next,/recovery resume/);
});

test('self check rejects overwrite before update discovery', () => {
  const child=spawnSync(process.execPath,[path.resolve('cli/zylos.js'),'upgrade','--self','--check','--mode','overwrite','--json'],{encoding:'utf8'});
  assert.equal(child.status,1,child.stderr);
  assert.deepEqual(JSON.parse(child.stdout),{success:false,code:'INVALID_ARGS',error:'Core self-upgrade supports only --mode merge.',persisted:[]});
});

test('overwrite mode is rejected before recovery or downloading', async () => {
  const {upgradeSelfCore}=await import('../../commands/component.js');
  const output=[];
  assert.equal(await upgradeSelfCore({mode:'overwrite',jsonOutput:true},{
    recoverBeforeUpgrade(){assert.fail('unsupported mode ran recovery');},
    console:{log(value){output.push(JSON.parse(value));}}
  }),false);
  assert.deepEqual(output,[{success:false,code:'INVALID_ARGS',error:'Core self-upgrade supports only --mode merge.',persisted:[]}]);
});
