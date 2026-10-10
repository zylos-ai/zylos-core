import { describe, it, mock, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'smol-toml';
import { deployManifestTemplate } from '../runtime/tmux-env.js';

// ── Fake filesystem ──────────────────────────────────────────────────────────

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-launch-test-'));
const fakeHome = path.join(tmpRoot, 'home');
const fakeZylosDir = path.join(fakeHome, 'zylos');

const savedEnv = {
  HOME: process.env.HOME,
  ZYLOS_DIR: process.env.ZYLOS_DIR,
  CLAUDE_BIN: process.env.CLAUDE_BIN,
  CODEX_BIN: process.env.CODEX_BIN,
  CLAUDE_BYPASS_PERMISSIONS: process.env.CLAUDE_BYPASS_PERMISSIONS,
  CODEX_BYPASS_PERMISSIONS: process.env.CODEX_BYPASS_PERMISSIONS,
};

process.env.HOME = fakeHome;
process.env.ZYLOS_DIR = fakeZylosDir;
process.env.CLAUDE_BIN = 'claude';
process.env.CODEX_BIN = 'codex';
process.env.CLAUDE_BYPASS_PERMISSIONS = 'false';
process.env.CODEX_BYPASS_PERMISSIONS = 'false';

// Directory structure
for (const dir of [
  path.join(fakeHome, '.claude'),
  path.join(fakeZylosDir, '.claude', 'skills', 'comm-bridge', 'scripts'),
  path.join(fakeZylosDir, '.claude', 'skills', 'zylos-memory', 'scripts'),
  path.join(fakeZylosDir, '.claude', 'skills', 'activity-monitor', 'scripts'),
  path.join(fakeZylosDir, 'memory'),
  path.join(fakeZylosDir, 'activity-monitor'),
]) {
  fs.mkdirSync(dir, { recursive: true });
}

fs.writeFileSync(path.join(fakeZylosDir, '.env'), [
  'ANTHROPIC_API_KEY=sk-ant-secret-test-key-do-not-expose',
].join('\n'));

fs.writeFileSync(path.join(fakeZylosDir, 'memory', 'state.md'), '- Status: completed\n');
fs.writeFileSync(path.join(fakeZylosDir, 'CLAUDE.md'), 'legacy claude instructions\n');
fs.writeFileSync(path.join(fakeZylosDir, 'AGENTS.md'), 'legacy codex instructions\n');

for (const script of [
  '.claude/skills/zylos-memory/scripts/session-start-inject.js',
  '.claude/skills/comm-bridge/scripts/c4-session-init.js',
  '.claude/skills/activity-monitor/scripts/session-start-prompt.js',
]) {
  fs.writeFileSync(path.join(fakeZylosDir, script), '// stub');
}

// ── Mock child_process ───────────────────────────────────────────────────────

const calls = { execSync: [], execFileSync: [] };
let tmuxSessionExists = false;
const resolvedCodex = "/selected codex/it's/bin/codex";
let codexHelp = '  --no-daemon  Run without the shared background server';
let codexHelpError = null;
let paneText = '';
let sendKeysError = null;
let startupTimers = [];
let timeoutMock;

mock.module('node:child_process', {
  namedExports: {
    execSync: mock.fn((cmd, opts) => {
      calls.execSync.push({ cmd, opts });
      if (typeof cmd === 'string' && cmd.includes('tmux has-session')) {
        if (!tmuxSessionExists) throw new Error('no session');
      }
      return '';
    }),
    execFileSync: mock.fn((file, args, opts) => {
      calls.execFileSync.push({ file, args: args ? [...args] : [], opts });
      if (file === 'tmux' && args?.[0] === 'has-session') {
        if (!tmuxSessionExists) throw new Error('no session');
        return '';
      }
      if (file === 'tmux' && args?.[0] === 'capture-pane') return paneText;
      if (file === 'tmux' && args?.[0] === 'send-keys' && sendKeysError) throw sendKeysError;
      if (file === 'which' && args?.[0] === 'codex') return resolvedCodex + '\n';
      if (file === resolvedCodex && args?.[0] === '--help') {
        if (codexHelpError) throw codexHelpError;
        return codexHelp;
      }
      if (args?.[0] === '--version') return '2.1.137';
      if (args?.includes('auth')) throw new Error('not logged in');
      return '';
    }),
    spawnSync: mock.fn((file, args, opts) => {
      const zylosDir = opts?.env?.ZYLOS_CODEX_TRUST_CWD || fakeZylosDir;
      const key = `${path.join(zylosDir, '.codex', 'hooks.json')}:session_start:0:0`;
      const configPath = path.join(fakeHome, '.codex', 'config.toml');
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, [
        '[features]',
        'hooks = true',
        '',
        `[hooks.state."${key}"]`,
        'enabled = true',
        'trusted_hash = "sha256:test"',
        '',
      ].join('\n'));
      return {
        status: 0,
        stdout: JSON.stringify({ ok: true, trusted: 1 }) + '\n',
        stderr: '',
      };
    }),
    execFile: mock.fn((...fnArgs) => {
      const cb = fnArgs.find(a => typeof a === 'function');
      if (cb) process.nextTick(() => cb(null, '', ''));
      return { on: () => {}, stdout: null, stderr: null, pid: 0 };
    }),
  },
});

