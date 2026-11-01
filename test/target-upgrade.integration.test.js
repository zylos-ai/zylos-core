import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync, execFileSync} from 'node:child_process';
import {afterEach, describe, expect, test} from '@jest/globals';

/*
 * Real installation test; never enable in an ordinary test run.
 * Run when target entry, protected npm installation, database preservation or
 * finalization changes. Skip for unrelated changes and until the reviewer has
 * confirmed the actual fixture root, ports and executable paths.
 *
 * Preparation is deliberately outside this test: make a disposable, reviewed
 * standard global 0.9.3 installation with all three real schema-1 owner DBs,
 * deployed skill dependencies, and only the real web-console service online.
 * Keep dispatcher, activity-monitor, external channels and model calls off.
 * Prepare a candidate source copy at <root>/t/candidate with version 0.9.4;
 * do not change the repository version. The legacy case uses the real public
 * fixed-bridge route; candidate cases
 * use the real installed bridge handoff and do not claim public candidate
 * distribution coverage. All stateful installation/finalization calls are real.
 *
 * Set ZYLOS_TARGET_UPGRADE_INTEGRATION=1 and ZYLOS_TARGET_UPGRADE_FIXTURE to a
 * JSON catalog below an OS temporary directory:
 * {fixtures:{success:config, legacy:config, installer:config, beforeCutoff:config, manual:config,
 *  descriptor:config, snapshot:config, writer:config}}. Each config is
 * {root,nodePath,npmCliPath,tmuxBinary,nodeVersion,npmVersion,pm2Version,
 *  webConsolePort}, with a distinct root and port. The legacy fixture starts
 * at 0.9.2; all others start at 0.9.3. The manual fixture uses runtime=claude
 * and has no unrelated pending /exit controls. All values must be the actual
 * reviewer-approved values.
 * npm/pm2 must already be installed/prepared; this test does not prepare them.
 * The root layout is h/zylos, pm2, p, t, tmux, tools, npm-cache, npmrc.
 * All test child processes get a fresh environment and use a private tmux -S
 * wrapper. The test stops only these isolated PM2/tmux daemons at its end;
 * fixture files and logs stay under the root for evidence and explicit cleanup.
 */
const enabled = process.env.ZYLOS_TARGET_UPGRADE_INTEGRATION === '1';
const suite = enabled ? describe : describe.skip;
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const helper = path.join(repo, 'test/helpers/run-installed-target-upgrade.mjs');
const bridgeSha = '6655a3814f5efa0fe0675865721f06dee6b32202';
let root, fixture, env, installedRoot, zylosDir, candidateDir, socket, pm2, canStop = false;
const usedRoots = new Set();
const usedPorts = new Set();

