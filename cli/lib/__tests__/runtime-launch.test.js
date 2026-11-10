import { describe, it, mock, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {writeRecoveryDescriptor} from './helpers/upgrade-descriptor.js';
import { spawnSync as realSpawnSync } from 'node:child_process';
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

const calls = { execSync: [], execFileSync: [], execFile: [] };
let tmuxSessionExists = false;
const resolvedCodex = "/selected codex/it's/bin/codex";
let codexHelp = '  --no-daemon  Run without the shared background server';
let codexHelpError = null;

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
      // The deployed upgrade bootstrap launches its transaction runner; run it for real.
      if (path.basename(String(args?.[0] ?? '')) === 'runner.cjs') return realSpawnSync(file, args, opts);
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
      calls.execFile.push({ file: fnArgs[0], args: Array.isArray(fnArgs[1]) ? [...fnArgs[1]] : [], opts: fnArgs.find(a => a && typeof a === 'object' && !Array.isArray(a)) });
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
  calls.execFile.length = 0;
  tmuxSessionExists = false;
  codexHelp = '  --no-daemon  Run without the shared background server';
  codexHelpError = null;
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

function installStartupResume(root, {resumeFails=true} = {}) {
  const canonicalRoot = fs.realpathSync(root);
  const stable = path.join(root, '.zylos', 'upgrade');
  const transaction = path.join(root, '.backup', 'self-upgrade', 'tx');
  fs.mkdirSync(stable, {recursive:true, mode:0o700});
  fs.mkdirSync(transaction, {recursive:true, mode:0o700});
  for (const [source, target] of [['upgrade-bootstrap.cjs', 'bootstrap.cjs'], ['upgrade-maintenance.cjs', 'maintenance.cjs']]) {
    fs.copyFileSync(path.resolve(import.meta.dirname, '..', source), path.join(stable, target));
    fs.chmodSync(path.join(stable, target), 0o600);
  }
  const files = {
    'runner.cjs': "'use strict'; const fs=require('node:fs'),path=require('node:path'); const dir=process.argv.at(-1),j=JSON.parse(fs.readFileSync(path.join(dir,'journal.json'))); if(j.phase==='installing'&&j.installerStarted===true&&j.installerPid===null) process.exit(9); fs.rmSync(dir,{recursive:true});\n",
    'maintenance.cjs': fs.readFileSync(path.resolve(import.meta.dirname, '..', 'upgrade-maintenance.cjs')),
    'finalizer.cjs': "'use strict';\n",
  };
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(transaction, name), content, {mode:0o600});
  }
  writeRecoveryDescriptor(transaction);
  const digest = 'a'.repeat(64);
  fs.writeFileSync(path.join(transaction, 'journal.json'), JSON.stringify({
    formatVersion:1, transactionId:'tx', zylosDir:canonicalRoot, skillsDir:path.join(canonicalRoot, '.claude/skills'),
    nodePath:process.execPath, phase:'installing', installationIntent:true,
    installerStarted:resumeFails, installerPid:null, installerExitConfirmed:false,
    dbBackupDir:path.join(canonicalRoot, '.backup/db/tx'), snapshotManifestHash:digest,
    coreManifest:[{name:'core', existedBefore:true, backedUp:true, originalHash:digest}], originalServices:[],
    initialIdentity:{nodePath:process.execPath, packageJson:path.join(canonicalRoot, 'package.json'), packageHash:digest,
      cliRoot:path.join(canonicalRoot, 'original-cli'), cliHash:digest, workerPath:path.join(canonicalRoot, 'worker.js'), workerHash:digest,
      ecosystemHash:null, databases:['comm-bridge/c4.db','scheduler/scheduler.db','web-console/web-console.db'].map(source=>({source,exists:true}))},
  }), {mode:0o600});
  return {transaction, cleanup:() => {
    fs.rmSync(path.join(root, '.backup'), {recursive:true, force:true});
    fs.rmSync(stable, {recursive:true, force:true});
  }};
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
    it(`${Cls.name} launches without a generation file or generation environment`, async () => {
      tmuxSessionExists = false;
      const adapter = makeAdapter(Cls);
      await adapter.launch();
      assert.equal(fs.existsSync(path.join(fakeZylosDir, 'activity-monitor/runtime-generation.json')), false);
      assert.equal(readLaunchSpec().env.ZYLOS_RUNTIME_GENERATION, undefined);
      tmuxSessionExists = true;
      let sent;
      adapter.sendMessage = async command => { sent = command; };
      await adapter.launch();
      assert.equal(fs.existsSync(path.join(fakeZylosDir, 'activity-monitor/runtime-generation.json')), false);
      assert.equal(sent.includes('ZYLOS_RUNTIME_GENERATION'), false);
    });
  }
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