// ── Import adapters after mocks ──────────────────────────────────────────────

const { ClaudeAdapter } = await import('../runtime/claude.js');
const { CodexAdapter } = await import('../runtime/codex.js');

// ── Cleanup ──────────────────────────────────────────────────────────────────

after(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  calls.execSync.length = 0;
  calls.execFileSync.length = 0;
  tmuxSessionExists = false;
  codexHelp = '  --no-daemon  Run without the shared background server';
  codexHelpError = null;
  paneText = '';
  sendKeysError = null;
  startupTimers = [];
  const originalSetTimeout = globalThis.setTimeout;
  timeoutMock = mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
    if (delay === 8000) {
      startupTimers.push(() => callback(...args));
      return { unref() {} };
    }
    return originalSetTimeout(callback, delay, ...args);
  });
});

afterEach(() => {
  timeoutMock.mock.restore();
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function findTmuxNewSession() {
  return calls.execFileSync.find(
    c => c.file === 'tmux' && c.args?.includes('new-session')
  );
}

function makeAdapter(Cls) {
  const adapter = new Cls({});
  adapter.buildInstructionFile = async () => '/fake/instruction.md';
  return adapter;
}

function readSpecEnv() {
  const tmux = findTmuxNewSession();
  if (!tmux) return null;
  const lastArg = tmux.args[tmux.args.length - 1];
  const specMatch = lastArg.match(/"([^"]+\.json)"/);
  if (!specMatch) return null;
  try {
    const spec = JSON.parse(fs.readFileSync(specMatch[1], 'utf8'));
    return spec.env;
  } catch {
    return null;
  }
}

function readLaunchSpec() {
  const tmux = findTmuxNewSession();
  if (!tmux) return null;
  const lastArg = tmux.args[tmux.args.length - 1];
  const specMatch = lastArg.match(/"([^"]+\.json)"/);
  if (!specMatch) return null;
  try {
    return JSON.parse(fs.readFileSync(specMatch[1], 'utf8'));
  } catch {
    return null;
  }
}

