import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { finalizeWebConsoleRemoval, webConsoleProcesses, inspectWebConsoleTasks } from '../web-console-finalize.js';
import { completeUpgradeFinalization, step11_startCoreServices, step12_verifyServices } from '../self-upgrade.js';
import { startServicesWithDashboard } from '../../commands/init.js';

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
  assert.equal(result.warnings.length, 5);
  assert.doesNotMatch(JSON.stringify(result), /private-value/);
});

test('scheduler inspection combines reply CLI results and a readonly session-component query', t => {
  const root = fixture(t), file = path.join(root, 'scheduler/scheduler.db');
  fs.mkdirSync(path.dirname(file));
  const Database = createRequire(new URL('../../../skills/comm-bridge/package.json', import.meta.url))('better-sqlite3');
  const db = new Database(file);
  db.exec('CREATE TABLE tasks (id TEXT, session_component TEXT); INSERT INTO tasks VALUES (\'session-only\',\'web-console\'),(\'unrelated\',\'dashboard\');');
  db.close();
  const before = fs.readFileSync(file);
  const ids = inspectWebConsoleTasks(root, {Database, run(command, args, options) {
    assert.equal(command, process.execPath);
    assert.deepEqual(args.slice(1), ['list', '--reply-channel', 'web-console', '--json', '--readonly']);
    assert.equal(options.env.ZYLOS_DIR, root);
    return JSON.stringify([{id:'reply-only'}]);
  }});
  assert.deepEqual(ids, ['reply-only', 'session-only']);
  assert.equal(fs.readFileSync(file).equals(before), true);
});

function finalizationDeps(calls, extras = {}) {
  return {
    updateConfig:()=>{}, ensureMemoryMigration:()=>{}, verifyPublicationForServices:()=>{},
    startServices:ctx => { calls.push('start'); assert.deepEqual(ctx.servicesWereRunning, ['scheduler']); },
    verifyServices:ctx => { calls.push('verify'); assert.deepEqual(ctx.servicesWereRunning, ['scheduler']); },
    finalizeWebConsoleRemoval:() => { calls.push('remove'); return {warnings:['removal explanation']}; },
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
    finalizeWebConsoleRemoval:options => {assert.equal(options.noCaddy, true); calls.push('remove'); return {warnings:[]};},
    savePm2ProcessList:()=>{calls.push('save');}, log:()=>{},
  });
  assert.deepEqual(calls, ['start','remove','save']);
});

test('direct startup and verification never restart or wait for the removed external service', t => {
  const root = fixture(t), ecosystem = path.join(root, 'ecosystem.cjs');
  const ctx = {servicesWereRunning:['web-console']};
  const result = step11_startCoreServices(ctx, {zylosDir:root, ecosystemPath:ecosystem,
    execSync:() => {throw Error('PM2 must not run for the removed service');}});
  assert.equal(result.status, 'skipped');
  const verified = step12_verifyServices({servicesWereRunning:['web-console']}, {
    execSync:() => {throw Error('PM2 must not be polled for the removed service');},
  });
  assert.equal(verified.status, 'skipped');
});

test('pending recovery preserves the save guard and reports the required manual save', async t => {
  const root = fixture(t), calls = [];
  const result = await completeUpgradeFinalization({zylosDir:root, servicesWereRunning:['scheduler'], steps:[], mergeConflicts:[], mergedFiles:[]},
    finalizationDeps(calls, {protectedSuccess:()=>({complete:false}), savePm2ProcessList:()=>false}));
  assert.equal(result.success, true);
  assert.match(result.warnings.join(' '), /PM2 startup list still needs saving after recovery cleanup/);
});
