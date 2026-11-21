// Switching to Codex rebuilds invalid hook trust in preflight. Trust validation, the trust routine (hook install,
// hooks feature, app-server helper, marker) and the configuration read/write are real, in the isolated HOME and
// ZYLOS_DIR set by the Node test runner. Only the Codex CLI (version and app-server protocol) and the
// authentication probe are stand-ins; each app-server start is counted in a log file.
import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { seedCodexTrustFixture, codexAppServerFixtureSource } from '../../../test/helpers/codex-trust.js';

const root = process.env.ZYLOS_DIR;
const home = process.env.HOME;
const fakeCodex = path.join(home, 'codex-fixture');
const appServerLog = path.join(home, 'app-server-starts');
const appServerFails = path.join(home, 'app-server-fails');
const originalBin = process.env.CODEX_BIN;
process.env.CODEX_BIN = fakeCodex;
after(() => { if (originalBin === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = originalBin; });
fs.writeFileSync(fakeCodex, `#!${process.execPath}
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('codex-fixture'); process.exit(0); }
if (process.argv[2] === 'app-server') {
  fs.appendFileSync(${JSON.stringify(appServerLog)}, 'start\\n');
  if (fs.existsSync(${JSON.stringify(appServerFails)})) { process.stderr.write('fixture app-server unavailable\\n'); process.exit(2); }
}
${codexAppServerFixtureSource()}
`, { mode: 0o700 });

const { executeRuntimeSwitch, runtimeCommand } = await import('../../commands/runtime.js');
const { readZylosConfigStrict } = await import('../config.js');
const { codexTrustMarkerPath, isCodexTrustValid } = await import('../codex-hooks.js');

const appServerStarts = () => fs.existsSync(appServerLog) ? fs.readFileSync(appServerLog, 'utf8').split('\n').filter(Boolean).length : 0;
const calls = [];
const deps = {
  exists: () => true,
  adapter: () => ({ checkAuth: async () => { calls.push({ auth: appServerStarts() }); return { status: 'success' }; } }),
};

beforeEach(() => {
  seedCodexTrustFixture({ root, home });
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Fixture instructions\n');
  fs.mkdirSync(path.join(root, '.zylos'), { recursive: true });
  fs.writeFileSync(path.join(root, '.zylos', 'config.json'), JSON.stringify({ runtime: 'claude' }));
  fs.rmSync(appServerLog, { force: true });
  fs.rmSync(appServerFails, { force: true });
  calls.length = 0;
});

test('valid Codex trust switches without a rebuild', async () => {
  const result = await executeRuntimeSwitch('codex', [], deps);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.result, 'saved');
  assert.equal(appServerStarts(), 0);
  assert.deepEqual(calls, [{ auth: 0 }]);
  assert.equal(readZylosConfigStrict().config.runtime, 'codex');
});

test('invalid Codex trust is rebuilt, then the remaining preflight runs and the runtime is saved', async () => {
  fs.rmSync(codexTrustMarkerPath(root));
  const result = await executeRuntimeSwitch('codex', [], deps);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.result, 'saved');
  assert.deepEqual(calls, [{ auth: 1 }], 'authentication runs after one rebuild');
  assert.equal(isCodexTrustValid({ zylosDir: root, homeDir: home, codexVersion: 'codex-fixture' }).valid, true);
  assert.equal(readZylosConfigStrict().config.runtime, 'codex');
});

test('a failed rebuild rejects the switch with its reason and keeps the configured runtime', async t => {
  fs.rmSync(codexTrustMarkerPath(root));
  fs.writeFileSync(appServerFails, '');
  const stderr = [];
  t.mock.method(console, 'error', (...parts) => { stderr.push(parts.join(' ')); });
  const result = await runtimeCommand(['codex'], { execute: (target, flags) => executeRuntimeSwitch(target, flags, deps) });
  process.exitCode = undefined;
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'HOOKS_NOT_READY');
  assert.match(result.error.message, /^Codex hook trust is invalid \(missing_marker\) and rebuilding it failed: Codex hook trust failed \(.+fixture app-server unavailable/);
  assert.deepEqual(result.error.persisted, []);
  assert.deepEqual(stderr, [`Error [HOOKS_NOT_READY]: ${result.error.message}`]);
  assert.equal(appServerStarts(), 1);
  assert.deepEqual(calls, [], 'authentication is not probed after a failed rebuild');
  assert.equal(readZylosConfigStrict().config.runtime, 'claude');
});