describe('npm mirror environment through runtime launch', () => {
  for (const Cls of [ClaudeAdapter, CodexAdapter]) {
    it(`${Cls.name} preserves deployment mirrors on initial launch and new sessions`, async () => {
      const names = ['npm_config_registry', 'npm_config_better_sqlite3_binary_host_mirror'];
      const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
      const dotenvPath = path.join(fakeZylosDir, '.env');
      const dotenvBefore = fs.readFileSync(dotenvPath);
      const manifestPath = path.join(fakeZylosDir, '.zylos', 'runtime-env.manifest');
      const manifestBefore = fs.existsSync(manifestPath) ? fs.readFileSync(manifestPath) : null;
      const template = path.resolve(import.meta.dirname, '../../../templates/runtime-env.manifest.example');
      try {
        fs.writeFileSync(dotenvPath, 'ZYLOS_CLEAN_ENV=true\n');
        fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
        if (fs.existsSync(manifestPath)) fs.unlinkSync(manifestPath);
        deployManifestTemplate(template, fakeZylosDir);
        process.env.npm_config_registry = 'https://registry.example.test/';
        process.env.npm_config_better_sqlite3_binary_host_mirror = 'https://binary.example.test/better-sqlite3';
        // Exercise the adapters again with no existing session, as after a
        // restart/rotation. This checks launch-spec wiring, not a live PM2 host.
        for (const cycle of ['initial', 'restart', 'rotation']) {
          calls.execFileSync.length = 0;
          calls.execSync.length = 0;
          tmuxSessionExists = false;
          await makeAdapter(Cls).launch({ bypassPermissions: false });
          const spec = readLaunchSpec();
          assert.ok(spec, `${cycle}: launch spec missing`);
          for (const name of names) assert.equal(spec.env[name], process.env[name], `${cycle}: ${name}`);
        }
      } finally {
        fs.writeFileSync(dotenvPath, dotenvBefore);
        if (manifestBefore) fs.writeFileSync(manifestPath, manifestBefore);
        else if (fs.existsSync(manifestPath)) fs.unlinkSync(manifestPath);
        for (const [name, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }
    });
  }
});

// ── Claude launch tests ──────────────────────────────────────────────────────

describe('Claude launch — new session', () => {
  it('tmux new-session includes -E flag', async () => {
    tmuxSessionExists = false;
    await makeAdapter(ClaudeAdapter).launch({ bypassPermissions: false });

    const tmux = findTmuxNewSession();
    assert.ok(tmux, 'should call execFileSync with tmux new-session');
    assert.ok(tmux.args.includes('-E'), 'tmux args must include -E');
  });

  it('tmux shell-command uses absolute node path from process.execPath', async () => {
    tmuxSessionExists = false;
    await makeAdapter(ClaudeAdapter).launch({ bypassPermissions: false });

    const tmux = findTmuxNewSession();
    assert.ok(tmux);
    const shellCmd = tmux.args[tmux.args.length - 1];
    assert.ok(
      shellCmd.includes(process.execPath),
      `tmux shell-command must use absolute node path (process.execPath=${process.execPath}), got: ${shellCmd}`,
    );
  });

  it('tmux cmdline does not contain API key or ANTHROPIC_API_KEY', async () => {
    tmuxSessionExists = false;
    await makeAdapter(ClaudeAdapter).launch({ bypassPermissions: false });

    const tmux = findTmuxNewSession();
    assert.ok(tmux);
    const joined = tmux.args.join(' ');
    assert.ok(!joined.includes('sk-ant-'), 'tmux cmdline must not contain API key value');
    assert.ok(!joined.includes('ANTHROPIC_API_KEY'), 'tmux cmdline must not expose ANTHROPIC_API_KEY');
  });

  it('spec.env excludes CLAUDECODE and CLAUDE_CODE_ENTRYPOINT even when present in process.env', async () => {
    tmuxSessionExists = false;
    process.env.CLAUDECODE = '1';
    process.env.CLAUDE_CODE_ENTRYPOINT = 'cli';
    try {
      await makeAdapter(ClaudeAdapter).launch({ bypassPermissions: false });
      const env = readSpecEnv();
      assert.ok(env, 'spec should be written');
      assert.equal(env.CLAUDECODE, undefined, 'CLAUDECODE must be stripped from spec.env');
      assert.equal(env.CLAUDE_CODE_ENTRYPOINT, undefined, 'CLAUDE_CODE_ENTRYPOINT must be stripped from spec.env');
    } finally {
      delete process.env.CLAUDECODE;
      delete process.env.CLAUDE_CODE_ENTRYPOINT;
    }
  });

  it('spec.env excludes auth tokens when native auth is detected', async () => {
    tmuxSessionExists = false;
    // Simulate native auth by writing a credentials file
    const credFile = path.join(fakeHome, '.claude', '.credentials.json');
    fs.writeFileSync(credFile, JSON.stringify({
      claudeAiOauth: { refreshToken: 'fake-refresh-token' },
    }));
    try {
      await makeAdapter(ClaudeAdapter).launch({ bypassPermissions: false });
      const env = readSpecEnv();
      assert.ok(env, 'spec should be written');
      assert.equal(env.ANTHROPIC_API_KEY, undefined, 'ANTHROPIC_API_KEY must be stripped when native auth detected');
      assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined, 'CLAUDE_CODE_OAUTH_TOKEN must be stripped when native auth detected');
    } finally {
      fs.unlinkSync(credFile);
    }
  });
});

describe('Claude launch — existing session', () => {
  it('does not create a new tmux session', async () => {
    tmuxSessionExists = true;
    const adapter = makeAdapter(ClaudeAdapter);
    adapter.sendMessage = async () => {};

    await adapter.launch({ bypassPermissions: false });

    assert.equal(findTmuxNewSession(), undefined, 'must NOT call tmux new-session');
  });

  it('sends command via sendMessage', async () => {
    tmuxSessionExists = true;
    let sent = '';
    const adapter = makeAdapter(ClaudeAdapter);
    adapter.sendMessage = async (text) => { sent = text; };

    await adapter.launch({ bypassPermissions: false });

    assert.ok(sent.length > 0, 'sendMessage should be called');
    assert.ok(sent.includes('claude'), 'sent command should reference claude');
  });
});

describe('Claude launch — compat mode PATH dedupe', () => {
  it('spec.env.PATH is deduplicated in compat mode', async () => {
    tmuxSessionExists = false;
    // Switch to compat mode
    fs.writeFileSync(path.join(fakeZylosDir, '.env'), [
      'ANTHROPIC_API_KEY=sk-ant-secret-test-key-do-not-expose',
      'ZYLOS_CLEAN_ENV=false',
    ].join('\n'));
    // Inject a bloated PATH
    const origPath = process.env.PATH;
    process.env.PATH = '/a:/b:/a:/c:/b';
    try {
      await makeAdapter(ClaudeAdapter).launch({ bypassPermissions: false });
      const env = readSpecEnv();
      assert.ok(env, 'spec should be written');
      assert.equal(env.PATH, '/a:/b:/c', 'PATH must be deduplicated in compat mode');

      const tmux = findTmuxNewSession();
      const pathArg = tmux.args.find(a => a.startsWith('PATH='));
      assert.ok(pathArg, 'tmux args should contain PATH= env');
      assert.equal(pathArg, 'PATH=/a:/b:/c', 'tmux -e PATH must also be deduplicated');
    } finally {
      process.env.PATH = origPath;
      // Restore default (clean env is now the default)
      fs.writeFileSync(path.join(fakeZylosDir, '.env'), [
        'ANTHROPIC_API_KEY=sk-ant-secret-test-key-do-not-expose',
      ].join('\n'));
    }
  });
});

// ── Codex launch tests ───────────────────────────────────────────────────────

describe('Codex launch — new session', () => {
  it('refuses to launch without instructions while split migration is pending', async () => {
    const agentsPath = path.join(fakeZylosDir, 'AGENTS.md');
    fs.unlinkSync(agentsPath);
    try {
      await assert.rejects(
        () => makeAdapter(CodexAdapter).launch({ bypassPermissions: false }),
        /missing while split instructions are pending migration/,
      );
    } finally {
      fs.writeFileSync(agentsPath, 'legacy codex instructions\n');
    }
  });

  it('tmux new-session includes -E flag', async () => {
    tmuxSessionExists = false;
    await makeAdapter(CodexAdapter).launch({ bypassPermissions: false });

    const tmux = findTmuxNewSession();
    assert.ok(tmux, 'should call execFileSync with tmux new-session');
    assert.ok(tmux.args.includes('-E'), 'tmux args must include -E');
  });

  it('tmux shell-command uses absolute node path from process.execPath', async () => {
    tmuxSessionExists = false;
    await makeAdapter(CodexAdapter).launch({ bypassPermissions: false });

    const tmux = findTmuxNewSession();
    assert.ok(tmux);
    const shellCmd = tmux.args[tmux.args.length - 1];
    assert.ok(
      shellCmd.includes(process.execPath),
      `tmux shell-command must use absolute node path (process.execPath=${process.execPath}), got: ${shellCmd}`,
    );
  });

  it('tmux cmdline does not contain secrets', async () => {
    tmuxSessionExists = false;
    await makeAdapter(CodexAdapter).launch({ bypassPermissions: false });

    const tmux = findTmuxNewSession();
    assert.ok(tmux);
    const joined = tmux.args.join(' ');
    assert.ok(!joined.includes('sk-ant-'), 'tmux cmdline must not contain API key value');
  });

  it('launch spec carries the internal kick sentinel, not a human-looking prompt', async () => {
    tmuxSessionExists = false;
    await makeAdapter(CodexAdapter).launch({ bypassPermissions: false });

    const spec = readLaunchSpec();
    assert.ok(spec, 'spec should be written');
    // Since #681 the positional launch arg is the kick prompt that triggers the
    // SessionStart hook — never the retired text bootstrap payload. Since
    // #743/#745 that prompt is a stateless internal lifecycle sentinel,
    // never a human-looking greeting that could be mistaken for a user turn.
    assert.deepEqual(spec.args.slice(0, -1), ['--no-daemon']);
    // Exact-string lock: the full contract text, not a prefix — a mutated
    // second sentence must fail here.
    assert.equal(spec.args.at(-1),
      'System startup trigger, not a user message. Continue with startup context.');
    assert.doesNotMatch(spec.args.at(-1), /\bhello\b/i);
    assert.doesNotMatch(spec.args.at(-1), /welcome back/i);
    assert.ok(!JSON.stringify(spec).includes('session-start-inject.js'));
  });

  it('kick sentinel is stateless — identical argv on every launch, no marker files (#743)', async () => {
    tmuxSessionExists = false;
    await makeAdapter(CodexAdapter).launch({ bypassPermissions: false });
    const first = readLaunchSpec().args.at(-1);

    calls.execFileSync.length = 0;
    await makeAdapter(CodexAdapter).launch({ bypassPermissions: false });
    const second = readLaunchSpec().args.at(-1);

    assert.equal(first, second, 'kick must not vary across launches');
    assert.ok(!fs.existsSync(path.join(fakeZylosDir, '.zylos', 'first-start-done')),
      'stateless sentinel must not persist launch state');
  });
});

describe('Codex launch — persistent permissions', () => {
  for (const exists of [false, true]) {
    it(`applies explicit bypass opt-in and withdrawal (existing tmux: ${exists})`, async () => {
      tmuxSessionExists = exists;
      const adapter = makeAdapter(CodexAdapter);
      let sent = '';
      adapter.sendMessage = async text => { sent = text; };
      const file = path.join(fakeZylosDir, '.codex', 'config.toml');
      await adapter.launch({ bypassPermissions: true });
      assert.equal(parse(fs.readFileSync(file, 'utf8')).approval_policy, 'never');
      assert.equal(parse(fs.readFileSync(file, 'utf8')).sandbox_mode, 'danger-full-access');
      if (exists) assert.match(sent, /--dangerously-bypass-approvals-and-sandbox/);
      else assert.ok(readLaunchSpec().args.includes('--dangerously-bypass-approvals-and-sandbox'));
      calls.execFileSync.length = 0;
      await adapter.launch({ bypassPermissions: false });
      assert.equal(parse(fs.readFileSync(file, 'utf8')).approval_policy, undefined);
      assert.equal(parse(fs.readFileSync(file, 'utf8')).sandbox_mode, undefined);
      if (exists) assert.doesNotMatch(sent, /--dangerously-bypass-approvals-and-sandbox/);
      else assert.ok(!readLaunchSpec().args.includes('--dangerously-bypass-approvals-and-sandbox'));
    });
  }
});

describe('Codex launch — existing session', () => {
  it('does not create a new tmux session', async () => {
    tmuxSessionExists = true;
    const adapter = makeAdapter(CodexAdapter);
    adapter.sendMessage = async () => {};

    await adapter.launch({ bypassPermissions: false });

    assert.equal(findTmuxNewSession(), undefined, 'must NOT call tmux new-session');
  });

  it('does not inject a bootstrap prompt in sendMessage', async () => {
    tmuxSessionExists = true;
    let sent = '';
    const adapter = makeAdapter(CodexAdapter);
    adapter.sendMessage = async (text) => { sent = text; };

    await adapter.launch({ bypassPermissions: false });

    assert.ok(sent.length > 0, 'sendMessage should be called');
    assert.ok(sent.includes('codex'), 'sent command should reference codex');
    // Exact-string lock for the paste path: the kick must ride as one
    // double-quoted argv carrying the full contract text.
    assert.ok(sent.includes(
      '"System startup trigger, not a user message. Continue with startup context."'),
    'existing-session command must carry the exact kick as one quoted argv');
    assert.ok(!sent.includes('_p=$(cat'), 'existing-session command should not load bootstrap prompt');
    assert.ok(!sent.includes('session-start-inject.js'), 'existing-session command should not run text bootstrap');
  });
});

describe('Codex startup dialogs', () => {
  const choices = [
    ['migration with first option selected', 'Choose a model\n› 1. Try new model\n  2. Use existing model'],
    ['migration with second option selected', 'Choose a model\n  1. Try new model\n› 2. Use existing model'],
    ['numbered menu without a selection arrow', '1. Continue with new settings\n2. Keep settings'],
    ['unknown numbered menu', '› 1. Enable experimental settings\n  2. Cancel'],
    ['numbered menu with Enter hint', '1. Enable experimental settings\n2. Cancel\nPress Enter to continue'],
    ['migration prose without numbers', 'Try new model or Use existing model\nPress Enter to continue'],
    ['new model prose only', 'Try new model\nPress Enter to continue'],
    ['existing model prose only', 'Use existing model\nPress Enter to continue'],
    ['unknown confirmation prose', 'Apply updated settings?\nPress Enter to continue'],
    ['unknown startup output', 'Waiting for an operator decision'],
  ];

  for (const exists of [false, true]) {
    async function launchAndCheck(t, pane) {
      tmuxSessionExists = exists;
      paneText = pane;
      const warnings = t.mock.method(console, 'warn', () => {});
      const adapter = makeAdapter(CodexAdapter);
      const sent = [];
      adapter.sendMessage = async text => { sent.push(text); };
      await adapter.launch({ bypassPermissions: false });
      assert.equal(Boolean(findTmuxNewSession()), !exists);
      assert.equal(sent.length, exists ? 1 : 0);
      assert.equal(startupTimers.length, 1, 'launch must schedule the actual 8-second callback');
      assert.equal(calls.execFileSync.filter(c => c.args[0] === 'capture-pane').length, 0);
      // Snapshot after launch: hook trust/config setup is separate from the timer.
      const configPaths = [
        path.join(fakeHome, '.codex', 'config.toml'),
        path.join(fakeZylosDir, '.codex', 'config.toml'),
      ];
      const before = configPaths.map(file => fs.readFileSync(file));
      warnings.mock.resetCalls();
      startupTimers[0]();
      assert.equal(calls.execFileSync.filter(c => c.args[0] === 'capture-pane').length, 1);
      for (const [i, file] of configPaths.entries()) {
        assert.deepEqual(fs.readFileSync(file), before[i], 'dialog check must not rewrite configuration');
      }
      return {
        keys: calls.execFileSync.filter(c => c.file === 'tmux' && c.args[0] === 'send-keys'),
        warnings: warnings.mock.calls.map(call => call.arguments),
      };
    }

    for (const [name, pane] of choices) {
      it(`leaves ${name} to the operator (existing tmux: ${exists})`, async t => {
        const result = await launchAndCheck(t, pane);
        assert.deepEqual(result.keys, [], 'startup must not accept or change a choice');
        assert.equal(result.warnings.length, 1, 'operator needs a warning');
        const warning = result.warnings[0].join(' ');
        assert.match(warning, /Codex.*startup.*operator/i);
        assert.match(warning, /model.*deployment|deployment.*model/i);
        assert.ok(!warning.includes(pane), 'warning must not include pane content');
        assert.ok(!warning.includes('experimental settings'), 'warning must not include menu options');
      });
    }

    for (const pane of ['Press Enter to continue', '  press enter to continue\n']) {
      it(`acknowledges only a standalone Enter prompt ${JSON.stringify(pane)} (existing tmux: ${exists})`, async t => {
        const result = await launchAndCheck(t, pane);
        assert.equal(result.keys.length, 1);
        assert.deepEqual(result.keys[0].args.slice(-1), ['Enter']);
        assert.ok(!result.keys[0].args.includes('1'), 'acknowledgement must never select option 1');
        assert.deepEqual(result.warnings, []);
      });
    }

    for (const [name, pane] of [
      ['empty pane', ''],
      ['unavailable pane', null],
      ['ready status', '›\n100% left · ? for shortcuts'],
      ['ready status with old menu text', '› 1. Try new model\n2. Use existing model\nPress Enter to continue\n100% left · ? for shortcuts'],
    ]) {
      it(`does not send startup keys for ${name} (existing tmux: ${exists})`, async t => {
        const result = await launchAndCheck(t, pane);
        assert.deepEqual(result.keys, []);
        assert.deepEqual(result.warnings, []);
      });
    }

    it(`warns without private error details when Enter fails (existing tmux: ${exists})`, async t => {
      sendKeysError = new Error('synthetic-private-error');
      const result = await launchAndCheck(t, 'Press Enter to continue');
      assert.equal(result.keys.length, 1);
      assert.equal(result.warnings.length, 1);
      assert.match(result.warnings[0].join(' '), /Codex.*startup.*operator/i);
      assert.ok(!result.warnings[0].join(' ').includes('synthetic-private-error'));
    });
  }
});

// Exercise actual adapter wiring, including both command construction paths.
describe('Codex launch — daemon isolation', () => {
  for (const exists of [false, true]) {
    for (const supported of [false, true]) {
      it(`selects compatible daemon options (existing tmux: ${exists}, supported: ${supported})`, async () => {
        tmuxSessionExists = exists;
        codexHelp = supported ? '  --no-daemon  Run without the shared background server' : 'Options:\n  --help  Print help';
        const adapter = makeAdapter(CodexAdapter);
        let sent = '';
        adapter.sendMessage = async text => { sent = text; };
        for (const bypassPermissions of [false, true]) {
          calls.execFileSync.length = 0;
          await adapter.launch({ bypassPermissions });
          const command = exists ? sent : readLaunchSpec().args.join(' ');
          if (exists) assert.ok(sent.includes("'/selected codex/it'\\''s/bin/codex'"));
          else {
            assert.equal(readLaunchSpec().command, resolvedCodex);
            assert.notEqual(readLaunchSpec().env.PATH, process.env.PATH);
          }
          assert.equal(command.includes('--no-daemon'), supported);
          assert.equal(command.includes('--dangerously-bypass-approvals-and-sandbox'), bypassPermissions);
          assert.ok(command.includes('System startup trigger, not a user message. Continue with startup context.'));
        }
        const probes = calls.execFileSync.filter(c => c.file === resolvedCodex && c.args[0] === '--help');
        assert.equal(probes.length, 1, 'recheck installed CLI capabilities on each launch');
        assert.equal(probes[0].opts.timeout, 10_000);
      });
    }
    it(`does not launch when capability detection fails (existing tmux: ${exists})`, async () => {
      tmuxSessionExists = exists;
      codexHelpError = new Error('help timed out');
      const adapter = makeAdapter(CodexAdapter);
      let sent = false;
      adapter.sendMessage = async () => { sent = true; };
      await assert.rejects(() => adapter.launch(), /Cannot determine Codex launch options: help timed out/);
      assert.equal(findTmuxNewSession(), undefined);
      assert.equal(sent, false);
    });
  }
});
