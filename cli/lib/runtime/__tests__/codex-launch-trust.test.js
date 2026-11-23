import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import * as tmux from '../tmux-connection.js';
import * as configLock from '../../config-lock.js';
import { codexHooksPath, codexTrustMarkerPath, isCodexTrustValid, readHooksState } from '../../runtime/codex/hooks.js';

// Keep the real detector except in tests explicitly exercising the no-lock fallback.
const lockDetection = { detect: configLock.detectConfigLockCapability };
mock.module('../../config-lock.js', { namedExports: {
  ...configLock,
  detectConfigLockCapability: (...args) => lockDetection.detect(...args),
} });
const tmuxBoundary = { code: 'LAUNCH_FAILED', message: 'isolated tmux boundary' };
mock.module('../tmux-connection.js', { namedExports: {
  ...tmux,
  runTmuxCommand: async () => { throw new Error(tmuxBoundary.message); },
} });
const { launchSession } = await import('../launch-flow.js');

const version = 'codex-cli 0.146.0';
const launchArgs = { runtime: 'codex', sessionGroup: null, runId: 'trust-regression', sessionMode: 'single', launchConfig: { runtime: 'codex', mode: 'default' } };

// Longest report: one stderr line (so its tail is plain to predict) and a message, each past its limit.
const LONG_STDERR = Array.from({ length: 120 }, (_, i) => `chunk${String(i).padStart(3, '0')}`).join(' ') + ' api_key=SECRETLONG\n';
const LONG_MESSAGE = Array.from({ length: 60 }, (_, i) => `word${String(i).padStart(2, '0')}`).join(' ');

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
    // A Codex too old to report currentHash lists the hook without it.
    const current = process.env.FAKE_CODEX_FAIL === 'hashless' ? {} : { currentHash: hash };
    reply(msg.id, { data: [{ hooks: [{ key: file + ':session_start:0:0', ...current, isManaged: false }] }] });
  }
  if (msg.method === 'config/batchWrite') {
    if (process.env.FAKE_CODEX_FAIL === '1' || process.env.FAKE_CODEX_FAIL === 'long') {
      fs.unlinkSync(busy); log('failure');
      // Log first, then answer with an error carrying a code, as a refused config write does. 'long' gives the
      // longest report: a message past its 300-character limit and stderr past its 600-character tail.
      const long = process.env.FAKE_CODEX_FAIL === 'long';
      const stderr = long ? ${JSON.stringify(LONG_STDERR)} : 'ERROR config write failed: Operation not permitted (os error 1) api_key=sk-proj-SECRETabcdef123\\n';
      const message = long ? ${JSON.stringify(LONG_MESSAGE)} : 'injected trust failure';
      process.stderr.write(stderr, () => setTimeout(() => reply(msg.id, null, { code: -32603, message }), 50));
      return;
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
  const options = { root, env, runtimeHelp: async () => ' --no-daemon ' };
  return { dir, home, root, manifest, log, env, executable, options,
    events: () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [],
    valid: () => isCodexTrustValid({ zylosDir: root, homeDir: home, codexVersion: version }),
  };
}



function tmuxPreflight(f, check = () => {}) {
  const calls = [];
  f.options.dependencies = {
    openTmuxConnection: async () => {
      check();
      calls.push('open');
      return { close() {} };
    },
    observeSessionTarget: async () => ({ present: false }),
  };
  return calls;
}

test('Codex launch refreshes changed hooks before the tmux launch boundary and skips valid trust', async t => {
  const f = fixture(t);
  const calls = tmuxPreflight(f, () => assert.equal(f.valid().valid, true, 'trust must be current before runtime launch'));
  await assert.rejects(launchSession(launchArgs, f.options), tmuxBoundary);
  const marker = fs.readFileSync(codexTrustMarkerPath(f.root), 'utf8');
  assert.equal(f.events().filter(e => e.event === 'start').length, 1);
  await assert.rejects(launchSession(launchArgs, f.options), tmuxBoundary);
  assert.equal(f.events().filter(e => e.event === 'start').length, 1, 'valid marker skips app-server');
  assert.equal(fs.readFileSync(codexTrustMarkerPath(f.root), 'utf8'), marker);

  const hooks = JSON.parse(fs.readFileSync(codexHooksPath(f.root), 'utf8'));
  hooks.hooks.SessionStart.push({ hooks: [{ type: 'command', command: 'echo new-user-hook' }] });
  fs.writeFileSync(codexHooksPath(f.root), JSON.stringify(hooks));
  assert.equal(f.valid().reason, 'hooks_json_changed');
  await assert.rejects(launchSession(launchArgs, f.options), tmuxBoundary);
  assert.equal(f.events().filter(e => e.event === 'start').length, 2);
  assert.notEqual(fs.readFileSync(codexTrustMarkerPath(f.root), 'utf8'), marker);
  assert.equal(calls.length, 3);
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
import { prepare } from ${JSON.stringify(new URL('../codex/launch.js', import.meta.url).href)};
import { isCodexTrustValid } from ${JSON.stringify(new URL('../../runtime/codex/hooks.js', import.meta.url).href)};
const root = process.argv[2];
await prepare({ root, env: process.env });
assert.equal(isCodexTrustValid({ zylosDir: root, homeDir: process.env.HOME, codexVersion: ${JSON.stringify(version)} }).valid, true);
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
