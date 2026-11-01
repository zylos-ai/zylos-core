import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL, fileURLToPath} from 'node:url';
import {spawn, spawnSync} from 'node:child_process';
import {once} from 'node:events';
import assert from 'node:assert/strict';

const input = JSON.parse(process.argv[2]);
const ownedWriters = new Set();
const inside = value => {
  const actual = fs.realpathSync(value);
  assert.ok(actual.startsWith(input.root + path.sep), 'fixture path escapes isolated root');
  return actual;
};
const moduleAt = (root, relative) => import(pathToFileURL(path.join(root, relative)).href);
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
function database(owner, readonly = true) {
  const packageFile = inside(path.join(input.zylosDir, '.claude', 'skills', owner, 'package.json'));
  const require = createRequire(packageFile);
  inside(require.resolve('better-sqlite3'));
  const Database = require('better-sqlite3');
  const basename = owner === 'comm-bridge' ? 'c4.db' : owner + '.db';
  const file = inside(path.join(input.zylosDir, owner, basename));
  return {file, db:new Database(file, {fileMustExist:true, readonly})};
}
function databaseRows({seed = false, note} = {}) {
  const rows = [];
  for (const owner of ['comm-bridge', 'scheduler', 'web-console']) {
    const {file, db} = database(owner, !seed && note === undefined);
    try {
      assert.equal(db.pragma('user_version', {simple:true}), 1, 'fixture must use real owner schema 1');
      if (seed) {
        db.exec('CREATE TABLE IF NOT EXISTS target_upgrade_user_data (id INTEGER PRIMARY KEY, note TEXT, custom_column TEXT)');
        db.prepare('INSERT INTO target_upgrade_user_data (id, note, custom_column) VALUES (?, ?, ?)').run(1, owner, 'keep-user-column');
      }
      if (note !== undefined) db.prepare('UPDATE target_upgrade_user_data SET note=? WHERE id=1').run(note);
      rows.push({owner, version:db.pragma('user_version', {simple:true}),
        rows:db.prepare('SELECT id, note, custom_column FROM target_upgrade_user_data ORDER BY id').all(),
        integrity:db.pragma('integrity_check', {simple:true})});
      assert.ok(file.startsWith(input.root + path.sep));
    } finally { db.close(); }
  }
  return rows;
}
function queueRows() {
  const {file, db} = database('comm-bridge');
  try {
    return {file, rows:db.prepare('SELECT id, raw_content, content, status FROM control_queue ORDER BY id').all()};
  } finally { db.close(); }
}
function runNode(file, args = []) {
  const result = spawnSync(process.execPath, [file, ...args], {cwd:input.root, env:process.env, encoding:'utf8', timeout:120000, maxBuffer:8 * 1024 * 1024});
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}
function step(result) {
  assert.ok(result && result.status !== 'failed', result?.error || 'target step failed');
  return result;
}
function settingsChange() {
  const file = path.join(input.zylosDir, '.claude/settings.json');
  const settings = read(file);
  settings.hooks = {};
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
}
function assertDispatcherOff(m, journal) {
  const processes = m.services(journal);
  assert.equal(processes.some(item => /dispatcher|activity-monitor/.test(item.name) && item.status === 'online'), false);
  assert.ok(processes.every(item => item.script.startsWith(input.zylosDir + path.sep)));
}
function frozen(dir) {
  const require = createRequire(import.meta.url);
  return {m:require(path.join(dir, 'maintenance.cjs')), runner:require(path.join(dir, 'runner.cjs'))};
}
function resumeFrozen(dir) {
  const {m, runner} = frozen(dir);
  const j = m.transaction(input.zylosDir, dir);
  m.validateDescriptor(dir, j, m.read(path.join(dir, 'descriptor.json')));
  if (process.platform !== 'darwin') return runner.resume(dir);
  const release = m.acquire(dir);
  try { return runner.resume(dir, {ownership:release.withOwnership}); }
  finally { release(); }
}
async function liveWriter() {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), JSON.stringify({...input, mode:'writer'})], {cwd:input.root,env:process.env,detached:true,stdio:['ignore','pipe','pipe']});
  ownedWriters.add(child);
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error('isolated writer did not become ready')), 15000);
    child.once('error', error => {clearTimeout(timeout); reject(error);});
    child.once('exit', code => {clearTimeout(timeout); reject(Error('isolated writer exited before readiness: ' + code));});
    child.stdout.on('data', bytes => {if (bytes.toString().includes('writer-ready')) {clearTimeout(timeout); resolve();}});
  });
  await ready;
  return child;
}
async function stopWriter(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  process.kill(-child.pid, 'SIGKILL');
  await exited;
}
async function exerciseFailure(kind) {
  const targetRoot = inside(input.candidateDir);
  const entry = await moduleAt(targetRoot, 'cli/lib/upgrade-entry.js');
  const protection = await moduleAt(targetRoot, 'cli/lib/upgrade-protection.js');
  const m = protection.maintenance;
  const packageBefore = m.treeHash(input.installedRoot, {excludeNodeModules:false,includeModes:true});
  let captured, targetPackage, retainedRows, inodeBefore, writer;
  const states = [];
  const handoff = {schemaVersion:1,fromVersion:'0.9.3',tempDir:targetRoot,installedRoot:input.installedRoot,zylosDir:input.zylosDir};
  const result = await entry.runUpgradeEntry(handoff, {
    finalize:async ctx => {
      captured = ctx;
      assert.equal(read(path.join(ctx.coreDir,'package.json')).version, '0.9.4', 'real npm installation must precede fault injection');
      targetPackage = m.treeHash(ctx.coreDir, {excludeNodeModules:false,includeModes:true});
      const target = await moduleAt(ctx.coreDir, 'cli/lib/self-upgrade.js');
      if (kind === 'before-cutoff' || kind === 'manual') {
        step(target.step5_syncCoreSkills(ctx));
        step(target.step6_installSkillDeps(ctx));
      }
      databaseRows({note:kind + '-target-data'});
      retainedRows = databaseRows();
      inodeBefore = m.DB_PATHS.map(source => fs.statSync(path.join(ctx.zylosDir, source)).ino);
      if (kind === 'manual') {
        protection.prepareTargetData(ctx);
        protection.closeCompensation(ctx);
        states.push(m.read(path.join(ctx.transactionDir,'journal.json')));
        // Partial shared publication is real; the fault is supplied at the
        // finalizer dependency seam rather than by changing product source.
        step(target.step7_syncInstructions({...ctx,packageRoot:ctx.coreDir}));
      } else if (kind === 'descriptor') {
        fs.writeFileSync(path.join(ctx.transactionDir,'descriptor.json'), '{"damaged":true}\n');
      } else if (kind === 'snapshot') {
        const manifest = read(path.join(ctx.dbBackupDir,'manifest.json'));
        const file = manifest.databases.find(item => item.status === 'backed_up').file;
        fs.appendFileSync(path.join(ctx.dbBackupDir,file), 'damaged isolated snapshot');
      } else if (kind === 'writer') {
        writer = await liveWriter();
        const j = m.read(path.join(ctx.transactionDir,'journal.json'));
        m.update(ctx.transactionDir,j,{finalizerStarted:true,finalizerPid:writer.pid,finalizerExitConfirmed:false,finalizerExitUnconfirmed:true});
        ctx.finalizerExitUnconfirmed = true;
      }
      return {action:'self_upgrade',success:false,transactionDir:ctx.transactionDir,error:'injected finalizer boundary failure'};
    }
  });
  assert.equal(result.success, false);
  assert.ok(captured?.transactionDir);
  const dir = captured.transactionDir;
  const journal = m.read(path.join(dir,'journal.json'));
  if (kind === 'before-cutoff') {
    const restored = {packageHash:m.treeHash(input.installedRoot,{excludeNodeModules:false,includeModes:true}),
      skills:journal.coreManifest.map(item => ({name:item.name,expected:item.originalHash,
        actual:item.existedBefore ? m.treeHash(m.target(journal,item.name),{excludeNodeModules:false}) : null,
        exists:fs.existsSync(m.target(journal,item.name))})), rows:databaseRows(),journal};
    const packageProof = {before:packageBefore,after:restored.packageHash};
    // A completed restore must leave a later committed business row untouched.
    databaseRows({note:'after-restoration'});
    const laterRows = databaseRows();
    const reentry = resumeFrozen(dir);
    emit({result,restored,packageProof,reentry,laterRows,afterReentry:databaseRows()});
    return;
  }
  if (kind !== 'manual') {
    const writerActive = writer ? writer.exitCode === null && process.kill(writer.pid,0) : false;
    const report = {result,journal,expectedPackage:targetPackage,
      actualPackage:m.treeHash(input.installedRoot,{excludeNodeModules:false,includeModes:true}),retainedRows,rows:databaseRows(),
      inodeBefore,inodeAfter:m.DB_PATHS.map(source => fs.statSync(path.join(input.zylosDir,source)).ino),writerActive};
    await stopWriter(writer);
    captured.releaseControl?.();
    emit(report);
    return;
  }
  assert.equal(result.recovery_required,true);
  assert.equal(result.rollback.attempted,false);
  assert.equal(m.treeHash(input.installedRoot,{excludeNodeModules:false,includeModes:true}),targetPackage);
  assert.deepEqual(databaseRows(),retainedRows);
  const cutoff = journal.compensationCutoff;
  states.push(journal);
  const repeated = resumeFrozen(dir);
  assert.equal(repeated.recovery_required,true);
  assert.equal(repeated.attempted,false);
  const {m:fm} = frozen(dir);
  const release = fm.acquire(dir);
  let queue, failedRepair;
  try {
    const j = fm.transaction(input.zylosDir,dir);
    fm.validateDescriptor(dir,j,fm.read(path.join(dir,'descriptor.json')));
    assert.deepEqual(j.compensationCutoff,cutoff);
    assertDispatcherOff(fm,j);
    const target = await moduleAt(input.installedRoot,'cli/lib/self-upgrade.js');
    const targetProtection = await moduleAt(input.installedRoot,'cli/lib/upgrade-protection.js');
    const dbTools = await moduleAt(input.installedRoot,'cli/lib/core-db-backup.js');
    const ctx = {...captured,maintenance:fm,journal:j,tempDir:input.installedRoot,packageRoot:input.installedRoot};
    step(target.step7_syncInstructions(ctx));
    const stateFile = path.join(input.zylosDir,'memory/state.md');
    if (fs.existsSync(stateFile) && !/## Onboarding/i.test(fs.readFileSync(stateFile,'utf8'))) fs.appendFileSync(stateFile,'\n\n## Onboarding\n- Status: skipped\n');
    assert.equal((read(path.join(input.zylosDir,'.zylos/config.json')).runtime ?? 'claude'),'claude');
    const beforeQueue = queueRows();
    assert.equal(beforeQueue.rows.some(row => row.raw_content === '/exit' && ['pending','running'].includes(row.status)),false,'manual fixture must not contain unrelated pending restart work');
    settingsChange();
    const sync = path.join(input.installedRoot,'cli/lib/sync-settings-hooks.js');
    const closedOutput = runNode(sync);
    step(target.step10_ensureCodexConfig());
    const closedQueue = queueRows();
    assert.equal(closedQueue.file,path.join(input.zylosDir,'comm-bridge/c4.db'));
    // Inject an incompatible schema version only in the disposable C4 DB,
    // then perform the actual target offline check. No product source changes.
    const invalid = database('comm-bridge',false);
    invalid.db.pragma('user_version = 2');
    invalid.db.close();
    let failure;
    try { dbTools.runCoreDbWorker({action:'offline-preflight',zylosDir:input.zylosDir,schemaRoot:j.skillsDir,requireCurrent:true}); }
    catch (error) { failure = error.message; }
    assert.ok(failure, 'incompatible repaired DB must fail target verification');
    fm.update(dir,j,{phase:'recovery_required',error:failure});
    failedRepair = {error:failure,phase:j.phase,cutoff:j.compensationCutoff,
      terminal:fm.terminalValid(fm.read(path.join(dir,'journal.json'))),
      marker:fs.existsSync(path.join(input.zylosDir,'.zylos/upgrade/active.json'))};
    assert.equal(failedRepair.terminal,false);
    assert.equal(failedRepair.marker,true);
    const repaired = database('comm-bridge',false);
    repaired.db.pragma('user_version = 1');
    repaired.db.close();
    dbTools.runCoreDbWorker({action:'offline-preflight',zylosDir:input.zylosDir,schemaRoot:j.skillsDir,requireCurrent:true});
    fm.update(dir,j,{phase:'new_data_ready'});
    states.push(fm.read(path.join(dir,'journal.json')));
    assertDispatcherOff(fm,j);
    settingsChange();
    const readyOutput = runNode(sync);
    const readyQueue = queueRows();
    const previous = new Set(beforeQueue.rows.map(row => row.id));
    const closedRows = closedQueue.rows.filter(row => !previous.has(row.id));
    const allRows = readyQueue.rows.filter(row => !previous.has(row.id));
    assert.ok(allRows.length > 0, 'ready settings sync must really enqueue an isolated restart request');
    assert.ok(allRows.every(row => row.raw_content === '/exit'));
    // No Claude/model process is launched: restart only the private rehearsal
    // tmux shell while dispatcher stays off, then ack exactly this repair's IDs.
    const tmux = path.join(input.root,'tools/tmux');
    const tmuxRun = args => {
      const r=spawnSync(tmux,args,{cwd:input.root,env:process.env,encoding:'utf8',timeout:30000});assert.ifError(r.error);assert.equal(r.status,0,r.stderr);
    };
    tmuxRun(['kill-session','-t','target-upgrade-isolation']);
    tmuxRun(['new-session','-d','-s','target-upgrade-isolation']);
    const control = path.join(j.skillsDir,'comm-bridge/scripts/c4-control.js');
    for (const row of allRows.filter(row => ['pending','running'].includes(row.status))) runNode(control,['ack','--id',String(row.id)]);
    const handledQueue = queueRows();
    const handled = new Set(allRows.map(row => row.id));
    assert.ok(handledQueue.rows.filter(row => handled.has(row.id)).every(row => ['done','superseded'].includes(row.status)));
    assert.deepEqual(handledQueue.rows.filter(row => previous.has(row.id)),beforeQueue.rows);
    queue = {file:readyQueue.file,closedOutput,readyOutput,closedRows,readyRows:allRows,handledRows:handledQueue.rows.filter(row => handled.has(row.id))};
    assertDispatcherOff(fm,j);
    ctx.servicesWereRunning = j.originalServices.map(item => item.name);
    step(target.step11_startCoreServices(ctx));
    fm.verifyServices(fm.read(path.join(dir,'journal.json')));
    dbTools.runCoreDbWorker({action:'offline-preflight',zylosDir:input.zylosDir,schemaRoot:j.skillsDir,requireCurrent:true});
    assert.deepEqual(databaseRows(),retainedRows);
    const manifestTools = await moduleAt(input.installedRoot,'cli/lib/manifest.js');
    for (const baseline of ctx.pendingBaselines || []) manifestTools.saveMergeBaseline(baseline.destDir,baseline.srcDir,baseline.manifest);
    const current = fm.read(path.join(dir,'journal.json'));
    if (current.terminalServicesStopped) fm.update(dir,current,{terminalServicesStopped:false});
    targetProtection.protectedSuccess(ctx);
    states.push(fm.read(path.join(dir,'journal.json')));
    assert.ok(fm.terminalValid(states.at(-1)));
    assert.equal(states.at(-1).cleanup.complete,true);
    assert.equal(fs.existsSync(path.join(input.zylosDir,'.zylos/upgrade/active.json')),false);
  } finally { release(); }
  const finalJournal = fm.read(path.join(dir,'journal.json'));
  const discovery = fm.discover(input.zylosDir);
  const bridge = await moduleAt(input.installedRoot,'cli/lib/upgrade-bridge.js');
  const admission = bridge.resumeUnfinishedUpgrade(input.zylosDir);
  emit({result,repeated,cutoff,failedRepair,phaseWrites:states.map(j => ({phase:j.phase,cutoff:j.compensationCutoff})),queue,
    journal:finalJournal,actualVersion:read(path.join(input.installedRoot,'package.json')).version,retainedRows,rows:databaseRows(),discovery,admission});
}

if (input.mode === 'databases') {
  emit(databaseRows(input));
} else if (input.mode === 'upgrade') {
  const root = inside(input.installedRoot);
  const bridge = await moduleAt(root, 'cli/lib/upgrade-bridge.js');
  const validated = bridge.validateDownloadedCore(input.candidateDir);
  assert.equal(validated.success, true, validated.error);
  process.exitCode = bridge.runDownloadedUpgrade({tempDir:input.candidateDir,
    fromVersion:'0.9.3', installedRoot:root, zylosDir:input.zylosDir});
} else if (input.mode === 'failure') {
  try { await exerciseFailure(input.kind); }
  finally { for (const child of ownedWriters) await stopWriter(child); }
} else if (input.mode === 'writer') {
  const {db} = database('comm-bridge',false);
  db.exec('BEGIN IMMEDIATE');
  process.stdout.write('writer-ready\n');
  setInterval(() => {},1000);
  process.on('SIGTERM',() => {db.exec('ROLLBACK');db.close();process.exit(0);});
} else {
  throw Error('unsupported integration operation');
}
