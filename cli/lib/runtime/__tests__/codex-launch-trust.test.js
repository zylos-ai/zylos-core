import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { SessionAdapter } from '../session-adapter.js';
import * as configLock from '../../config-lock.js';
import { launchEnvironment } from '../session-command.js';
import { codexHooksPath, codexTrustMarkerPath, isCodexTrustValid, readHooksState } from '../../codex-hooks.js';

// Keep the real detector except in tests explicitly exercising the no-lock fallback.
const lockDetection = { detect: configLock.detectConfigLockCapability };
mock.module('../../config-lock.js', { namedExports: {
  ...configLock,
  detectConfigLockCapability: (...args) => lockDetection.detect(...args),
} });
const { CodexAdapter } = await import('../codex.js');

const version = 'codex-cli 0.146.0';
const launchArgs = { sessionGroup: null, runId: 'trust-regression', sessionMode: 'single', launchConfig: { runtime: 'codex', mode: 'default' } };

function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-launch-trust-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home');
  const root = path.join(dir, 'zylos');
  fs.mkdirSync(home);
  fs.mkdirSync(root);
  const manifest = path.join(root, '.zylos', 'runtime-env.manifest');
  fs.mkdirSync(path.dirname(manifest));
  fs.writeFileSync(manifest, 'inherit FAKE_CODEX_LOG\ninherit FAKE_CODEX_FAIL\ninherit CODEX_HOME\n');
  const log = path.join(dir, 'app-server.jsonl');
  const executable = path.join(dir, 'codex.mjs');
  // This fixture implements only the app-server trust protocol. The real trust
  // helper performs all installation, feature, marker and validity operations.
  fs.writeFileSync(executable, `#!${process.execPath}
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { parse, stringify } from ${JSON.stringify(import.meta.resolve('smol-toml'))};
if (process.argv[2] === '--version') { console.log(${JSON.stringify(version)}); process.exit(0); }
if (process.argv[2] !== 'app-server') process.exit(2);
const home = process.env.CODEX_HOME || path.join(process.env.HOME, '.codex');
const configPath = path.join(home, 'config.toml');
const busy = path.join(home, 'fake-app-server.busy');
try { fs.closeSync(fs.openSync(busy, 'wx')); }
catch { console.error('overlapping app-server trust transaction'); process.exit(3); }
const log = event => fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ event, cwd: process.cwd(), home: process.env.HOME, codexHome: home }) + '\\n');
log('start');
// Capture a full-file snapshot early: without the production lock, two writers
// would both read stale data and overwrite one another's additions.
const config = parse(fs.readFileSync(configPath, 'utf8'));
const reply = (id, result, error) => console.log(JSON.stringify({ id, result, error }));
readline.createInterface({ input: process.stdin }).on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') reply(msg.id, {});
  if (msg.method === 'hooks/list') {
    const file = path.join(process.cwd(), '.codex', 'hooks.json');
    const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    reply(msg.id, { data: [{ hooks: [{ key: file + ':session_start:0:0', currentHash: hash, isManaged: false }] }] });
  }
  if (msg.method === 'config/batchWrite') {
    if (process.env.FAKE_CODEX_FAIL === '1') {
      fs.unlinkSync(busy); log('failure'); reply(msg.id, null, { message: 'injected trust failure' }); return;
    }
    setTimeout(() => {
      config.hooks ||= {}; config.hooks.state ||= {};
      Object.assign(config.hooks.state, msg.params.edits[0].value);
      fs.writeFileSync(configPath, stringify(config));
      fs.unlinkSync(busy); log('end'); reply(msg.id, { status: 'ok' });
    }, 150);
  }
});
`, { mode: 0o700 });
  const env = { ...process.env, HOME: home, ZYLOS_DIR: root, CODEX_BIN: executable, FAKE_CODEX_LOG: log };
  delete env.CODEX_HOME;
  delete env.FAKE_CODEX_FAIL;
  const adapter = new CodexAdapter({ root, env });
  return { dir, home, root, manifest, log, env, executable, adapter,
    events: () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [],
    valid: () => isCodexTrustValid({ zylosDir: root, homeDir: home, codexVersion: version }),
  };
}

function baseLaunch(t, check = () => {}) {
  const calls = [];
  t.mock.method(SessionAdapter.prototype, 'launch', async function (args) {
    check(this); calls.push(args); return { started: true };
  });
  return calls;
}

