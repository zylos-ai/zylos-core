import { isolatedTmux } from '../../../test/helpers/isolated-tmux.js';
import { seedCodexTrustFixture, codexAppServerFixtureSource } from '../../../test/helpers/codex-trust.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { ClaudeAdapter } from '../runtime/claude.js';
import { CodexAdapter } from '../runtime/codex.js';
import { deployManifestTemplate } from '../runtime/tmux-env.js';
import { tmuxNameForGroup } from '../session-group-paths.js';

// Frozen SessionAdapter API integration. Only the model CLI is a stand-in;
// paths, target observation, command/env/script construction and tmux settlement
// are production code. No child_process mock: spawn must really be exported.
// Uses a stand-in runtime self-report and real tmux; does not validate real model/auth.
// Retired assertions: JSON/Node launcher, -E/-e PATH transport, existing-session
// sendMessage reuse, launch-time instruction migration and persistent permission
// writes. They are not requirements of launch({sessionGroup,runId,launchConfig,
// sessionMode}); same-name reuse must now fail with NAME_CONFLICT.
const binary = process.env.TEST_TMUX_BIN || 'tmux';
const sentinel = 'System startup trigger, not a user message. Continue with startup context.';
const secret = 'sk-ant-synthetic-launch-test';
const maintenance = createRequire(import.meta.url)('../upgrade-maintenance.cjs');

function setup(t, Cls, { help = ' --model MODEL --effort EFFORT --no-daemon ', helpFails = false, nativeAuth = false } = {}) {
  const {dir,socketPath,tmux}=isolatedTmux(t,{prefix:'runtime-launch-',socketName:'socket',trim:false});
  const root = path.join(dir, "root with ' quote");
  const home = path.join(dir, 'home');
  const pm2Home = path.join(dir, 'pm2');
  const tmpdir = path.join(dir, 'tmp');
  fs.mkdirSync(root); fs.mkdirSync(home); fs.mkdirSync(pm2Home); fs.mkdirSync(tmpdir);
  if (Cls === CodexAdapter) seedCodexTrustFixture({ root, home });
  const command = path.join(dir, "runtime with ' quote");
  const helpLog = path.join(dir, 'help-log');
  const report = path.join(dir, 'runtime-report.json');
  fs.writeFileSync(command, `#!${process.execPath}\nconst fs = require('node:fs');\n${codexAppServerFixtureSource()}\nif (process.argv.includes('--version')) { console.log('codex-fixture'); process.exit(0); } else if (process.argv[2] === 'app-server') { process.exit(2); } else if (process.argv.includes('--help')) { fs.appendFileSync(${JSON.stringify(helpLog)}, 'help\\n'); ${helpFails ? 'process.exit(2);' : `console.log(${JSON.stringify(help)});`} } else if (process.argv[2] === 'auth' && process.argv[3] === 'status') { console.log(JSON.stringify({ loggedIn: ${nativeAuth}, authMethod: 'claude.ai' })); } else { fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify({pid:process.pid,args:process.argv,env:process.env,cwd:process.cwd(),exe:fs.realpathSync(process.execPath)})); setInterval(() => {}, 1000); }\n`, { mode: 0o700 });
  fs.writeFileSync(path.join(root, '.env'), `ANTHROPIC_API_KEY=${secret}\n`);
  const env = { HOME: home, PM2_HOME: pm2Home, TMPDIR: tmpdir, ZYLOS_DIR: root,
    PATH: process.env.PATH, USER: process.env.USER || 'test',
    CLAUDE_BIN: command, CODEX_BIN: command, CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli',
    ZYLOS_SESSION_GROUP: 'stale-group', ZYLOS_RUN_ID: 'stale-run', ZYLOS_MODEL_CONFIG: 'stale-config' };
  const adapter = new Cls({ root, env, tmux: { binary, socketPath, configFile: '/dev/null' } });
  const runtime = adapter.runtimeId;
  const input = { sessionGroup: null, runId: 'fresh-run', sessionMode: 'single', launchConfig: { runtime, mode: 'default' } };
  async function launch(changes = {}) {
    const request = { ...input, ...changes };
    fs.rmSync(report, { force: true });
    const result = await adapter.launch(request);
    const pid = tmux('list-panes', '-t', result.tmuxName, '-F', '#{pane_pid}').trim();
    let observed;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { observed = JSON.parse(fs.readFileSync(report, 'utf8')); break; } catch {}
      await delay(10);
    }
    assert.ok(observed, 'launched runtime must publish its observation');
    assert.equal(observed.pid, Number(pid), 'self-report must come from the target pane process');
    return { result, ...observed, pid };
  }
  return { root, home, command, env, adapter, input, launch, tmux, helpLog };
}

