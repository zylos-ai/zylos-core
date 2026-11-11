import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { finalizeWebConsoleRemoval, webConsoleProcesses, inspectWebConsoleTasks } from '../web-console-finalize.js';
import { completeUpgradeFinalization, step11_startCoreServices, step12_verifyServices } from '../self-upgrade.js';
import { startServicesWithDashboard } from '../../commands/init.js';
import { protectedSuccess, maintenance } from '../upgrade-protection.js';
import { savePm2ProcessList } from '../pm2-save.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'console-finalize-'));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  return root;
}

test('PM2 selection requires this instance, the reserved name, an absolute script and numeric id', t => {
  const root = fixture(t), skills = path.join(root, 'skills');
  fs.mkdirSync(path.join(skills, 'web-console/scripts'), {recursive:true});
  fs.writeFileSync(path.join(skills, 'web-console/scripts/server.js'), '');
  const alias = path.join(root, 'alias');
  fs.symlinkSync(skills, alias);
  const row = (pm_id, name, script) => ({pm_id, name, pm2_env:{pm_exec_path:script}});
  const output = 'PM2 startup banner\n' + JSON.stringify([
    row(1, 'web-console', path.join(skills, 'web-console/scripts/server.js')),
    row(2, 'web-console', path.join(alias, 'web-console/scripts/server.js')),
    row(3, 'web-console', path.join(root, 'other/web-console/scripts/server.js')),
    row(4, 'another-name', path.join(skills, 'web-console/scripts/server.js')),
    row(5, 'web-console', 'web-console/scripts/server.js'),
    row(6, 'web-console', path.join(skills, 'web-console-copy/server.js')),
    row('7', 'web-console', path.join(skills, 'web-console/scripts/server.js')),
  ]);
  assert.deepEqual(webConsoleProcesses(output, skills).map(row => row.pm_id), [1, 2]);
});

test('finalizer backs up complete customized code, preserves data, deletes by id and is reentrant', async t => {
  const root = fixture(t), code = path.join(root, '.claude/skills/web-console');
  fs.mkdirSync(path.join(code, 'node_modules'), {recursive:true});
  fs.mkdirSync(path.join(root, 'web-console'));
  fs.writeFileSync(path.join(code, 'custom.js'), 'owner modification');
  fs.writeFileSync(path.join(code, 'node_modules/keep'), 'dependency');
  fs.writeFileSync(path.join(root, 'web-console/history'), 'historical data');
  fs.writeFileSync(path.join(root, '.env'), 'WEB_CONSOLE_PASSWORD=private-value\nWEB_CONSOLE_MAX_UPLOAD_MB=upload-value\n');
  let listed = true;
  const calls = [];
  const deps = {
    run(command, args) {
      calls.push([command, ...args]);
      if (args[0] === 'jlist') return JSON.stringify(listed ? [{pm_id:17, name:'web-console', pm2_env:{pm_exec_path:path.join(code, 'scripts/server.js')}}] : []);
      assert.deepEqual(args, ['delete', '17']); listed = false;
    },
    removeRoute:() => { calls.push(['caddy']); return {warnings:['Caddy route removed.']}; },
    inspectTasks:() => { calls.push(['tasks']); return ['session-only']; },
  };
  const first = await finalizeWebConsoleRemoval({zylosDir:root}, deps);
  assert.equal(first.pm2Changed, true);
  assert.deepEqual(calls.map(call => call[1] || call[0]), ['jlist', 'delete', 'caddy', 'tasks']);
  const backup = fs.readdirSync(path.join(root, '.backup'));
  assert.equal(backup.length, 1);
  assert.equal(fs.readFileSync(path.join(root, '.backup', backup[0], 'custom.js'), 'utf8'), 'owner modification');
  assert.equal(fs.readFileSync(path.join(root, '.backup', backup[0], 'node_modules/keep'), 'utf8'), 'dependency');
  assert.equal(fs.readFileSync(path.join(root, 'web-console/history'), 'utf8'), 'historical data');
  assert.equal(fs.readFileSync(path.join(root, '.env'), 'utf8'), 'DASHBOARD_MAX_UPLOAD_MB=upload-value\n');
  assert.match(first.warnings.join(' '), /session-only/);
  assert.doesNotMatch(JSON.stringify(first), /private-value|upload-value/);
  const second = await finalizeWebConsoleRemoval({zylosDir:root}, deps);
  assert.equal(second.pm2Changed, false);
  assert.equal(fs.readdirSync(path.join(root, '.backup')).length, 1);
});

