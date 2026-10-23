import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ClaudeAdapter } from '../runtime/claude.js';
import { CodexAdapter } from '../runtime/codex.js';
import { deployManifestTemplate } from '../runtime/tmux-env.js';
import { tmuxNameForGroup } from '../session-group-paths.js';

// Frozen SessionAdapter API integration. Only the model CLI is a stand-in;
// paths, target observation, command/env/script construction and tmux settlement
// are production code. No child_process mock: spawn must really be exported.
// Requires Linux /proc and tmux; does not validate real model/auth or macOS.
// Retired assertions: JSON/Node launcher, -E/-e PATH transport, existing-session
// sendMessage reuse, launch-time instruction migration and persistent permission
// writes. They are not requirements of launch({sessionGroup,runId,launchConfig,
// sessionMode}); same-name reuse must now fail with NAME_CONFLICT.
const binary = process.env.TEST_TMUX_BIN || 'tmux';
const sentinel = 'System startup trigger, not a user message. Continue with startup context.';
const secret = 'sk-ant-synthetic-launch-test';

function setup(t, Cls, { help = ' --model MODEL --effort EFFORT --no-daemon ', helpFails = false, nativeAuth = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-launch-'));
  const root = path.join(dir, "root with ' quote");
  const home = path.join(dir, 'home');
  fs.mkdirSync(root); fs.mkdirSync(home);
  const socketPath = path.join(dir, 'socket');
  const tmux = (...args) => execFileSync(binary, ['-S', socketPath, ...args], { encoding: 'utf8', timeout: 3000, stdio: ['ignore','pipe','pipe'] });
  t.after(() => { try { tmux('kill-server'); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });
  const command = path.join(dir, "runtime with ' quote");
  const helpLog = path.join(dir, 'help-log');
  fs.writeFileSync(command, `#!${process.execPath}\nconst fs = require('node:fs');\nif (process.argv.includes('--help')) { fs.appendFileSync(${JSON.stringify(helpLog)}, 'help\\n'); ${helpFails ? 'process.exit(2);' : `console.log(${JSON.stringify(help)});`} } else if (process.argv[2] === 'auth' && process.argv[3] === 'status') { console.log(JSON.stringify({ loggedIn: ${nativeAuth}, authMethod: 'claude.ai' })); } else { setInterval(() => {}, 1000); }\n`, { mode: 0o700 });
  fs.writeFileSync(path.join(root, '.env'), `ANTHROPIC_API_KEY=${secret}\n`);
  const env = { HOME: home, PATH: process.env.PATH, USER: process.env.USER || 'test',
    CLAUDE_BIN: command, CODEX_BIN: command, CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli',
    ZYLOS_SESSION_GROUP: 'stale-group', ZYLOS_RUN_ID: 'stale-run', ZYLOS_MODEL_CONFIG: 'stale-config' };
  const adapter = new Cls({ root, env, tmux: { binary, socketPath, configFile: '/dev/null' } });
  const runtime = adapter.runtimeId;
  const input = { sessionGroup: null, runId: 'fresh-run', sessionMode: 'single', launchConfig: { runtime, mode: 'default' } };
  async function launch(changes = {}) {
    const request = { ...input, ...changes };
    const result = await adapter.launch(request);
    const pid = tmux('list-panes', '-t', result.tmuxName, '-F', '#{pane_pid}').trim();
    const proc = `/proc/${pid}`;
    const args = fs.readFileSync(`${proc}/cmdline`, 'utf8').split('\0').filter(Boolean);
    const actualEnv = Object.fromEntries(fs.readFileSync(`${proc}/environ`, 'utf8').split('\0').filter(Boolean).map(row => { const i = row.indexOf('='); return [row.slice(0, i), row.slice(i + 1)]; }));
    return { result, pid, args, env: actualEnv, cwd: fs.readlinkSync(`${proc}/cwd`), exe: fs.readlinkSync(`${proc}/exe`) };
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

  test(`${Cls.name}: capability failure rejects before tmux creation`, async t => {
    const f = setup(t, Cls, { helpFails: true });
    await assert.rejects(f.launch({ launchConfig: { runtime: f.input.launchConfig.runtime, mode: 'override', model: 'test', effort: 'high' } }), { code: 'LAUNCH_FAILED' });
    assert.throws(() => f.tmux('list-sessions'));
  });

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

test('Codex override without daemon capability omits unsupported flag and keeps stateless sentinel', async t => {
  const f = setup(t, CodexAdapter, { help: ' --model MODEL ' });
  for (let i = 0; i < 2; i++) {
    const p = await f.launch({ sessionGroup: `test:codex-${i}`, sessionMode: 'multi', launchConfig: { runtime: 'codex', mode: 'override', model: 'test', effort: 'low' } });
    assert.equal(p.args.includes('--no-daemon'), false); assert.equal(p.args.at(-1), sentinel);
    assert.equal(p.args.some(a => a.includes('session-start-inject.js')), false);
  }
  assert.equal(fs.existsSync(path.join(f.root, '.zylos/first-start-done')), false);
});

// Preserve native-auth precedence and daemon isolation through the target API.
test('Claude native auth strips dotenv tokens from actual runtime environment', async t => {
  const f = setup(t, ClaudeAdapter);
  fs.mkdirSync(path.join(f.root, '.zylos'));
  fs.writeFileSync(path.join(f.root, '.zylos/runtime-env.manifest'), 'env ANTHROPIC_API_KEY\nenv CLAUDE_CODE_OAUTH_TOKEN\n');
  fs.mkdirSync(path.join(f.home, '.claude'));
  fs.writeFileSync(path.join(f.home, '.claude/.credentials.json'), JSON.stringify({ claudeAiOauth: { refreshToken: 'synthetic-refresh-token' } }));
  fs.appendFileSync(path.join(f.root, '.env'), 'CLAUDE_CODE_OAUTH_TOKEN=synthetic-oauth-token\n');
  const p = await f.launch();
  assert.equal(p.env.ANTHROPIC_API_KEY, undefined, 'native auth must not be overridden by dotenv API key');
  assert.equal(p.env.CLAUDE_CODE_OAUTH_TOKEN, undefined, 'native auth must not be overridden by dotenv token');
});

test('Codex default launch retains supported daemon isolation', async t => {
  const f = setup(t, CodexAdapter);
  const p = await f.launch();
  assert.ok(p.args.includes('--no-daemon'), 'supported isolation must also apply to default model config');
});


test('Codex default launch without daemon capability omits unsupported flag', async t => {
  const f = setup(t, CodexAdapter, { help: ' --help ' });
  const p = await f.launch();
  assert.equal(p.args.includes('--no-daemon'), false);
  assert.equal(p.args.at(-1), sentinel);
});

test('Codex default capability failure rejects before creation', async t => {
  const f = setup(t, CodexAdapter, { helpFails: true });
  await assert.rejects(f.launch(), { code: 'LAUNCH_FAILED' });
  assert.throws(() => f.tmux('list-sessions'));
});

test('Claude native auth status strips dotenv tokens without credential file', async t => {
  const f = setup(t, ClaudeAdapter, { nativeAuth: true });
  fs.mkdirSync(path.join(f.root, '.zylos'));
  fs.writeFileSync(path.join(f.root, '.zylos/runtime-env.manifest'), 'env ANTHROPIC_API_KEY\nenv CLAUDE_CODE_OAUTH_TOKEN\n');
  fs.appendFileSync(path.join(f.root, '.env'), 'CLAUDE_CODE_OAUTH_TOKEN=synthetic-oauth-token\n');
  const p = await f.launch();
  assert.equal(p.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(p.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
});


test('Claude without native auth retains explicitly allowed dotenv tokens', async t => {
  const f = setup(t, ClaudeAdapter);
  fs.mkdirSync(path.join(f.root, '.zylos'));
  fs.writeFileSync(path.join(f.root, '.zylos/runtime-env.manifest'), 'env ANTHROPIC_API_KEY\nenv CLAUDE_CODE_OAUTH_TOKEN\n');
  fs.appendFileSync(path.join(f.root, '.env'), 'CLAUDE_CODE_OAUTH_TOKEN=synthetic-oauth-token\n');
  const originalEnv = { ...f.env };
  const p = await f.launch();
  assert.equal(p.env.ANTHROPIC_API_KEY, secret);
  assert.equal(p.env.CLAUDE_CODE_OAUTH_TOKEN, 'synthetic-oauth-token');
  assert.deepEqual(f.env, originalEnv);
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