function publishStartupRecovery(root, { succeed = false, controller = false } = {}) {
  const dir = path.join(root, '.backup/self-upgrade/tx');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const executed = path.join(root, 'recovery-executed');
  for (const [source, name] of [
    ['upgrade-maintenance.cjs', 'maintenance.cjs'],
    ['upgrade-installer.cjs', 'installer.cjs'],
    ['upgrade-bootstrap.cjs', 'bootstrap.cjs'],
    ['upgrade-recovery.cjs', 'recovery.cjs'],
  ]) {
    fs.copyFileSync(path.resolve('cli/lib', source), path.join(dir, name));
    fs.chmodSync(path.join(dir, name), 0o600);
  }
  fs.writeFileSync(path.join(dir, 'runner.cjs'), `
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(executed)}, JSON.stringify(process.argv.slice(2)));
${succeed
    ? `fs.rmSync(${JSON.stringify(dir)}, {recursive:true, force:true});\nconsole.log(JSON.stringify({recovery_required:false, stage:'aborted_before_install'}));`
    : 'process.exit(9);'}
`, { mode: 0o700 });
  const journal = {
    formatVersion: 1,
    transactionId: 'tx',
    zylosDir: root,
    nodePath: process.execPath,
    from: '1.0.0-beta.1',
    phase: 'preparing',
    installationIntent: false,
    initialIdentity: {},
    recoveryHashes: Object.fromEntries(['runner.cjs', 'maintenance.cjs', 'installer.cjs']
      .map(name => [name, maintenance.hash(path.join(dir, name))])),
  };
  if (controller) {
    const digest = 'a'.repeat(64);
    Object.assign(journal, {
      phase: 'restored_data_ready',
      installationIntent: true,
      skillsDir: path.join(root, '.claude/skills'),
      dbBackupDir: path.join(root, '.backup/db/tx'),
      snapshotManifestHash: digest,
      coreManifest: [{name:'core', existedBefore:true, backedUp:true, originalHash:digest}],
      originalServices: [],
      initialIdentity: {
        nodePath:process.execPath, packageJson:path.join(root,'package.json'), packageHash:digest,
        cliRoot:path.join(root,'cli'), cliHash:digest, workerPath:path.join(root,'cli/worker.js'),
        workerHash:digest, ecosystemHash:null,
        databases:maintenance.databasePaths(2).map(source=>({source,exists:true})),
      },
    });
  }
  maintenance.update(dir, journal);
  if (controller) maintenance.durable(path.join(dir, 'controller.json'), maintenance.identity());
  return { dir, executed };
}

function publishActiveRecoveryCue(root) {
  const stable = path.join(root, '.zylos/upgrade');
  fs.mkdirSync(stable, {recursive:true, mode:0o700});
  fs.writeFileSync(path.join(stable, 'active.json'), '{}', {mode:0o600});
  fs.writeFileSync(path.join(stable, 'maintenance.cjs'), '// fixture dependency\n', {mode:0o600});
  fs.writeFileSync(path.join(stable, 'bootstrap.cjs'),
    "exports.bootstrap = () => ({active:true, blocked:false, prompt:'cleanup task'});\n", {mode:0o600});
}