test('Codex launch refreshes changed hooks before the tmux launch boundary and skips valid trust', async t => {
  const f = fixture(t);
  const calls = baseLaunch(t, () => assert.equal(f.valid().valid, true, 'trust must be current before runtime launch'));
  await f.adapter.launch(launchArgs);
  const marker = fs.readFileSync(codexTrustMarkerPath(f.root), 'utf8');
  assert.equal(f.events().filter(e => e.event === 'start').length, 1);
  await f.adapter.launch(launchArgs);
  assert.equal(f.events().filter(e => e.event === 'start').length, 1, 'valid marker skips app-server');
  assert.equal(fs.readFileSync(codexTrustMarkerPath(f.root), 'utf8'), marker);

  const hooks = JSON.parse(fs.readFileSync(codexHooksPath(f.root), 'utf8'));
  hooks.hooks.SessionStart.push({ hooks: [{ type: 'command', command: 'echo new-user-hook' }] });
  fs.writeFileSync(codexHooksPath(f.root), JSON.stringify(hooks));
  assert.equal(f.valid().reason, 'hooks_json_changed');
  await f.adapter.launch(launchArgs);
  assert.equal(f.events().filter(e => e.event === 'start').length, 2);
  assert.notEqual(fs.readFileSync(codexTrustMarkerPath(f.root), 'utf8'), marker);
  assert.equal(calls.length, 3);
});

test('Codex trust failure rejects launch before any tmux/runtime launch', async t => {
  const f = fixture(t);
  const calls = baseLaunch(t);
  f.env.FAKE_CODEX_FAIL = '1';
  await assert.rejects(f.adapter.launch(launchArgs), error => {
    assert.equal(error.code, 'LAUNCH_FAILED');
    assert.match(error.message, /trust failed/i);
    assert.ok(error.cause instanceof Error);
    return true;
  });
  assert.equal(calls.length, 0);
  assert.equal(fs.existsSync(codexTrustMarkerPath(f.root)), false);
  assert.deepEqual(f.events().map(e => e.event), ['start', 'failure']);
  delete f.env.FAKE_CODEX_FAIL;
  await f.adapter.launch(launchArgs);
  assert.equal(calls.length, 1, 'a subsequent launch can retry after a trust failure');
  assert.equal(f.valid().valid, true);
  assert.deepEqual(f.events().map(e => e.event), ['start', 'failure', 'start', 'end']);
});

test('Codex trust uses the launch environment and custom CODEX_HOME without writing default home config', async t => {
  const f = fixture(t);
  const calls = baseLaunch(t);
  f.env.CODEX_HOME = path.join(f.dir, 'custom-codex');
  await f.adapter.launch(launchArgs);
  assert.equal(calls.length, 1);
  assert.ok(Object.keys(readHooksState(path.join(f.env.CODEX_HOME, 'config.toml'))).length > 0);
  assert.equal(fs.existsSync(path.join(f.home, '.codex', 'config.toml')), false);
  assert.equal(f.events()[0].home, f.home);
  assert.equal(f.events()[0].codexHome, f.env.CODEX_HOME);
  await f.adapter.launch(launchArgs);
  assert.equal(f.events().filter(e => e.event === 'start').length, 1);
});

test('Codex launch ignores raw CODEX_HOME when runtime environment policy strips it', async t => {
  const f = fixture(t);
  const calls = baseLaunch(t);
  fs.writeFileSync(f.manifest, 'inherit FAKE_CODEX_LOG\ninherit FAKE_CODEX_FAIL\n');
  f.env.CODEX_HOME = path.join(f.dir, 'stripped-codex');
  await f.adapter.launch(launchArgs);
  assert.equal(calls.length, 1);
  assert.equal(f.valid().valid, true);
  assert.equal(fs.existsSync(f.env.CODEX_HOME), false);
  assert.equal(f.events()[0].codexHome, path.join(f.home, '.codex'));
});

test('Codex launch trusts CODEX_HOME selected by the runtime dotenv policy', async t => {
  const f = fixture(t);
  const calls = baseLaunch(t);
  f.env.CODEX_HOME = path.join(f.dir, 'raw-codex');
  const effectiveHome = path.join(f.dir, 'effective-codex');
  fs.writeFileSync(path.join(f.root, '.env'), `ZYLOS_TMUX_ENV=CODEX_HOME\nCODEX_HOME=${effectiveHome}\n`);
  await f.adapter.launch(launchArgs);
  assert.equal(calls.length, 1);
  assert.equal(fs.existsSync(f.env.CODEX_HOME), false);
  assert.equal(fs.existsSync(path.join(f.home, '.codex', 'config.toml')), false);
  assert.equal(f.events()[0].codexHome, effectiveHome);
  assert.ok(Object.keys(readHooksState(path.join(effectiveHome, 'config.toml'))).length > 0);
  await f.adapter.launch(launchArgs);
  assert.equal(f.events().filter(e => e.event === 'start').length, 1);
});

function runChild(file, env, root) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, root], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let diagnostic = '';
    child.stdout.on('data', data => { diagnostic += data; });
    child.stderr.on('data', data => { diagnostic += data; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`launch child exited ${code}: ${diagnostic}`)));
  });
}

