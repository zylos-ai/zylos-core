import { isolatedTmux } from '../../../test/helpers/isolated-tmux.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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

function setup(t, Cls, { help = ' --model MODEL --effort EFFORT --no-daemon ', helpFails = false, nativeAuth = false } = {}) {
  const {dir,socketPath,tmux}=isolatedTmux(t,{prefix:'runtime-launch-',socketName:'socket',trim:false});
  const root = path.join(dir, "root with ' quote");
  const home = path.join(dir, 'home');
  fs.mkdirSync(root); fs.mkdirSync(home);
  const command = path.join(dir, "runtime with ' quote");
  const helpLog = path.join(dir, 'help-log');
  const report = path.join(dir, 'runtime-report.json');
  fs.writeFileSync(command, `#!${process.execPath}\nconst fs = require('node:fs');\nif (process.argv.includes('--help')) { fs.appendFileSync(${JSON.stringify(helpLog)}, 'help\\n'); ${helpFails ? 'process.exit(2);' : `console.log(${JSON.stringify(help)});`} } else if (process.argv[2] === 'auth' && process.argv[3] === 'status') { console.log(JSON.stringify({ loggedIn: ${nativeAuth}, authMethod: 'claude.ai' })); } else { fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify({pid:process.pid,args:process.argv,env:process.env,cwd:process.cwd(),exe:fs.realpathSync(process.execPath)})); setInterval(() => {}, 1000); }\n`, { mode: 0o700 });
  fs.writeFileSync(path.join(root, '.env'), `ANTHROPIC_API_KEY=${secret}\n`);
  const env = { HOME: home, PATH: process.env.PATH, USER: process.env.USER || 'test',
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