for (const Cls of [ClaudeAdapter, CodexAdapter]) {
  test(`${Cls.name}: default launch observes actual exec, cwd and fresh single-session F2`, async t => {
    const f = setup(t, Cls); const p = await f.launch();
    assert.equal(p.result.tmuxName, tmuxNameForGroup('origin'));
    assert.equal(p.exe, fs.realpathSync(process.execPath));
    assert.equal(p.args[1], f.command);
    assert.equal(p.cwd, fs.realpathSync(f.root));
    assert.equal(p.env.ZYLOS_RUN_ID, f.input.runId);
    assert.equal(p.env.ZYLOS_MODEL_CONFIG, JSON.stringify(f.input.launchConfig));
    assert.equal(p.env.ZYLOS_SESSION_GROUP, undefined);
    assert.doesNotMatch(f.tmux('show-environment', '-t', p.result.tmuxName), /^ZYLOS_SESSION_GROUP=/m);
    assert.equal(p.env.CLAUDECODE, undefined); assert.equal(p.env.CLAUDE_CODE_ENTRYPOINT, undefined);
    assert.equal(p.env.ZYLOS_RUNTIME_GENERATION, undefined);
    assert.equal(fs.existsSync(path.join(f.root, 'activity-monitor/runtime-generation.json')), false);
    assert.equal(p.args.includes('--model'), false);
    assert.equal(p.args.some(a => a.startsWith('model_reasoning_effort=')), false);
    assert.equal(Number.isInteger(p.result.createdAt), true);
    const paneCommand = f.tmux('display-message', '-p', '-t', p.result.tmuxName, '#{pane_start_command}');
    assert.equal(paneCommand.includes(secret), false);
    assert.equal(paneCommand.includes('ANTHROPIC_API_KEY'), false);
    if (Cls === CodexAdapter) assert.equal(p.args.at(-1), sentinel);
  });

  test(`${Cls.name}: repeated fresh launches preserve manifest npm mirrors`, async t => {
    const f = setup(t, Cls);
    deployManifestTemplate(path.resolve(import.meta.dirname, '../../../templates/runtime-env.manifest.example'), f.root);
    f.env.npm_config_registry = 'https://registry.example.test/';
    f.env.npm_config_better_sqlite3_binary_host_mirror = 'https://binary.example.test/better-sqlite3';
    for (let cycle = 0; cycle < 3; cycle++) {
      const p = await f.launch({ sessionGroup: `test:cycle-${cycle}`, sessionMode: 'multi', runId: `cycle-${cycle}` });
      for (const key of ['npm_config_registry', 'npm_config_better_sqlite3_binary_host_mirror']) assert.equal(p.env[key], f.env[key]);
      assert.equal(p.env.ZYLOS_SESSION_GROUP, `test:cycle-${cycle}`);
    }
  });

  test(`${Cls.name}: existing name rejects without writing into the original process`, async t => {
    const f = setup(t, Cls); const first = await f.launch();
    await assert.rejects(f.launch({ runId: 'replacement-run' }), { code: 'NAME_CONFLICT' });
    assert.equal(f.tmux('list-panes', '-t', first.result.tmuxName, '-F', '#{pane_pid}').trim(), first.pid);
    assert.equal(f.tmux('list-sessions', '-F', '#{session_name}').trim(), first.result.tmuxName);
    assert.match(f.tmux('show-environment', '-t', first.result.tmuxName), /ZYLOS_RUN_ID=fresh-run/);
  });

  test(`${Cls.name}: explicit override preserves quoted model argv and multi group`, async t => {
    const f = setup(t, Cls);
    const config = { runtime: f.input.launchConfig.runtime, mode: 'override', model: "model with ' quote", effort: 'high' };
    const p = await f.launch({ launchConfig: config, sessionMode: 'multi', sessionGroup: 'telegram:g-123' });
    assert.equal(p.args[p.args.indexOf('--model') + 1], config.model);
    assert.equal(p.env.ZYLOS_MODEL_CONFIG, JSON.stringify(config));
    assert.equal(p.env.ZYLOS_SESSION_GROUP, 'telegram:g-123');
    assert.equal(fs.readFileSync(f.helpLog, 'utf8'), 'help\n');
    if (Cls === ClaudeAdapter) assert.equal(p.args[p.args.indexOf('--effort') + 1], 'high');
    else { assert.ok(p.args.includes('model_reasoning_effort="high"')); assert.ok(p.args.includes('--no-daemon')); assert.equal(p.args.at(-1), sentinel); }
  });

  for(const mode of (Cls===CodexAdapter?['override','default']:['override'])) {
    const title=mode==='override'?`${Cls.name}: capability failure rejects before tmux creation`:'Codex default capability failure rejects before creation';
    test(title,async t=>{
      const f=setup(t,Cls,{helpFails:true});
      const changes=mode==='default'?{}:{launchConfig:{runtime:f.input.launchConfig.runtime,mode,model:'test',effort:'high'}};
      await assert.rejects(f.launch(changes),{code:'LAUNCH_FAILED'});
      assert.throws(()=>f.tmux('list-sessions'));
    });
  }

  test(`${Cls.name}: unsupported override rejects before creation`, async t => {
    const f = setup(t, Cls, { help: ' --help ' });
    await assert.rejects(f.launch({ launchConfig: { runtime: f.input.launchConfig.runtime, mode: 'override', model: 'test', effort: 'high' } }), { code: 'MODEL_CONFIG_REJECTED' });
    assert.throws(() => f.tmux('list-sessions'));
  });

  test(`${Cls.name}: failed automatic startup recovery reaches runtime argv`, async t => {
    const f = setup(t, Cls);
    const recovery = publishStartupRecovery(f.root);
    const p = await f.launch();
    assert.deepEqual(JSON.parse(fs.readFileSync(recovery.executed, 'utf8')), ['resume', '--transaction-dir', recovery.dir]);
    assert.match(p.args.at(-1), /SYSTEM RECOVERY TASK/);
    assert.doesNotMatch(p.args.at(-1), /undefined/);
    if (Cls === CodexAdapter) assert.equal(p.args.includes(sentinel), false);
  });

  test(`${Cls.name}: successful automatic startup recovery preserves ordinary argv`, async t => {
    const f = setup(t, Cls);
    const recovery = publishStartupRecovery(f.root, { succeed: true });
    const p = await f.launch();
    assert.deepEqual(JSON.parse(fs.readFileSync(recovery.executed, 'utf8')), ['resume', '--transaction-dir', recovery.dir]);
    assert.doesNotMatch(JSON.stringify(p.args), /SYSTEM RECOVERY TASK/);
    if (Cls === CodexAdapter) assert.equal(p.args.at(-1), sentinel);
  });

  test(`${Cls.name}: live upgrade controller preserves ordinary argv`, async t => {
    const f = setup(t, Cls);
    const recovery = publishStartupRecovery(f.root, { controller: true });
    const p = await f.launch();
    assert.equal(fs.existsSync(recovery.executed), false);
    assert.doesNotMatch(JSON.stringify(p.args), /SYSTEM RECOVERY TASK/);
    if (Cls === CodexAdapter) assert.equal(p.args.at(-1), sentinel);
  });

  test(`${Cls.name}: active recovery cue appends once to the ordinary prompt`, async t => {
    const f = setup(t, Cls);
    publishActiveRecoveryCue(f.root);
    const p = await f.launch();
    const prompt = p.args.at(-1);
    assert.equal((prompt.match(/cleanup task/g) || []).length, 1);
    assert.doesNotMatch(prompt, /undefined/);
    if (Cls === CodexAdapter) assert.equal(prompt, `${sentinel}\n\ncleanup task`);
    else assert.equal(prompt, 'cleanup task');
  });
}

