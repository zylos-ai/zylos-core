import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const repository = path.resolve(import.meta.dirname, '../../../..');
const maintenance = createRequire(import.meta.url)('../../upgrade-maintenance.cjs');
const nodeBin = path.dirname(process.execPath);
const restoreCrashPreload = path.join(import.meta.dirname, 'original-package-restore-crash.js');

// Real npm and SQLite; all package, deployment, cache and process state belongs
// to this fixture. The historical source is v0.9.2 relabelled 0.9.3, not a
// claim that the unreleased historical 0.9.3 package has been exercised.
export function createProtectedPackageCrashFixture(root, {
  managedDashboard = false,
  targetBinChanged = false,
} = {}) {
  const home = path.join(root, 'home'), zylos = path.join(home, 'zylos');
  const prefix = path.join(root, 'prefix'), bin = path.join(root, 'bin');
  const core = path.join(prefix, 'lib/node_modules/zylos');
  const skills = path.join(zylos, '.claude/skills');
  const calls = path.join(root, 'commands.log'), pm2State = path.join(root, 'pm2.json');
  const env = { ...process.env, HOME: home, ZYLOS_DIR: zylos, PM2_HOME: path.join(home, '.pm2'),
    npm_config_prefix: prefix, npm_config_cache: path.join(root, 'npm-cache'),
    npm_config_audit: 'false', npm_config_fund: 'false',
    PATH: [bin, path.join(prefix, 'bin'), nodeBin, '/usr/bin', '/bin'].join(path.delimiter) };
  for (const name of ['ZYLOS_SKIP_POSTINSTALL', 'ZYLOS_PROTECTED_INSTALL', 'ZYLOS_UPGRADE_FROM_VERSION', 'CI', 'TMUX']) delete env[name];
  const write = (file, value, mode) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, value, mode ? { mode } : undefined);
  };
  const run = (command, args, options = {}) => {
    const result = spawnSync(command, args, { env, encoding: 'utf8', timeout: 600000, maxBuffer: 64 << 20, ...options });
    if (!options.allowFailure) assert.equal(result.status, 0, `${command} ${args.join(' ')}: ${result.error || result.stderr}`);
    return result;
  };
  const npm = (args, options) => run(process.execPath, [path.join(nodeBin, 'npm'), ...args], options);
  function fakes() {
    write(pm2State, JSON.stringify({ 'activity-monitor': 'online', scheduler: 'online' }));
    write(path.join(bin, 'pm2'), `#!${process.execPath}
const fs=require('node:fs'),a=process.argv.slice(2),file=${JSON.stringify(pm2State)};
fs.appendFileSync(${JSON.stringify(calls)},'pm2 '+a.join(' ')+'\\n');
const state=JSON.parse(fs.readFileSync(file));
const only=a.includes('--only')?a[a.indexOf('--only')+1]:null;
if(a[0]==='jlist')console.log(JSON.stringify(Object.entries(state).map(([name,status],i)=>({name,pid:status==='online'?100000+i:0,pm2_env:{status,pm_exec_path:${JSON.stringify(skills)}+'/'+name+'/scripts/'+name+'.js',ZYLOS_PACKAGE_ROOT:${JSON.stringify(core)}}}))));
else if(a[0]==='stop')state[a[1]]='stopped';
else if(a[0]==='restart')state[a[1]]='online';
else if(['start','startOrRestart'].includes(a[0])){if(only)state[only]='online';}
else if(a[0]==='delete')delete state[a[1]];
else if(!['save','describe','ping'].includes(a[0]))process.exit(2);
fs.writeFileSync(file,JSON.stringify(state));
`, 0o755);
    for (const [name, version] of [['claude', '2.1.0 (Claude Code)'], ['codex', 'codex-cli 0.50.0'], ['tmux', '']]) {
      write(path.join(bin, name), `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(calls)},${JSON.stringify(name)}+' '+process.argv.slice(2).join(' ')+'\\n');console.log(${JSON.stringify(version)});\n`, 0o755);
    }
  }
  function version() {
    return run(path.join(prefix, 'bin/zylos'), ['--version']).stdout.trim().split('\n').at(-1);
  }
  function journal() {
    const parent = path.join(zylos, '.backup/self-upgrade');
    if (!fs.existsSync(parent)) return [];
    return fs.readdirSync(parent).filter(name => fs.existsSync(path.join(parent, name, 'journal.json')))
      .map(name => ({ dir: path.join(parent, name), journal: maintenance.read(path.join(parent, name, 'journal.json')) }));
  }
  function logicalDatabases() {
    const script = `const fs=require('node:fs'),path=require('node:path'),D=require(${JSON.stringify(path.join(skills, 'comm-bridge/node_modules/better-sqlite3'))});
const result={};for(const rel of ${JSON.stringify(['comm-bridge/c4.db','scheduler/scheduler.db','web-console/web-console.db', ...(managedDashboard ? ['components/dashboard/dashboard.db'] : [])])}){
 const db=new D(path.join(${JSON.stringify(zylos)},rel),{readonly:true});
 const tables=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name").all();
 result[rel]={version:db.pragma('user_version',{simple:true}),integrity:db.pragma('integrity_check',{simple:true}),tables:tables.map(t=>({schema:t,rows:db.prepare('SELECT * FROM '+JSON.stringify(t.name)).all().map(r=>JSON.stringify(r)).sort()}))};db.close();
}console.log(JSON.stringify(result));`;
    return JSON.parse(run(process.execPath, ['-e', script]).stdout);
  }
  async function build() {
    fs.mkdirSync(root, { recursive: true });
    for (const name of ['memory/sessions', '.zylos', '.claude', 'pm2']) fs.mkdirSync(path.join(zylos, name), { recursive: true });
    write(path.join(zylos, '.zylos/config.json'), '{"runtime":"claude"}\n');
    write(path.join(zylos, '.claude/settings.json'), '{"hooks":{}}\n');
    write(path.join(zylos, 'memory/state.md'), 'private working state\n');
    fakes();
    const source = path.join(root, 'historical-v0.9.2-as-0.9.3');
    fs.mkdirSync(source);
    const archive = run('git', ['archive', 'v0.9.2'], { cwd: repository, encoding: null }).stdout;
    run('tar', ['-x', '-C', source], { input: archive });
    const file = path.join(source, 'package.json'), pkg = JSON.parse(fs.readFileSync(file));
    pkg.version = '0.9.3';
    write(file, JSON.stringify(pkg, null, 2));
    // Model the required 0.9.3 bridge guard explicitly; v0.9.2 lacks it.
    const postinstall = path.join(source, 'scripts/postinstall.js');
    const postinstallSource = fs.readFileSync(postinstall, 'utf8');
    const protectedGuard = "if (process.env.ZYLOS_PROTECTED_INSTALL === '1') process.exit(0);\n";
    const firstLine = postinstallSource.startsWith('#!') ? postinstallSource.indexOf('\n') + 1 : 0;
    write(postinstall, postinstallSource.slice(0, firstLine) + protectedGuard + postinstallSource.slice(firstLine));
    const packs = path.join(root, 'packs'); fs.mkdirSync(packs);
    npm(['pack', '--ignore-scripts', '--pack-destination', packs], { cwd: source });
    npm(['install', '-g', path.join(packs, 'zylos-0.9.3.tgz')]);
    fs.copyFileSync(path.join(core, 'templates/pm2/ecosystem.config.cjs'), path.join(zylos, 'pm2/ecosystem.config.cjs'));
    for (const name of fs.readdirSync(skills)) {
      const file = path.join(skills, name, 'package.json');
      if (fs.existsSync(file) && Object.keys(JSON.parse(fs.readFileSync(file)).dependencies || {}).length) npm(['install', '--omit=dev'], { cwd: path.dirname(file) });
    }
    const init = `const s=await import(${JSON.stringify(pathToFileURL(path.join(skills, 'comm-bridge/scripts/sqlite-schema.js')).href)});
const D=(await import('node:module')).createRequire(${JSON.stringify(path.join(skills, 'comm-bridge/package.json'))})('better-sqlite3');
for(const [rel,owner]of [['comm-bridge/c4.db','comm-bridge/scripts/c4-schema.js'],['scheduler/scheduler.db','scheduler/scripts/schema.js'],['web-console/web-console.db','web-console/scripts/schema.js']]){
 const f=${JSON.stringify(zylos)}+'/'+rel;const fs=await import('node:fs');fs.mkdirSync((await import('node:path')).dirname(f),{recursive:true});
 const db=new D(f);s.migrateDatabase(db,await import(${JSON.stringify(pathToFileURL(skills + '/').href)}+owner),{allowNew:true,strict:false});db.close();
}
 const db=new D(${JSON.stringify(path.join(zylos, 'comm-bridge/c4.db'))});db.prepare('INSERT INTO checkpoints(id,summary) VALUES (?,?)').run(17,'durable business row');db.close();`;
    run(process.execPath, ['--input-type=module', '-e', init]);
    if (managedDashboard) {
      assert.equal(fs.existsSync(path.join(core, 'skills/dashboard')), false);
      assert.equal(fs.existsSync(path.join(skills, 'dashboard')), false);
      const database = path.join(zylos, 'components/dashboard/dashboard.db');
      fs.mkdirSync(path.dirname(database), { recursive: true });
      run(process.execPath, ['-e', `const D=require(${JSON.stringify(path.join(skills, 'comm-bridge/node_modules/better-sqlite3'))});const db=new D(${JSON.stringify(database)});db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY);INSERT INTO schema_migrations VALUES (20);CREATE TABLE events(value TEXT);INSERT INTO events VALUES ('preserved Dashboard row')");db.close();`]);
    }
    assert.equal(version(), '0.9.3');
    const target = path.join(root, 'target');
    fs.cpSync(repository, target, { recursive: true, verbatimSymlinks: true, filter: file => {
      const parts = path.relative(repository, file).split(path.sep);
      return !parts.some(part => ['.git', 'node_modules', '__tests__', 'test'].includes(part));
    } });
    const targetPkg = JSON.parse(fs.readFileSync(path.join(target, 'package.json')));
    targetPkg.version = '1.0.0';
    if (targetBinChanged) {
      fs.copyFileSync(path.join(target, 'cli/zylos.js'), path.join(target, 'cli/target-zylos.js'));
      targetPkg.bin = {zylos:'./cli/target-zylos.js', 'target-only':'./cli/target-zylos.js'};
    }
    write(path.join(target, 'package.json'), JSON.stringify(targetPkg, null, 2));
    if (managedDashboard) {
      write(path.join(target, 'skills/dashboard/package.json'), '{"name":"fixture-dashboard","type":"module"}\n');
      // The target supplies the new owner; the original package and deployed
      // skills deliberately have none. The worker provides a native SQLite handle.
      write(path.join(target, 'skills/dashboard/src/lib/schema-owner.js'), `export const dashboardSchemaOwner={
 inspectSchema(db){const currentVersion=db.prepare('SELECT MAX(version) AS n FROM schema_migrations').get().n;db.prepare('SELECT value FROM events').all();return {currentVersion,targetVersion:21,needsMigration:currentVersion!==21};},
 migrate(db){db.prepare('INSERT OR IGNORE INTO schema_migrations VALUES (?)').run(21);}
};\n`);
    }
    return { source, target };
  }
  function handoff(target, name) {
    const tempDir = path.join(root, name);
    fs.cpSync(target, tempDir, { recursive: true, verbatimSymlinks: true });
    return { schemaVersion: 1, fromVersion: '0.9.3', tempDir, installedRoot: core, zylosDir: zylos };
  }
  function failedEntryArgs(input) {
    const module = pathToFileURL(path.join(input.tempDir, 'cli/lib/upgrade-entry.js')).href;
    return ['--input-type=module', '-e', `import fs from 'node:fs';const {runUpgradeEntry,installUpgradeTarget}=await import(${JSON.stringify(module)});const input=JSON.parse(fs.readFileSync(0,'utf8'));const result=await runUpgradeEntry(input,{install(ctx){installUpgradeTarget(ctx);throw Error('injected post-install failure');}});console.log(JSON.stringify(result));process.exitCode=result.success?0:1;`];
  }
  function entry(input, { failureStage } = {}) {
    const module = pathToFileURL(path.join(input.tempDir, 'cli/lib/upgrade-entry.js')).href;
    const args = failureStage === 'after' ? failedEntryArgs(input) : failureStage
      ? ['--input-type=module', '-e', `import fs from 'node:fs';const {runUpgradeEntry}=await import(${JSON.stringify(module)});const input=JSON.parse(fs.readFileSync(0,'utf8'));const result=await runUpgradeEntry(input,{install(){throw Error('injected pre-install failure');}});console.log(JSON.stringify(result));process.exitCode=result.success?0:1;`]
      : [path.join(input.tempDir, 'cli/lib/upgrade-entry.js')];
    const result = run(process.execPath, args, { input: JSON.stringify(input), allowFailure: true, timeout: 900000 });
    assert.ok(result.stdout.trim(), result.stderr);
    return { status: result.status, result: JSON.parse(result.stdout.trim().split('\n').at(-1)) };
  }
  async function kill(input, stage) {
    const child = spawn(process.execPath, [path.join(input.tempDir, 'cli/lib/upgrade-entry.js')], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => { stdout += bytes; });
    child.stderr.on('data', bytes => { stderr += bytes; });
    child.stdin.end(JSON.stringify(input));
    const deadline = Date.now() + 300000;
    let observed;
    try {
      while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
        const current = journal().find(({ journal: j }) => !['restored_complete', 'upgrade_complete', 'aborted_before_install'].includes(j.phase));
        if (current && (stage === 'before' ? current.journal.phase === 'prepared' :
          current.journal.installationIntent === true && current.journal.installerStage === 'install' && current.journal.installerExitConfirmed === true)) {
          observed = current; break;
        }
        await new Promise(resolve => setTimeout(resolve, 2));
      }
      assert.ok(observed, `Crash boundary ${stage} never observed: ${stdout} ${stderr}`);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      const result = await exited;
      if (observed) assert.equal(result.signal, 'SIGKILL');
    }
    return observed;
  }
  async function killDuringRestore(input, boundary) {
    const marker = path.join(root, `restore-crash-${boundary}.txt`);
    const childEnv = {
      ...env,
      ZYLOS_TEST_RESTORE_CRASH_BOUNDARY: boundary,
      ZYLOS_TEST_RESTORE_INSTALLED_ROOT: core,
      ZYLOS_TEST_RESTORE_BIN_DIR: path.join(prefix, 'bin'),
      ZYLOS_TEST_RESTORE_CRASH_MARKER: marker,
      NODE_OPTIONS: `--import=${pathToFileURL(restoreCrashPreload).href}`,
    };
    const child = spawn(process.execPath, failedEntryArgs(input), {
      env: childEnv, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => { stdout += bytes; });
    child.stderr.on('data', bytes => { stderr += bytes; });
    child.stdin.end(JSON.stringify(input));
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 300000);
    const result = await exited;
    clearTimeout(timer);
    assert.equal(timedOut, false, `Restore boundary ${boundary} timed out: ${stdout} ${stderr}`);
    assert.ok(result.signal === 'SIGKILL' || result.code !== 0, `Restore boundary ${boundary} exited unexpectedly: ${stdout} ${stderr}`);
    assert.equal(fs.readFileSync(marker, 'utf8'), `${boundary}\n`);
    const observed = journal().find(({journal: current}) => current.installationIntent === true &&
      !['restored_complete', 'upgrade_complete', 'aborted_before_install'].includes(current.phase));
    assert.ok(observed?.journal.originalPackage, `Restore boundary ${boundary} left no active transaction`);
    return observed;
  }
  function recover(from) {
    const script = `const {recoverBeforeUpgrade}=await import(${JSON.stringify(pathToFileURL(path.join(from, 'cli/lib/upgrade-discovery.js')).href)});console.log(JSON.stringify(recoverBeforeUpgrade(${JSON.stringify(zylos)})));`;
    const result = run(process.execPath, ['--input-type=module', '-e', script]);
    return JSON.parse(result.stdout.trim().split('\n').at(-1));
  }
  const installedTreeHash = () => maintenance.treeHash(core, {excludeNodeModules:false, includeModes:true});
  const serviceState = () => JSON.parse(fs.readFileSync(pm2State, 'utf8'));
  const commandCalls = () => fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean) : [];
  const binTarget = name => {
    const link = path.join(prefix, 'bin', name);
    return path.resolve(path.dirname(link), fs.readlinkSync(link));
  };
  return { build, handoff, entry, kill, killDuringRestore, recover, journal, logicalDatabases,
    installedTreeHash, binTarget, serviceState, commandCalls, version, core, zylos, root, calls, skills };
}