test('individual failures remain warnings and later cleanup continues without values', async t => {
  const root = fixture(t), calls = [];
  const result = await finalizeWebConsoleRemoval({zylosDir:root}, {
    run:() => { throw Error('private-value'); },
    removeRoute:() => { calls.push('route'); throw Error('private-value'); },
    cleanupEnv:() => { calls.push('env'); throw Error('private-value'); },
    inspectTasks:() => { calls.push('tasks'); throw Error('private-value'); },
  });
  assert.deepEqual(calls, ['route', 'env', 'tasks']);
  assert.equal(result.warnings.length, 4);
  assert.doesNotMatch(JSON.stringify(result), /private-value/);
});

test('scheduler inspection reads both legacy destinations without changing database bytes', t => {
  const root = fixture(t), file = path.join(root, 'scheduler/scheduler.db');
  fs.mkdirSync(path.dirname(file));
  const Database = createRequire(new URL('../../../skills/comm-bridge/package.json', import.meta.url))('better-sqlite3');
  const db = new Database(file);
  db.exec("CREATE TABLE tasks (id TEXT, session_component TEXT, reply_channel TEXT); INSERT INTO tasks VALUES ('reply-only','origin','web-console'),('session-only','web-console','lark'),('unrelated','dashboard','lark');");
  db.close();
  const before = fs.readFileSync(file);
  const ids = inspectWebConsoleTasks(root, {Database});
  assert.deepEqual(ids, ['reply-only', 'session-only']);
  assert.equal(fs.readFileSync(file).equals(before), true);
});

function finalizationDeps(calls, extras = {}) {
  return {
    updateConfig:()=>{}, ensureMemoryMigration:()=>{}, verifyPublicationForServices:()=>{},
    startServices:ctx => { calls.push('start'); assert.deepEqual(ctx.servicesWereRunning, ['scheduler']); },
    verifyServices:ctx => { calls.push('verify'); assert.deepEqual(ctx.servicesWereRunning, ['scheduler']); },
    finalizeWebConsoleRemoval:() => { calls.push('remove'); return {warnings:['removal explanation'],pm2Changed:true}; },
    dashboardOwner:{verifyDashboard:() => {calls.push('dashboard'); return {state:'ready'};}},
    readModeStatus:()=>({sessionMode:'single', transition:null}), readMode:()=>({mode:'single'}), readTransition:()=>null,
    restart:()=>({ok:true,data:{result:'exit_enqueued'}}), audit:()=>[],
    protectedSuccess:()=> {calls.push('terminal'); return {complete:true};},
    savePm2ProcessList:()=>{calls.push('save'); return true;},
    ...extras,
  };
}

test('cleanup follows verified Core and startup save follows Dashboard and terminal cleanup without restore branch', async t => {
  const root = fixture(t), calls = [];
  const result = await completeUpgradeFinalization({zylosDir:root, servicesWereRunning:['web-console','scheduler'], steps:[], mergeConflicts:[], mergedFiles:[]}, finalizationDeps(calls));
  assert.equal(result.success, true);
  assert.deepEqual(calls, ['start','verify','remove','dashboard','terminal','save']);
  assert.ok(result.warnings.includes('removal explanation'));
});

test('cleanup and final save are skipped when Core verification fails', async t => {
  const root = fixture(t), calls = [];
  const ctx = {zylosDir:root, servicesWereRunning:['web-console','scheduler'], steps:[], journal:{}, maintenance:{
    canRecognizeProcesses:()=>true, transaction:()=>({}), classifyCutoff:()=> 'closed', update:()=>{}, stop:()=>{},
  }};
  const result = await completeUpgradeFinalization(ctx, finalizationDeps(calls, {verifyServices:()=>({status:'failed', error:'Core unavailable'}), stopServices:()=>{}}));
  assert.equal(result.success, false);
  assert.deepEqual(calls, ['start']);
});