test('Claude compat PATH is deduplicated in actual runtime environment', async t => {
  const f = setup(t, ClaudeAdapter);
  fs.writeFileSync(path.join(f.root, '.env'), 'ZYLOS_CLEAN_ENV=false\n');
  f.env.PATH = '/usr/bin:/bin:/usr/bin:/bin';
  const p = await f.launch(); assert.equal(p.env.PATH, '/usr/bin:/bin');
});

for(const [mode,title,help,cycles] of [
  ['override','Codex override without daemon capability omits unsupported flag and keeps stateless sentinel',' --model MODEL ',2],
  ['default','Codex default launch without daemon capability omits unsupported flag',' --help ',1],
]) test(title,async t=>{
  const f=setup(t,CodexAdapter,{help});
  for(let i=0;i<cycles;i++){
    const changes=mode==='default'?{}:{sessionGroup:`test:codex-${i}`,sessionMode:'multi',launchConfig:{runtime:'codex',mode,model:'test',effort:'low'}};
    const p=await f.launch(changes);
    assert.equal(p.args.includes('--no-daemon'),false);assert.equal(p.args.at(-1),sentinel);
    if(mode==='override')assert.equal(p.args.some(a=>a.includes('session-start-inject.js')),false);
  }
  if(mode==='override')assert.equal(fs.existsSync(path.join(f.root,'.zylos/first-start-done')),false);
});