describe('Claude launch — relay credentials from .env', () => {
  it('spec.env carries ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN from .env (#1130)', async () => {
    tmuxSessionExists = false;
    const dotenvPath = path.join(fakeZylosDir, '.env');
    const original = fs.readFileSync(dotenvPath, 'utf8');
    const authNames = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL'];
    const saved = Object.fromEntries(authNames.map(name => [name, process.env[name]]));
    for (const name of authNames) delete process.env[name];
    fs.writeFileSync(dotenvPath, [
      'ANTHROPIC_BASE_URL=https://relay.example.test',
      'ANTHROPIC_AUTH_TOKEN=relay-bearer-test',
    ].join('\n'));
    try {
      await makeAdapter(ClaudeAdapter).launch({ bypassPermissions: false });
      const env = readSpecEnv();
      assert.ok(env, 'spec should be written');
      assert.equal(env.ANTHROPIC_BASE_URL, 'https://relay.example.test');
      assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'relay-bearer-test');
    } finally {
      fs.writeFileSync(dotenvPath, original);
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});

describe('Claude launch — non-credential passthrough from .env', () => {
  const NAME = 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC';
  const credentialNames = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'];

  async function launchWith(dotenv, { nativeAuth = false } = {}) {
    tmuxSessionExists = false;
    calls.execFileSync.length = 0; // readSpecEnv() reads the first tmux new-session call
    const dotenvPath = path.join(fakeZylosDir, '.env');
    const original = fs.readFileSync(dotenvPath, 'utf8');
    const names = [NAME, ...credentialNames, 'ANTHROPIC_BASE_URL'];
    const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
    for (const name of names) delete process.env[name];
    const credFile = path.join(fakeHome, '.claude', '.credentials.json');
    if (nativeAuth) fs.writeFileSync(credFile, JSON.stringify({ claudeAiOauth: { refreshToken: 'fake-refresh-token' } }));
    fs.writeFileSync(dotenvPath, dotenv);
    try {
      await makeAdapter(ClaudeAdapter).launch({ bypassPermissions: false });
      const env = readSpecEnv();
      assert.ok(env, 'spec should be written');
      return env;
    } finally {
      if (nativeAuth) fs.unlinkSync(credFile);
      fs.writeFileSync(dotenvPath, original);
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }

  it('spec.env carries CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC only when .env sets it', async () => {
    const relay = 'ANTHROPIC_BASE_URL=https://relay.example.test\nANTHROPIC_AUTH_TOKEN=relay-bearer-test\n';
    assert.equal((await launchWith(relay + `${NAME}=1\n`))[NAME], '1');
    assert.equal((await launchWith(`${NAME}=1\n`, { nativeAuth: true }))[NAME], '1', 'carried with native auth too');
    assert.equal((await launchWith(relay))[NAME], undefined);
  });

  it('a .env with only CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC injects or approves no credential', async () => {
    const approved = () => {
      try { return JSON.parse(fs.readFileSync(path.join(fakeHome, '.claude.json'), 'utf8')).customApiKeyResponses?.approved ?? []; }
      catch { return []; }
    };
    const before = approved();
    const env = await launchWith(`${NAME}=1\n`);
    assert.equal(env[NAME], '1');
    for (const name of credentialNames) assert.equal(env[name], undefined, `${name} must not be set`);
    assert.deepEqual(approved(), before, 'the setting must not be approved as an API key');
  });
});

describe('Claude launch — built-in passthrough from .env', () => {
  // Runtime auth variables set in .env reach the new session without any
  // runtime-env.manifest line, and the auth probe sees the same values.
  const builtinKeys = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'OPENAI_BASE_URL', 'OPENAI_API_KEY'];
  const cases = {
    relay: { ANTHROPIC_BASE_URL: 'https://relay.example.test', ANTHROPIC_AUTH_TOKEN: 'synthetic-relay-token', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
    'API key': { ANTHROPIC_API_KEY: 'sk-ant-synthetic-builtin-key' },
    'setup token': { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-synthetic-setup-token' },
  };
  const manifestPath = path.join(fakeZylosDir, '.zylos', 'runtime-env.manifest');

  async function launchAndProbe(dotenv, { compat = false, nativeAuth = false } = {}) {
    tmuxSessionExists = false;
    calls.execFileSync.length = 0;
    calls.execFile.length = 0;
    const dotenvPath = path.join(fakeZylosDir, '.env');
    const original = fs.readFileSync(dotenvPath, 'utf8');
    const saved = Object.fromEntries(builtinKeys.map(name => [name, process.env[name]]));
    for (const name of builtinKeys) delete process.env[name];
    process.env.ANTHROPIC_BASE_URL = 'https://stale-process.example.test';
    const credFile = path.join(fakeHome, '.claude', '.credentials.json');
    if (nativeAuth) fs.writeFileSync(credFile, JSON.stringify({ claudeAiOauth: { refreshToken: 'fake-refresh-token' } }));
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, '');
    fs.writeFileSync(dotenvPath, (compat ? 'ZYLOS_CLEAN_ENV=false\n' : '')
      + Object.entries(dotenv).map(([key, value]) => `${key}=${value}\n`).join(''));
    try {
      const adapter = makeAdapter(ClaudeAdapter);
      await adapter.launch({ bypassPermissions: false });
      const session = readSpecEnv();
      assert.ok(session, 'spec should be written');
      await adapter.checkAuth();
      const probeCall = calls.execFile.find(c => c.args[0] === '-p');
      assert.ok(probeCall, 'probe should run');
      const probe = probeCall.opts.env;
      for (const key of builtinKeys) assert.equal(session[key], probe[key], `session and probe agree on ${key}`);
      return { session, probe };
    } finally {
      if (nativeAuth) fs.unlinkSync(credFile);
      fs.rmSync(manifestPath, { force: true });
      fs.writeFileSync(dotenvPath, original);
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }

  for (const compat of [false, true]) for (const [name, dotenv] of Object.entries(cases)) {
    it(`${name} credentials only in .env reach session and probe with an empty manifest (${compat ? 'compat' : 'clean'} env)`, async () => {
      const { session, probe } = await launchAndProbe(dotenv, { compat });
      for (const [key, value] of Object.entries(dotenv)) {
        assert.equal(session[key], value, `session ${key}`);
        assert.equal(probe[key], value, `probe ${key}`);
      }
      if (!dotenv.ANTHROPIC_BASE_URL) assert.equal(session.ANTHROPIC_BASE_URL, compat ? 'https://stale-process.example.test' : undefined);
    });
  }

  it('subscription login keeps API key and setup token out of session and probe', async () => {
    const { session, probe } = await launchAndProbe({ ...cases.relay, ...cases['API key'], ...cases['setup token'] }, { nativeAuth: true });
    for (const env of [session, probe]) {
      assert.equal(env.ANTHROPIC_API_KEY, undefined);
      assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
      assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
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
  it('keeps the recovery prompt after automatic resume fails without concatenating undefined', async t => {
    const {cleanup} = installStartupResume(fakeZylosDir);
    t.after(cleanup);
    tmuxSessionExists = false;
    await makeAdapter(CodexAdapter).launch({bypassPermissions:false});
    const prompt = readLaunchSpec().args.at(-1);
    assert.match(prompt, /SYSTEM RECOVERY TASK/);
    assert.match(prompt, /tx/);
    assert.doesNotMatch(prompt, /undefined/);
  });

  it('keeps only the kick prompt after automatic resume succeeds',{skip:process.platform==='darwin'},async t=>{
    const {cleanup,transaction}=installStartupResume(fakeZylosDir,{resumeFails:false});
    t.after(cleanup);
    tmuxSessionExists=false;
    await makeAdapter(CodexAdapter).launch({bypassPermissions:false});
    assert.equal(readLaunchSpec().args.at(-1),
      'System startup trigger, not a user message. Continue with startup context.');
    assert.equal(fs.existsSync(transaction),false);
  });

  it('adds no recovery text or undefined when no transaction exists', async () => {
    tmuxSessionExists = false;
    await makeAdapter(CodexAdapter).launch({bypassPermissions:false});
    assert.equal(readLaunchSpec().args.at(-1),
      'System startup trigger, not a user message. Continue with startup context.');
    assert.doesNotMatch(readLaunchSpec().args.at(-1), /undefined/);
  });

  it('includes unmarked historical recovery in the launch prompt', async t => {
    const stable = path.join(fakeZylosDir, '.zylos', 'upgrade');
    const transaction = path.join(fakeZylosDir, '.backup', 'self-upgrade', 'tx');
    fs.mkdirSync(stable, {recursive:true, mode:0o700});
    fs.mkdirSync(transaction, {recursive:true, mode:0o700});
    fs.writeFileSync(path.join(stable, 'maintenance.cjs'), "'use strict';\n", {mode:0o600});
    fs.writeFileSync(path.join(stable, 'bootstrap.cjs'), `
      exports.bootstrap = () => ({active:true, blocked:true, prompt:'historical recovery prompt'});
    `, {mode:0o600});
    t.after(() => {
      fs.rmSync(path.join(fakeZylosDir, '.backup'), {recursive:true, force:true});
      fs.rmSync(stable, {recursive:true, force:true});
    });

    tmuxSessionExists = false;
    await makeAdapter(CodexAdapter).launch({bypassPermissions:false});
    assert.match(readLaunchSpec().args.at(-1), /historical recovery prompt/);
  });

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

describe('Codex launch — built-in passthrough from .env', () => {
  // OPENAI_BASE_URL / OPENAI_API_KEY set in .env reach the new Codex session
  // without any runtime-env.manifest line, and the Codex auth probe sees the same values.
  const builtinKeys = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'OPENAI_BASE_URL', 'OPENAI_API_KEY'];
  const dotenv = { OPENAI_BASE_URL: 'https://openai-relay.example.test/v1', OPENAI_API_KEY: 'sk-synthetic-openai-key' };
  const manifestPath = path.join(fakeZylosDir, '.zylos', 'runtime-env.manifest');

  for (const compat of [false, true]) {
    it(`OpenAI variables only in .env reach session and probe with an empty manifest (${compat ? 'compat' : 'clean'} env)`, async () => {
      tmuxSessionExists = false;
      calls.execFileSync.length = 0;
      calls.execFile.length = 0;
      const dotenvPath = path.join(fakeZylosDir, '.env');
      const original = fs.readFileSync(dotenvPath, 'utf8');
      const saved = Object.fromEntries(builtinKeys.map(name => [name, process.env[name]]));
      for (const name of builtinKeys) delete process.env[name];
      process.env.OPENAI_BASE_URL = 'https://stale-process.example.test/v1';
      fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
      fs.writeFileSync(manifestPath, '');
      fs.writeFileSync(dotenvPath, (compat ? 'ZYLOS_CLEAN_ENV=false\n' : '')
        + Object.entries(dotenv).map(([key, value]) => `${key}=${value}\n`).join(''));
      try {
        const adapter = makeAdapter(CodexAdapter);
        await adapter.launch({ bypassPermissions: false });
        const session = readSpecEnv();
        assert.ok(session, 'spec should be written');
        await adapter.checkAuth();
        const probeCall = calls.execFile.find(c => c.args[0] === 'login' && c.args[1] === 'status');
        assert.ok(probeCall, 'codex login status should run');
        const probe = probeCall.opts.env;
        for (const [key, value] of Object.entries(dotenv)) {
          assert.equal(session[key], value, `session ${key}`);
          assert.equal(probe[key], value, `probe ${key}`);
        }
        for (const key of builtinKeys) assert.equal(session[key], probe[key], `session and probe agree on ${key}`);
      } finally {
        fs.rmSync(manifestPath, { force: true });
        fs.writeFileSync(dotenvPath, original);
        for (const [name, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }
    });
  }
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
    // shell-quoted argv carrying the full contract text.
    assert.ok(sent.includes(
      "'System startup trigger, not a user message. Continue with startup context.'"),
    'existing-session command must carry the exact kick as one quoted argv');
    assert.ok(!sent.includes('_p=$(cat'), 'existing-session command should not load bootstrap prompt');
    assert.ok(!sent.includes('session-start-inject.js'), 'existing-session command should not run text bootstrap');
  });
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