test('independent Codex launch processes sharing one home serialize and preserve both trust snapshots', async t => {
  const f = fixture(t);
  const secondRoot = path.join(f.dir, 'second-zylos');
  fs.mkdirSync(secondRoot);
  fs.mkdirSync(path.join(secondRoot, '.zylos'));
  fs.copyFileSync(f.manifest, path.join(secondRoot, '.zylos', 'runtime-env.manifest'));
  const runner = path.join(f.dir, 'launch.mjs');
  fs.writeFileSync(runner, `import assert from 'node:assert/strict';
import { CodexAdapter } from ${JSON.stringify(new URL('../codex.js', import.meta.url).href)};
import { SessionAdapter } from ${JSON.stringify(new URL('../session-adapter.js', import.meta.url).href)};
import { isCodexTrustValid } from ${JSON.stringify(new URL('../../codex-hooks.js', import.meta.url).href)};
const root = process.argv[2];
SessionAdapter.prototype.launch = async () => {
  assert.equal(isCodexTrustValid({ zylosDir: root, homeDir: process.env.HOME, codexVersion: ${JSON.stringify(version)} }).valid, true);
};
await new CodexAdapter({ root, env: process.env }).launch(${JSON.stringify(launchArgs)});
`);
  // Two groups of one instance plus another instance share the global config.
  // The second group must recheck the marker after acquiring the same lock.
  await Promise.all([runChild(runner, f.env, f.root), runChild(runner, f.env, f.root), runChild(runner, f.env, secondRoot)]);
  assert.deepEqual(f.events().map(e => e.event), ['start', 'end', 'start', 'end']);
  assert.deepEqual(new Set(f.events().filter(e => e.event === 'start').map(e => e.cwd)), new Set([f.root, secondRoot]));
  for (const root of [f.root, secondRoot]) {
    assert.equal(isCodexTrustValid({ zylosDir: root, homeDir: f.home, codexVersion: version }).valid, true);
  }
  assert.equal(Object.keys(readHooksState(path.join(f.home, '.codex', 'config.toml'))).length, 2);
});

test('Codex launch refreshes trust when neither flock nor perl is available', async t => {
  const f = fixture(t);
  const detect = t.mock.method(lockDetection, 'detect', () => null);
  fs.writeFileSync(path.join(f.root, '.env'), 'ZYLOS_CLEAN_ENV=false\n');
  const env = launchEnvironment(f.root, f.env);
  const warnings = [];
  t.mock.method(process.stderr, 'write', chunk => { warnings.push(String(chunk)); return true; });
  const calls = baseLaunch(t, () => assert.equal(f.valid().valid, true));
  await f.adapter.launch(launchArgs);
  assert.equal(detect.mock.callCount(), 1, 'adapter must consume the injected no-lock capability');
  assert.equal(detect.mock.calls[0].result, null);
  assert.deepEqual(detect.mock.calls[0].arguments[0].env, env);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Warning: Codex hook trust lock unavailable.*without concurrency protection/);
  assert.equal(calls.length, 1);
  assert.deepEqual(f.events().map(e => e.event), ['start', 'end']);
  assert.equal(fs.existsSync(path.join(f.home, '.codex', 'zylos-hooks-trust.lock')), false);
});

test('Codex rejects failed trust without lock capability before runtime launch', async t => {
  const f = fixture(t);
  const detect = t.mock.method(lockDetection, 'detect', () => null);
  f.env.FAKE_CODEX_FAIL = '1';
  fs.writeFileSync(path.join(f.root, '.env'), 'ZYLOS_CLEAN_ENV=false\n');
  const env = launchEnvironment(f.root, f.env);
  const warnings = [];
  t.mock.method(process.stderr, 'write', chunk => { warnings.push(String(chunk)); return true; });
  const calls = baseLaunch(t);
  await assert.rejects(f.adapter.launch(launchArgs), error => {
    assert.equal(error.code, 'LAUNCH_FAILED');
    assert.match(error.message, /trust failed/i);
    assert.ok(error.cause instanceof Error);
    return true;
  });
  assert.equal(calls.length, 0, 'failed unlocked worker must not enter runtime launch');
  assert.deepEqual(f.events().map(e => e.event), ['start', 'failure']);
  assert.equal(fs.existsSync(codexTrustMarkerPath(f.root)), false);
  assert.equal(fs.existsSync(path.join(f.home, '.codex', 'zylos-hooks-trust.lock')), false);
  assert.equal(detect.mock.callCount(), 1, 'adapter must consume the injected no-lock capability');
  assert.equal(detect.mock.calls[0].result, null);
  assert.deepEqual(detect.mock.calls[0].arguments[0].env, env);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Warning: Codex hook trust lock unavailable/);
});

test('Codex trust worker leaves the parent event loop responsive and environment unchanged', async t => {
  const f = fixture(t);
  const parentEnv = { HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME };
  const calls = baseLaunch(t);
  let observedPendingTrust = false;
  const timer = setInterval(() => {
    const events = f.events().map(e => e.event);
    if (events.includes('start') && !events.includes('end')) {
      observedPendingTrust = true;
      assert.equal(calls.length, 0, 'runtime launch waits until trust completes');
      assert.deepEqual({ HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME }, parentEnv);
    }
  }, 5);
  t.after(() => clearInterval(timer));
  await f.adapter.launch(launchArgs);
  clearInterval(timer);
  assert.equal(observedPendingTrust, true, 'parent must run while app-server trust is pending');
  assert.equal(calls.length, 1);
  assert.deepEqual({ HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME }, parentEnv);
  assert.equal(f.valid().valid, true);
});