// Preserve both manifest-based native-auth paths and explicit-token fallback.
for(const [auth,title] of [
  ['credentials','Claude native auth strips dotenv tokens from actual runtime environment'],
  ['status','Claude native auth status strips dotenv tokens without credential file'],
  ['none','Claude without native auth retains explicitly allowed dotenv tokens'],
]) test(title,async t=>{
  const f=setup(t,ClaudeAdapter,{nativeAuth:auth==='status'});
  fs.mkdirSync(path.join(f.root,'.zylos'));
  fs.writeFileSync(path.join(f.root,'.zylos/runtime-env.manifest'),'env ANTHROPIC_API_KEY\nenv CLAUDE_CODE_OAUTH_TOKEN\n');
  if(auth==='credentials'){
    fs.mkdirSync(path.join(f.home,'.claude'));
    fs.writeFileSync(path.join(f.home,'.claude/.credentials.json'),JSON.stringify({claudeAiOauth:{refreshToken:'synthetic-refresh-token'}}));
  }
  fs.appendFileSync(path.join(f.root,'.env'),'CLAUDE_CODE_OAUTH_TOKEN=synthetic-oauth-token\n');
  const originalEnv={...f.env},p=await f.launch();
  assert.equal(p.env.ANTHROPIC_API_KEY,auth==='none'?secret:undefined);
  assert.equal(p.env.CLAUDE_CODE_OAUTH_TOKEN,auth==='none'?'synthetic-oauth-token':undefined);
  if(auth==='none')assert.deepEqual(f.env,originalEnv);
});

// Preserve native-auth precedence and daemon isolation through the target API.
test('Codex default launch retains supported daemon isolation', async t => {
  const f = setup(t, CodexAdapter);
  const p = await f.launch();
  assert.ok(p.args.includes('--no-daemon'), 'supported isolation must also apply to default model config');
});


test('Claude selected config directory does not borrow default HOME credentials', async t => {
  const f = setup(t, ClaudeAdapter);
  fs.mkdirSync(path.join(f.home, '.claude'));
  fs.writeFileSync(path.join(f.home, '.claude/.credentials.json'), JSON.stringify({ claudeAiOauth: { refreshToken: 'different-account-token' } }));
  const selected = path.join(f.home, 'selected'); fs.mkdirSync(selected);
  f.env.CLAUDE_CONFIG_DIR = selected;
  fs.mkdirSync(path.join(f.root, '.zylos'));
  fs.writeFileSync(path.join(f.root, '.zylos/runtime-env.manifest'), 'env ANTHROPIC_API_KEY\ninherit CLAUDE_CONFIG_DIR\n');
  const p = await f.launch();
  assert.equal(p.env.CLAUDE_CONFIG_DIR, selected);
  assert.equal(p.env.ANTHROPIC_API_KEY, secret);
});