for (const scenario of ['registration failure', 'restore failure', 'completed registration']) {
  test(`final startup save follows cleanup after Dashboard ${scenario}`, async t => {
    const root = fixture(t), calls = [];
    const ctx = {zylosDir:root, servicesWereRunning:['web-console','scheduler','zylos-dashboard'],
      steps:[], mergeConflicts:[], mergedFiles:[], firstDashboardTakeover:scenario !== 'restore failure'};
    if (scenario === 'completed registration') {
      ctx.journal = {dashboardInstall:{items:{registration:{state:'done'}}}};
    }
    const owner = {
      applyDashboardRegistration:() => {
        calls.push('registration');
        assert.equal(scenario, 'registration failure');
        throw Error('registration failed before saving');
      },
      applyDashboardRoute:() => {calls.push('route'); return {state:'skipped'};},
      restoreDashboardService:() => {calls.push('restore'); throw Error('restore failed before saving');},
      verifyDashboard:() => {calls.push('dashboard'); return {state:'ready'};},
    };
    const result = await completeUpgradeFinalization(ctx, finalizationDeps(calls, {dashboardOwner:owner}));
    assert.equal(result.success, true);
    assert.equal(result.dashboard.state, scenario === 'completed registration' ? 'ready' : 'degraded');
    const expected = scenario === 'restore failure' ? ['restore'] : scenario === 'registration failure'
      ? ['registration','route','dashboard'] : ['route','dashboard'];
    assert.deepEqual(calls, ['start','verify','remove',...expected,'terminal','save']);
    assert.equal(calls.filter(call => call === 'save').length, 1);
  });
}

test('init reuses cleanup after startup then saves the final process list', async () => {
  const calls = [];
  await startServicesWithDashboard({caddy:false}, async () => {calls.push('start'); return 4;}, {
    finalizeWebConsoleRemoval:options => {assert.equal(options.noCaddy, true); assert.match(options.dashboardUrl, /^http:\/\/127\.0\.0\.1:3470\/$/); calls.push('remove'); return {warnings:[],pm2Changed:true};},
    savePm2ProcessList:()=>{calls.push('save');}, log:()=>{},
  });
  assert.deepEqual(calls, ['start','remove','save']);
});

test('finalization filters removed services without mutating the caller running set', async t => {
  const root = fixture(t), calls = [], running = ['web-console','scheduler'];
  await completeUpgradeFinalization({zylosDir:root,servicesWereRunning:running,steps:[],mergeConflicts:[],mergedFiles:[]},finalizationDeps(calls));
  assert.deepEqual(running,['web-console','scheduler']);
});

test('fresh cleanup and residue-free reentry do not announce removal or require saving', async t => {
  const root = fixture(t);
  const deps = {run:()=> '[]',removeRoute:()=>({warnings:[]}),inspectTasks:()=>[]};
  for (let i=0;i<2;i++) assert.deepEqual(await finalizeWebConsoleRemoval({zylosDir:root},deps),{warnings:[],pm2Changed:false});
});

test('pending recovery preserves the save guard and reports the required manual save', async t => {
  const root = fixture(t), calls = [];
  const result = await completeUpgradeFinalization({zylosDir:root, servicesWereRunning:['scheduler'], steps:[], mergeConflicts:[], mergedFiles:[]},
    finalizationDeps(calls, {protectedSuccess:()=>({complete:false}), savePm2ProcessList:()=>false}));
  assert.equal(result.success, true);
  assert.match(result.warnings.join(' '), /PM2 startup list still needs saving after recovery cleanup/);
});