function inside(file, {exists = true} = {}) {
  const absolute = path.resolve(file);
  expect(absolute.startsWith(root + path.sep)).toBe(true);
  if (exists) expect(fs.realpathSync(absolute)).toBe(absolute);
  return absolute;
}
function read(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function run(binary, args, {timeout = 60000} = {}) {
  const result = spawnSync(binary, args, {cwd:root, env, encoding:'utf8', timeout, maxBuffer:8 * 1024 * 1024});
  if (result.error || result.status !== 0) throw Error(`${path.basename(binary)} failed (${result.status}): ${result.error?.message || result.stderr || result.stdout}`);
  return result.stdout.trim();
}
function pm2List() {
  const output = run(pm2, ['jlist']);
  const start = output.search(/(?:^|\n)\s*\[(?:\s*\{|\s*\])/);
  expect(start).toBeGreaterThanOrEqual(0);
  const list = JSON.parse(output.slice(start));
  for (const item of list) {
    inside(item.pm2_env.pm_exec_path);
    inside(item.pm2_env.pm_cwd);
    expect(item.name).toBe('web-console');
    expect(item.pm2_env.HOME).toBe(env.HOME);
    expect(item.pm2_env.ZYLOS_DIR).toBe(zylosDir);
    expect(String(item.pm2_env.WEB_CONSOLE_PORT)).toBe(String(fixture.webConsolePort));
    expect(item.pm2_env.WEB_CONSOLE_BIND).toBe('127.0.0.1');
  }
  return list;
}
function nodeOperation(input, timeout = 60000) {
  const result = spawnSync(fixture.nodePath, [helper, JSON.stringify({root,zylosDir,...input})],
    {cwd:root, env, encoding:'utf8', timeout, maxBuffer:8 * 1024 * 1024});
  fs.writeFileSync(path.join(root, 'evidence', `${input.mode}.stdout.log`), result.stdout || '');
  fs.writeFileSync(path.join(root, 'evidence', `${input.mode}.stderr.log`), result.stderr || '');
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout.trim().split('\n').at(-1));
}
function toolLink(name, target) {
  const file = path.join(root, 'tools', name);
  if (!fs.existsSync(file)) fs.symlinkSync(target, file);
  expect(fs.realpathSync(file)).toBe(fs.realpathSync(target));
}

function admitFixture(key) {
  canStop = false;
  const manifest = process.env.ZYLOS_TARGET_UPGRADE_FIXTURE;
  expect(path.isAbsolute(manifest || '')).toBe(true);
  const catalog = read(manifest);
  fixture = catalog.fixtures?.[key];
  expect(fixture).toBeDefined();
  root = fs.realpathSync(fixture.root);
  expect(root).toBe(path.resolve(fixture.root));
  const tempRoots = [fs.realpathSync(os.tmpdir()), fs.realpathSync('/tmp')];
  expect(tempRoots.some(base => root.startsWith(base + path.sep))).toBe(true);
  expect(path.basename(root)).toMatch(/^cotu-[A-Za-z0-9_-]+$/);
  expect(root.length).toBeLessThan(80);
  expect(fs.realpathSync(manifest)).toBe(path.resolve(manifest));
  expect(tempRoots.some(base => manifest.startsWith(base + path.sep))).toBe(true);
  expect(usedRoots.has(root)).toBe(false);
  usedRoots.add(root);
  zylosDir = inside(path.join(root, 'h/zylos'));
  candidateDir = key === 'legacy' ? null : inside(path.join(root, 't/candidate'));
  installedRoot = inside(path.join(root, 'p/lib/node_modules/zylos'));
  for (const dir of ['h','pm2','p','t','tmux','tools','npm-cache']) inside(path.join(root, dir));
  inside(path.join(root, 'npmrc'));
  const globalConfig = path.join(root, 'npm-globalrc');
  if (!fs.existsSync(globalConfig)) fs.writeFileSync(globalConfig, '', {mode:0o600,flag:'wx'});
  inside(globalConfig);
  expect(fs.realpathSync(fixture.nodePath)).toBe(fixture.nodePath);
  expect(path.basename(fs.realpathSync(fixture.npmCliPath))).toBe('npm-cli.js');
  expect(path.basename(fs.realpathSync(fixture.tmuxBinary))).toBe('tmux');
  expect(Number.isInteger(fixture.webConsolePort)).toBe(true);
  expect(fixture.webConsolePort).toBeGreaterThanOrEqual(1024);
  expect(fixture.webConsolePort).toBeLessThanOrEqual(65535);
  expect(usedPorts.has(fixture.webConsolePort)).toBe(false);
  usedPorts.add(fixture.webConsolePort);
  socket = path.join(root, 'tmux/control.sock');
  env = {HOME:path.join(root,'h'), ZYLOS_DIR:zylosDir, PM2_HOME:path.join(root,'pm2'),
    TMPDIR:path.join(root,'t'), TMUX_TMPDIR:path.join(root,'tmux'),
    XDG_CONFIG_HOME:path.join(root,'h/.config'), CODEX_HOME:path.join(root,'h/.codex'),
    NPM_CONFIG_PREFIX:path.join(root,'p'), NPM_CONFIG_CACHE:path.join(root,'npm-cache'),
    NPM_CONFIG_USERCONFIG:path.join(root,'npmrc'), NPM_CONFIG_GLOBALCONFIG:path.join(root,'npm-globalrc'),
    PATH:[path.join(root,'p/bin'),path.join(root,'tools'),'/usr/bin','/bin'].join(path.delimiter),
    WEB_CONSOLE_PORT:String(fixture.webConsolePort), WEB_CONSOLE_BIND:'127.0.0.1',
    LANG:'en_US.UTF-8', TZ:'UTC'};
  toolLink('node', fixture.nodePath);
  toolLink('npm', fixture.npmCliPath);
  // A real tmux executable receives -S for every call, including product calls.
  const wrapper = path.join(root, 'tools/tmux');
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const body = `#!/bin/sh\nprintf '%s\\n' ${quote(socket)} >> ${quote(path.join(root,'tmux/calls.log'))}\nexec ${quote(fixture.tmuxBinary)} -S ${quote(socket)} "$@"\n`;
  if (!fs.existsSync(wrapper)) fs.writeFileSync(wrapper, body, {mode:0o700, flag:'wx'});
  expect(fs.readFileSync(wrapper, 'utf8')).toBe(body);
  expect(run(fixture.nodePath, ['--version'])).toBe(fixture.nodeVersion);
  expect(run(fixture.nodePath, [fixture.npmCliPath, '--version'])).toBe(fixture.npmVersion);
  pm2 = path.join(root, 'p/bin/pm2');
  inside(fs.realpathSync(pm2));
  expect(read(path.join(root,'p/lib/node_modules/pm2/package.json')).version).toBe(fixture.pm2Version);
  expect(read(path.join(installedRoot,'package.json')).version).toBe(key === 'legacy' ? '0.9.2' : '0.9.3');
  if (candidateDir) expect(read(path.join(candidateDir,'package.json')).version).toBe('0.9.4');
  const ref = key === 'legacy' ? 'v0.9.2' : bridgeSha;
  const files = key === 'legacy'
    ? ['cli/commands/component.js','cli/lib/self-upgrade.js','cli/lib/core-db-backup-worker.js']
    : ['cli/lib/upgrade-bridge.js','cli/lib/self-upgrade-finalize.js','cli/lib/core-db-backup-worker.js'];
  for (const relative of files) {
    const exact = execFileSync('/usr/bin/git', ['show', `${ref}:${relative}`], {cwd:repo, env:{PATH:'/usr/bin:/bin'}, encoding:'utf8'});
    expect(fs.readFileSync(path.join(installedRoot,relative),'utf8')).toBe(exact);
  }
  const processes = pm2List();
  for (const name of ['pub.sock','rpc.sock']) inside(path.join(root,'pm2',name));
  canStop = true;
  expect(processes.filter(item => item.pm2_env.status === 'online').map(item => item.name)).toEqual(['web-console']);
  run(wrapper, ['new-session','-d','-s','target-upgrade-isolation']);
  expect(run(wrapper, ['display-message','-p','#{socket_path}'])).toBe(socket);
  expect(fs.readFileSync(path.join(root,'tmux/calls.log'),'utf8').split('\n').filter(Boolean).every(value => value === socket)).toBe(true);
  fs.mkdirSync(path.join(root,'evidence'), {recursive:true,mode:0o700});
}

suite('real target-owned global installation', () => {
  afterEach(() => {
    if (!canStop) return;
    // These commands are bound to the admitted private daemon and socket.
    const stopped = spawnSync(pm2, ['kill'], {cwd:root, env, encoding:'utf8', timeout:30000});
    expect(stopped.error).toBeUndefined();
    expect(stopped.status).toBe(0);
    const tmux = spawnSync(path.join(root,'tools/tmux'), ['kill-server'], {cwd:root, env, encoding:'utf8', timeout:30000});
    expect(tmux.error).toBeUndefined();
    expect(tmux.status === 0 || /no server running|no such file/i.test(tmux.stderr || '')).toBe(true);
  });

  // Coverage: installed 0.9.3 handoff, real npm replacement/finalizer, three
  // owner DBs, custom data/config and original service/terminal preservation.
  // Run for changes to these boundaries; skip absent reviewed disposable fixture.
  test('installs the candidate and retains owner data, configuration and original services', () => {
    admitFixture('success');
    const before = nodeOperation({mode:'databases',seed:true});
    const settingsFile = path.join(zylosDir,'.claude/settings.json');
    const settings = read(settingsFile);
    settings.targetUpgradeFixture = {preserve:true};
    fs.writeFileSync(settingsFile, JSON.stringify(settings,null,2) + '\n');
    const result = nodeOperation({mode:'upgrade',installedRoot,candidateDir}, 480000);
    expect(result.success).toBe(true);
    expect(result.from).toBe('0.9.3');
    expect(result.to).toBe('0.9.4');
    expect(read(path.join(installedRoot,'package.json')).version).toBe('0.9.4');
    expect(nodeOperation({mode:'databases'})).toEqual(before);
    expect(read(settingsFile).targetUpgradeFixture).toEqual({preserve:true});
    expect(pm2List().filter(item => item.pm2_env.status === 'online').map(item => item.name)).toEqual(['web-console']);
    const journal = read(path.join(result.transactionDir,'journal.json'));
    expect(journal.targetOwned).toBe(true);
    expect(journal.phase).toBe('upgrade_complete');
    expect(journal.cleanup.complete).toBe(true);
    expect(journal.cleanup.servicesRestored).toBe(true);
    expect(journal.terminalEvidence).toEqual({verified:true,kind:'code_data_services'});
    expect(journal.compensationCutoff).toMatchObject({closed:true,transactionId:journal.transactionId,from:'0.9.3',to:'0.9.4'});
    expect(fs.existsSync(path.join(zylosDir,'.zylos/upgrade/active.json'))).toBe(false);
    // No active dispatcher or activity-monitor may consume queued restart work.
    expect(pm2List().some(item => /dispatcher|activity-monitor/.test(item.name))).toBe(false);
  }, 600000);
  // Coverage: the actual old CLI and fixed public bridge distribution/install.
  // Run when old-source admission, bridge guidance or handoff changes. Skip
  // absent a separately reviewed legacy fixture and explicit network/install gate.
  test('upgrades a real 0.9.2 installation through the fixed 0.9.3 bridge', () => {
    admitFixture('legacy');
    const before = nodeOperation({mode:'databases',seed:true});
    const settingsFile = path.join(zylosDir,'.claude/settings.json');
    const settings = read(settingsFile);
    settings.targetUpgradeFixture = {preserve:true};
    fs.writeFileSync(settingsFile,JSON.stringify(settings,null,2) + '\n');
    const output = run(fixture.nodePath,[path.join(installedRoot,'cli/zylos.js'),'upgrade','--self','--branch','release/0.9.3','--yes','--json'],{timeout:480000});
    fs.writeFileSync(path.join(root,'evidence','legacy-upgrade.stdout.log'),output);
    expect(read(path.join(installedRoot,'package.json')).version).toBe('0.9.3');
    for (const relative of ['cli/lib/upgrade-bridge.js','cli/lib/self-upgrade-finalize.js','cli/lib/core-db-backup-worker.js']) {
      const exact=execFileSync('/usr/bin/git',['show',`${bridgeSha}:${relative}`],{cwd:repo,env:{PATH:'/usr/bin:/bin'},encoding:'utf8'});
      expect(fs.readFileSync(path.join(installedRoot,relative),'utf8')).toBe(exact);
    }
    expect(nodeOperation({mode:'databases'})).toEqual(before);
    expect(read(settingsFile).targetUpgradeFixture).toEqual({preserve:true});
    expect(pm2List().filter(item => item.pm2_env.status === 'online').map(item => item.name)).toEqual(['web-console']);
    expect(fs.existsSync(path.join(zylosDir,'.zylos/upgrade/active.json'))).toBe(false);
    const transactions=fs.readdirSync(path.join(zylosDir,'.backup/self-upgrade')).map(id => read(path.join(zylosDir,'.backup/self-upgrade',id,'journal.json')));
    expect(transactions.some(j => j.from === '0.9.2' && j.to === '0.9.3' && j.phase === 'upgrade_complete' && j.cleanup.complete)).toBe(true);
  },600000);

  // Coverage: real npm pack, durable installation intent, and a real npm
  // install command failing on a missing archive, followed by frozen restore.
  // Run for installer failure/recovery changes; skip without isolated fixture.
  test('compensates after the real npm installer rejects an unavailable archive', () => {
    admitFixture('installer');
    const before=nodeOperation({mode:'databases',seed:true});
    const report=nodeOperation({mode:'failure',kind:'installer',installedRoot,candidateDir},480000);
    expect(report.installerFailed).toBe(true);
    expect(report.finalizerCalled).toBe(false);
    expect(report.result.success).toBe(false);
    expect(report.result.recovery_required).toBe(false);
    expect(report.restored.journal.installationIntent).toBe(true);
    expect(report.restored.journal.installerStage).toBe('install');
    expect(report.packageProof.after).toBe(report.packageProof.before);
    expect(report.restored.rows).toEqual(before);
    for (const skill of report.restored.skills) {
      expect(skill.actual).toBe(skill.expected);
      expect(skill.exists).toBe(skill.expected !== null);
    }
    expect(report.restored.journal.phase).toBe('restored_complete');
    expect(report.reentry.recovery_required).toBe(false);
    expect(report.afterReentry).toEqual(report.laterRows);
    expect(read(path.join(installedRoot,'package.json')).version).toBe('0.9.3');
    expect(pm2List().filter(item => item.pm2_env.status === 'online').map(item => item.name)).toEqual(['web-console']);
  },600000);

  // Coverage: actual npm install and target skill/dependency synchronization,
  // then a pre-cutoff finalizer fault and real frozen compensation/reentry.
  // Run for package/skill/DB restoration changes; skip without isolated fixture.
  test('restores the full original package, dependencies and databases before the cutoff', () => {
    admitFixture('beforeCutoff');
    const before=nodeOperation({mode:'databases',seed:true});
    const report=nodeOperation({mode:'failure',kind:'before-cutoff',installedRoot,candidateDir},480000);
    expect(report.result.success).toBe(false);
    expect(report.result.recovery_required).toBe(false);
    expect(report.packageProof.after).toBe(report.packageProof.before);
    expect(report.restored.rows).toEqual(before);
    for (const skill of report.restored.skills) {
      expect(skill.actual).toBe(skill.expected);
      expect(skill.exists).toBe(skill.expected !== null);
    }
    expect(report.restored.journal.phase).toBe('restored_complete');
    expect(report.reentry.recovery_required).toBe(false);
    expect(report.afterReentry).toEqual(report.laterRows);
    expect(read(path.join(installedRoot,'package.json')).version).toBe('0.9.3');
    expect(pm2List().filter(item => item.pm2_env.status === 'online').map(item => item.name)).toEqual(['web-console']);
  },600000);

  // Coverage: real post-cutoff parent/frozen refusal, failed manual validation,
  // manual shared publication/readiness/services/success cleanup and next
  // admission. Phase rewrites retain cutoff exactly; actual settings-sync queue
  // effects are observed in private C4 while dispatcher remains stopped.
  // Run for cutoff/manual-close/settings-sync changes; skip absent reviewed fixture.
  test('manually completes the target after a closed-cutoff failure without restoring old data', () => {
    admitFixture('manual');
    nodeOperation({mode:'databases',seed:true});
    const report=nodeOperation({mode:'failure',kind:'manual',installedRoot,candidateDir},480000);
    expect(report.result.recovery_required).toBe(true);
    expect(report.result.rollback.attempted).toBe(false);
    expect(report.repeated.recovery_required).toBe(true);
    expect(report.repeated.attempted).toBe(false);
    expect(report.phaseWrites.map(item => item.phase)).toEqual(['compensation_closed','recovery_required','new_data_ready','upgrade_complete']);
    for (const state of report.phaseWrites) expect(state.cutoff).toEqual(report.cutoff);
    expect(report.failedRepair).toMatchObject({phase:'recovery_required',terminal:false,marker:true,cutoff:report.cutoff});
    expect(report.rows).toEqual(report.retainedRows);
    expect(report.queue.file).toBe(path.join(zylosDir,'comm-bridge/c4.db'));
    expect(report.queue.readyRows.length).toBeGreaterThan(0);
    expect(report.queue.readyRows.every(row => row.raw_content === '/exit')).toBe(true);
    expect(report.queue.handledRows.every(row => ['done','superseded'].includes(row.status))).toBe(true);
    expect(report.actualVersion).toBe('0.9.4');
    expect(report.journal.phase).toBe('upgrade_complete');
    expect(report.journal.cleanup.complete).toBe(true);
    expect(report.discovery.candidates).toEqual([]);
    expect(report.discovery.diagnostics).toEqual([]);
    expect(report.admission.success).toBe(true);
    expect(pm2List().filter(item => item.pm2_env.status === 'online').map(item => item.name)).toEqual(['web-console']);
    expect(fs.existsSync(path.join(zylosDir,'.zylos/upgrade/active.json'))).toBe(false);
  },600000);

  // Coverage: real installed target plus frozen restoration's material/exit
  // refusal. Each destructive scenario has its own independent root. Run for
  // descriptor/snapshot/process gates; skip absent those reviewed fixtures.
  test.each(['descriptor','snapshot','writer'])('refuses unsafe restoration with %s evidence', kind => {
    admitFixture(kind);
    nodeOperation({mode:'databases',seed:true});
    const report=nodeOperation({mode:'failure',kind,installedRoot,candidateDir},480000);
    expect(report.result.success).toBe(false);
    expect(report.result.recovery_required).toBe(true);
    expect(report.actualPackage).toBe(report.expectedPackage);
    expect(report.rows).toEqual(report.retainedRows);
    expect(report.inodeAfter).toEqual(report.inodeBefore);
    if (kind === 'writer') expect(report.writerActive).toBe(true);
    expect(read(path.join(installedRoot,'package.json')).version).toBe('0.9.4');
    expect(fs.existsSync(path.join(zylosDir,'.zylos/upgrade/active.json'))).toBe(true);
    expect(pm2List().some(item => /dispatcher|activity-monitor/.test(item.name))).toBe(false);
  },600000);

});
