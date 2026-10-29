import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { completeUpgradeFinalization } from '../self-upgrade.js';
import * as dashboardOwner from '../dashboard-install.js';
import { Store } from '../../../skills/dashboard/src/lib/store.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const maintenance = createRequire(import.meta.url)('../upgrade-maintenance.cjs');
const secret = 'synthetic-dashboard-password-do-not-forward';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-finalizer-'));
  const code = path.join(root, '.claude/skills/dashboard');
  const data = path.join(root, 'components/dashboard');
  const bin = path.join(root, 'bin');
  for (const dir of [path.join(code, 'hooks'), data, bin, path.join(root, 'pm2')]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(code, 'package.json'), '{"type":"module"}');
  for (const item of ['src', 'public', 'node_modules']) fs.symlinkSync(path.join(repo, 'skills/dashboard', item), path.join(code, item), 'dir');
  fs.writeFileSync(path.join(code, 'hooks/post-install.js'), `console.log(${JSON.stringify(secret)});console.error(${JSON.stringify(secret)});if(process.env.FAIL_HOOK==='1')process.exit(1);`);
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ port: 3470, auth: { enabled: true, password: 'fixture-hash' } }));
  fs.writeFileSync(path.join(root, 'pm2/ecosystem.config.cjs'), '// Core-published fixture\n');
  fs.writeFileSync(path.join(bin, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(bin, 'pm2'), `#!${process.execPath}
import fs from 'node:fs';import path from 'node:path';
import net from 'node:net';
const root=process.env.ZYLOS_DIR, code=path.join(root,'.claude/skills/dashboard');
const args=process.argv.slice(2);
fs.appendFileSync(path.join(root,'pm2-calls'),JSON.stringify(args)+'\\n');
if(args[0]==='start' && process.env.FAIL_MIGRATION==='1') {
  const {Store}=await import(${JSON.stringify(path.join(repo, 'skills/dashboard/src/lib/store.js'))});
  try {new Store(path.join(root,'components/dashboard/dashboard.db')).close();}
  catch(error) {fs.writeFileSync(path.join(root,'migration-error'),error.message);process.exit(1);}
}
if(args[0]==='jlist')console.log(JSON.stringify([{name:'zylos-dashboard',pm2_env:{status:'online',pm_exec_path:path.join(code,'src/index.js'),pm_cwd:code}}]));
`, { mode: 0o755 });
  for (const item of ['home','pm2-home','tmp']) fs.mkdirSync(path.join(root,item));
  const env = { ...process.env, HOME:path.join(root,'home'), PM2_HOME:path.join(root,'pm2-home'), TMPDIR:path.join(root,'tmp'), ZYLOS_DIR: root, PATH: bin + path.delimiter + process.env.PATH };
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, code, data, env };
}

async function closedLoopbackPort() {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}

function prerequisites() {
  return {

    updateConfig: () => {}, ensureMemoryMigration: () => {}, verifyPublicationForServices: () => {}, protectedSuccess: () => {},
    startServices: () => ({ status: 'done' }), verifyServices: () => ({ status: 'done' }),
    readModeStatus: () => ({ sessionMode: 'single', transition: null }),
    readMode: () => ({ mode: 'single' }), readTransition: () => null,
    restart: () => ({ ok: true, data: { result: 'exit_enqueued' } }), audit: () => []
  };
}