test('real terminal cleanup releases the real save guard and clears durable removal intent', async t => {
  const root = fs.realpathSync(fixture(t)), calls = [];
  const dir = path.join(root,'.backup/self-upgrade/removed-console');
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  fs.mkdirSync(path.join(root,'.zylos/upgrade'),{recursive:true,mode:0o700});
  const journal = {formatVersion:1,transactionId:'removed-console',zylosDir:root,
    nodePath:process.execPath,skillsDir:path.join(root,'.claude/skills'),phase:'installing',installationIntent:true,
    dbBackupDir:path.join(root,'.backup/db/removed-console'),snapshotManifestHash:'a'.repeat(64),originalServices:[],
    coreManifest:[{name:'core',existedBefore:false,backedUp:false,originalHash:null}],
    initialIdentity:{nodePath:process.execPath,packageJson:path.join(root,'package.json'),packageHash:'b'.repeat(64),
      cliRoot:path.join(root,'cli'),cliHash:'c'.repeat(64),workerPath:path.join(root,'worker.js'),workerHash:'d'.repeat(64),
      ecosystemHash:null,databases:maintenance.databasePaths(2).map(source=>({source,exists:false}))},
    webConsolePm2SavePending:true};
  maintenance.update(dir,journal);
  maintenance.marker(root,dir,journal);
  assert.equal(savePm2ProcessList({root,save:()=>{throw Error('Active recovery must prevent saving');},log:()=>{}}),false);
  let saves = 0;
  const ctx = {zylosDir:root,transactionDir:dir,journal,servicesWereRunning:['scheduler'],steps:[],mergeConflicts:[],mergedFiles:[]};
  const result = await completeUpgradeFinalization(ctx,finalizationDeps(calls,{
    finalizeWebConsoleRemoval:()=>({warnings:[],pm2Changed:false}),
    protectedSuccess,
    savePm2ProcessList:options=>savePm2ProcessList({...options,save:()=>{
      assert.equal(fs.existsSync(path.join(root,'.zylos/upgrade/active.json')),false);
      saves++;
    }}),
  }));
  assert.equal(result.success,true);
  assert.equal(saves,1);
  const saved = maintenance.read(path.join(dir,'journal.json'));
  assert.equal(saved.phase,'upgrade_complete');
  assert.equal(saved.cleanup.complete,true);
  assert.equal(saved.webConsolePm2SavePending,false);
});

test('Dashboard registration saves after deletion and prevents a duplicate final save', async t => {
  const root = fixture(t), calls = [];
  await completeUpgradeFinalization({zylosDir:root,firstDashboardTakeover:true,servicesWereRunning:['scheduler'],steps:[],mergeConflicts:[],mergedFiles:[]},
    finalizationDeps(calls,{dashboardOwner:{
      applyDashboardRegistration:()=>{calls.push('registration-save');return {state:'done'};},
      applyDashboardRoute:()=>({state:'skipped'}),verifyDashboard:()=>({state:'ready'}),
    }}));
  assert.deepEqual(calls,['start','verify','remove','registration-save','terminal']);
});

test('upgrade persists save intent before deleting and resolves a direct Dashboard address', async t => {
  const root = fixture(t), calls = [], dir = path.join(root,'transaction');
  fs.mkdirSync(dir);
  maintenance.update(dir,{});
  const code = path.join(root,'.claude/skills/web-console');
  const ctx = {zylosDir:root,transactionDir:dir,journal:{},servicesWereRunning:['scheduler'],steps:[],mergeConflicts:[],mergedFiles:[]};
  await assert.rejects(()=>completeUpgradeFinalization(ctx,finalizationDeps(calls,{
    finalizeWebConsoleRemoval:options=>{
      assert.equal(options.dashboardUrl,'http://127.0.0.1:3470/');
      return finalizeWebConsoleRemoval(options,{
        run:(_command,args)=>{
          if(args[0]==='jlist')return JSON.stringify([{pm_id:7,name:'web-console',pm2_env:{pm_exec_path:path.join(code,'server.js')}}]);
          assert.deepEqual(args,['delete','7']);
          assert.equal(maintenance.read(path.join(dir,'journal.json')).webConsolePm2SavePending,true);
        },removeRoute:()=>({warnings:[]}),inspectTasks:()=>[],
      });
    },protectedSuccess:()=>{throw Error('interrupted terminal');},
  })),/interrupted terminal/);
  assert.equal(maintenance.read(path.join(dir,'journal.json')).webConsolePm2SavePending,true);
});

test('fresh upgrade has no removal announcement, final save or recovery-save warning', async t => {
  const root = fixture(t), calls = [];
  const result=await completeUpgradeFinalization({zylosDir:root,servicesWereRunning:['scheduler'],steps:[],mergeConflicts:[],mergedFiles:[]},
    finalizationDeps(calls,{finalizeWebConsoleRemoval:options=>finalizeWebConsoleRemoval(options,{
      run:()=> '[]',removeRoute:()=>({warnings:[]}),inspectTasks:()=>[],
    }),savePm2ProcessList:()=>{throw Error('Fresh upgrade must not save again');}}));
  assert.deepEqual(result.warnings,[]);
});