for (const failHook of [false, true]) test(`finalizer child preserves JSON stdout and hides noisy hook credentials (${failHook ? 'failure' : 'success'})`, t => {
  const { root, env } = fixture(t);
  const script = `
    import {completeUpgradeFinalization} from ${JSON.stringify(path.join(repo, 'cli/lib/self-upgrade.js'))};
    import {applyDashboardRegistration} from ${JSON.stringify(path.join(repo, 'cli/lib/dashboard-install.js'))};
    const root=process.env.ZYLOS_DIR;
    const ctx={zylosDir:root,from:'0.9.3',to:'new',servicesWereRunning:[],steps:[],mergeConflicts:[],mergedFiles:[],journal:{firstTakeover:true}};
    const deps=(${prerequisites.toString()})();
    deps.dashboardOwner={applyDashboardRegistration,applyDashboardRoute:()=>({state:'done'}),verifyDashboard:()=>({state:'ready',errors:[]})};
    process.stdout.write(JSON.stringify(await completeUpgradeFinalization(ctx,deps)));
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 15000, env: { ...env, FAIL_HOOK: failHook ? '1' : '0' }
  });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.success, true);
  assert.equal(result.completion.dashboard, failHook ? 'degraded' : 'ready');
  assert.equal(child.stdout.includes(secret), false);
  assert.equal(child.stderr.includes(secret), false);
  if (!failHook) assert.deepEqual(fs.readFileSync(path.join(root, 'pm2-calls'), 'utf8').trim().split('\n').map(JSON.parse).map(args => args[0]), ['start', 'jlist', 'save']);
});

test('real Store migration 20 failure leaves Core upgrade_complete and Dashboard degraded', async t => {
  const { root, data, env } = fixture(t);
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({port: await closedLoopbackPort(), auth: {enabled: true, password: 'fixture-hash'}}));
  const dbPath = path.join(data, 'dashboard.db');
  const store = new Store(dbPath);
  store.db.exec(`DROP INDEX idx_events_group_seq;
    DROP TABLE core_log_cursors;
    ALTER TABLE runtime_events DROP COLUMN session_group;
    ALTER TABLE runtime_events DROP COLUMN run_id;
    DELETE FROM schema_migrations WHERE version=20;
    CREATE TRIGGER reject_migration20 BEFORE INSERT ON schema_migrations WHEN NEW.version=20
      BEGIN SELECT RAISE(ABORT, 'fixture migration20 failed'); END;`);
  assert.equal(store.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v, 13);
  store.close();
  const transactionDir = path.join(root, 'transaction');
  fs.mkdirSync(transactionDir);
  const journal = { firstTakeover: true, phase: 'compensation_closed', transactionId: 'fixture', snapshotManifestHash: 'a'.repeat(64),
    compensationCutoff: { formatVersion: 1, closed: true, transactionId: 'fixture', snapshotManifestHash: 'a'.repeat(64), closedAt: '2026-10-27T00:00:00.000Z', writer: 'finalizer' } };
  fs.writeFileSync(path.join(transactionDir, 'journal.json'), JSON.stringify(journal));
  let terminalCalls = 0, restartCalls = 0;
  const ctx = { zylosDir: root, from: '0.9.3', to: 'new', servicesWereRunning: [], steps: [], mergeConflicts: [], mergedFiles: [],
    transactionDir, transactionId: 'fixture', journal,
    maintenance: { ...maintenance, finishTerminal: () => { terminalCalls++; } } };
  const priorPath = process.env.PATH, priorFail = process.env.FAIL_MIGRATION;
  process.env.PATH = env.PATH; process.env.FAIL_MIGRATION = '1';
  let result;
  try {
    result = await completeUpgradeFinalization(ctx, { ...prerequisites(), dashboardOwner, protectedSuccess: undefined,
      restart: () => { restartCalls++; return {ok: true, data: {result: 'exit_enqueued'}}; } });
  } finally {
    process.env.PATH = priorPath;
    if (priorFail === undefined) delete process.env.FAIL_MIGRATION; else process.env.FAIL_MIGRATION = priorFail;
  }
  assert.equal(fs.readFileSync(path.join(root, 'migration-error'), 'utf8'), 'fixture migration20 failed');
  assert.equal(result.success, true);
  assert.equal(result.completion.install, 'done');
  assert.equal(result.completion.dashboard, 'degraded');
  assert.equal(restartCalls, 1);
  assert.equal(result.completion.sessionRestart, 'single_exit_enqueued');
  assert.ok(result.dashboard.errors.some(error => error.code === 'health_failed'), JSON.stringify(result.dashboard));
  const persisted = JSON.parse(fs.readFileSync(path.join(transactionDir, 'journal.json'), 'utf8'));
  assert.equal(persisted.phase, 'upgrade_complete');
  assert.deepEqual(persisted.terminalEvidence, { verified: true, kind: 'code_data_services' });
  assert.equal(terminalCalls, 1);
  const Database = createRequire(path.join(repo, 'skills/dashboard/package.json'))('better-sqlite3');
  const db = new Database(dbPath, { readonly: true });
  try {
    assert.equal(db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v, 13);
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='core_log_cursors'").get(), undefined);
    assert.equal(db.pragma('table_info(runtime_events)').some(column => column.name === 'session_group'), false);
  } finally { db.close(); }
  // Positive control: the same real Store succeeds once the injected fault is removed.
  const repair = new Database(dbPath);
  repair.exec('DROP TRIGGER reject_migration20');
  repair.close();
  const recovered = new Store(dbPath);
  try { assert.equal(recovered.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v, 20); }
  finally { recovered.close(); }
});


// Independent children exercise the full fixed HTTP window without sharing fetch
// or environment mutations with another finalizer.
test('hung health headers and bodies time out after a full step window and Core continues',{concurrency:2},async t=>{
  await Promise.all([false,true].map(sendHeaders=>t.test(sendHeaders?'body never completes':'headers never arrive',async childTest=>{
    const {root,data,env}=fixture(childTest);
    let requests=0;
    const server=http.createServer((_req,res)=>{requests++;if(sendHeaders){res.writeHead(200,{'content-type':'application/json'});res.flushHeaders();}});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    childTest.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
    fs.writeFileSync(path.join(data,'config.json'),JSON.stringify({port:server.address().port}));
    const script=`
      import {completeUpgradeFinalization} from ${JSON.stringify(path.join(repo,'cli/lib/self-upgrade.js'))};
      import * as dashboardOwner from ${JSON.stringify(path.join(repo,'cli/lib/dashboard-install.js'))};
      const ctx={zylosDir:process.env.ZYLOS_DIR,from:'0.9.3',to:'new',journal:{firstTakeover:false},servicesWereRunning:[],steps:[],mergeConflicts:[],mergedFiles:[]};
      let restartCalls=0;const started=Date.now();
      const result=await completeUpgradeFinalization(ctx,{...(${prerequisites.toString()})(),dashboardOwner,
        restart:()=>{restartCalls++;return {ok:true,data:{result:'exit_enqueued'}};}});
      process.stdout.write(JSON.stringify({result,restartCalls,elapsed:Date.now()-started}));
    `;
    const child=spawn(process.execPath,['--input-type=module','-e',script],{env,stdio:['ignore','pipe','pipe'],timeout:40000});
    let stdout='',stderr='';child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
    const status=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
    assert.equal(status,0,stderr);
    const {result,restartCalls,elapsed}=JSON.parse(stdout);
    assert.equal(requests,1);assert.equal(result.success,true);assert.equal(result.completion.dashboard,'degraded');
    assert.deepEqual(result.dashboard.errors.map(error=>error.code),['verify_timeout']);
    assert.equal(restartCalls,1);assert.ok(elapsed>=29500 && elapsed<35000,`elapsed ${elapsed}ms`);
  })));
});
