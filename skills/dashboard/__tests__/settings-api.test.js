import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as childProcess from 'node:child_process';
import { promisify } from 'node:util';
import { StateEngine } from '../src/lib/state-engine.js';
import { EventLoopMonitor } from '../src/lib/event-loop-monitor.js';
import { VersionChecker } from '../src/lib/version-checker.js';
import { CoreState } from '../src/lib/core-state.js';
import { PM2Collector } from '../src/lib/collectors/pm2-collector.js';
import { mutateConfig, withConfigLock } from '../src/lib/config-mutation.js';
import { Store } from '../src/lib/store.js';
import { C4Reader } from '../src/lib/c4-reader.js';
import { hashApiKey, exchangeApiKeyForToken } from '../src/lib/auth.js';

const fetch = (url, options = {}) => globalThis.fetch(url, { ...options, signal: AbortSignal.timeout(3000) });
import { CodexRolloutCollector } from '../src/lib/collectors/codex-rollout-collector.js';
import { StatuslineCollector } from '../src/lib/collectors/statusline-collector.js';
import {
  DEFAULT_CODEX_MODEL_PRICES,
  DEFAULT_CODEX_PRIORITY_MODEL_PRICES,
  DEFAULT_RUNTIME_MODEL_PRICES,
  loadConfig,
  modelPricesForRuntime
} from '../src/lib/config.js';

function makeTmpConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-test-'));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    port: 3470,
    auth: { enabled: true, password: 'scrypt:secret' },
    modelPrices: {
      'claude-opus-4': { input: 5, output: 25, cacheRead: 0.50, cacheCreation: 10 },
      'claude-sonnet-4': { input: 3, output: 15, cacheRead: 0.30, cacheCreation: 6 },
      'claude-haiku-4': { input: 1, output: 5, cacheRead: 0.10, cacheCreation: 2 }
    },
    runtimeFastModeMultipliers: { claude: 6 },
    fastModeMultiplier: 6,
    retention: { metrics: 'full' }
  }));
  return { dir, configPath };
}

function withTmpZylosConfig(configBody, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-zylos-'));
  const dashboardDir = path.join(dir, 'components', 'dashboard');
  fs.mkdirSync(dashboardDir, { recursive: true });
  const configPath = path.join(dashboardDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(configBody, null, 2) + '\n');
  const previous = process.env.ZYLOS_DIR;
  process.env.ZYLOS_DIR = dir;
  try {
    return fn({ dir, configPath });
  } finally {
    if (previous === undefined) delete process.env.ZYLOS_DIR;
    else process.env.ZYLOS_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function parseConfigFile(configPath) {
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

// HTTP integration boundary: actual settings, override and pricing routes with a
// private dashboard database and random loopback listener. Run for these routes or
// config persistence changes; skip unrelated UI-only edits. The runner must supply
// private HOME/ZYLOS_DIR/PM2_HOME, short TMPDIR and a private tmux namespace.
// CLI/version/Core activity is replaced BEFORE import; no live daemon or network
// starts. Requests are bounded to 3s. Cleanup is registered before import, closes
// listener/connections, all owned timers and database, then only this fixture root.
async function makeSettingsServer(t, runtime = 'claude', configBody = {}, runCli) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-server-'));
  const previous = process.env.ZYLOS_DIR;
  let server, engine, ownedStore, reader, statusline, mutations = 0, closed = false;
  const timers = [], originalInterval = globalThis.setInterval;
  const close = async () => {
    if (closed) return;
    closed = true;
    server?.closeAllConnections();
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    for (const timer of timers) clearInterval(timer);
    engine?.stopSnapshotTimer();
    reader?.close();
    ownedStore?.close();
    if (previous === undefined) delete process.env.ZYLOS_DIR;
    else process.env.ZYLOS_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  };
  t.after(close);
  t.mock.method(globalThis, 'setInterval', (...args) => {
    const timer = originalInterval(...args); timers.push(timer); return timer;
  });
  t.mock.method(EventLoopMonitor.prototype, 'start', function () { return this; });
  t.mock.method(VersionChecker.prototype, 'start', () => {});
  t.mock.method(CoreState.prototype, 'refresh', async () => {});
  const cliResult = async (file, args, options) => {
    assert.ok(runCli, 'Unexpected CLI invocation');
    const data = await runCli(file, args, options);
    return { stdout: typeof data === 'string' ? data : JSON.stringify(data), stderr: '' };
  };
  const fakeExecFile = (file, args, options, callback) => {
    cliResult(file, args, options).then(({ stdout, stderr }) => callback(null, stdout, stderr), error => callback(error));
  };
  fakeExecFile[promisify.custom] = cliResult;
  t.mock.module('node:child_process', { namedExports: { ...childProcess,
    execFileSync: () => '1.0.0', execFile: fakeExecFile,
  } });
  t.mock.module('../src/lib/store.js', { namedExports: {
    Store: class extends Store { constructor(...args) { super(...args); ownedStore = this; } },
  } });
  t.mock.module('../src/lib/c4-reader.js', { namedExports: {
    C4Reader: class extends C4Reader { constructor(...args) { super(...args); reader = this; } },
  } });
  t.mock.module('../src/lib/state-engine.js', { namedExports: {
    StateEngine: class extends StateEngine { constructor(...args) { super(...args); engine = this; } },
  } });
  t.mock.module('../src/lib/collectors/statusline-collector.js', { namedExports: {
    StatuslineCollector: class extends StatuslineCollector { constructor(...args) { super(...args); statusline = this; } },
  } });
  t.mock.module('../src/lib/config-mutation.js', { namedExports: {
    mutateConfig: (...args) => { mutations++; return mutateConfig(...args); },
    withConfigLock,
  } });
  fs.mkdirSync(path.join(dir, '.zylos'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.zylos', 'config.json'), JSON.stringify({ runtime }));
  const dashboardDir = path.join(dir, 'components', 'dashboard');
  fs.mkdirSync(dashboardDir, { recursive: true });
  const configPath = path.join(dashboardDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ auth: { enabled: false }, ...configBody }));
  process.env.ZYLOS_DIR = dir;
  const { createServer } = await import(`../src/index.js?settings=${Date.now()}-${Math.random()}`);
  server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  assert.equal(server.address().address, '127.0.0.1');
  assert.ok(engine.store.db.name.startsWith(dir + path.sep));
  return { dir, configPath, store: engine.store, config: engine._config, statusline,
    mutations: () => mutations, origin: `http://127.0.0.1:${server.address().port}`, close };
}

// HTTP integration via makeSettingsServer: actual route/config persistence;
// run when this behavior changes, skip presentation-only changes. Private
// runner roots + mock-before-import CLI, bounded fetch, owned cleanup as above.
test('PUT /api/settings rejects non-object bodies without changing config', async t => {
  const server = await makeSettingsServer(t);
  const before = fs.readFileSync(server.configPath, 'utf8');
  for (const body of [null, [], 'hello']) {
    const response = await fetch(server.origin + '/api/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal(response.status, 400);
  }
  assert.equal(fs.readFileSync(server.configPath, 'utf8'), before);
  assert.equal(server.mutations(), 0);
});

test('settings validation: rejects negative prices', () => {
  const prices = { 'claude-opus-4': { input: -5, output: 25, cacheRead: 0.50, cacheCreation: 10 } };
  const errors = validateModelPrices(prices);
  assert.ok(errors.some(e => e.includes('input') && e.includes('>= 0')));
});

test('settings validation: rejects NaN prices', () => {
  const prices = { 'claude-opus-4': { input: NaN, output: 25, cacheRead: 0.50, cacheCreation: 10 } };
  const errors = validateModelPrices(prices);
  assert.ok(errors.some(e => e.includes('input')));
});

test('settings validation: rejects empty prefix', () => {
  const prices = { '': { input: 5, output: 25, cacheRead: 0.50, cacheCreation: 10 } };
  const errors = validateModelPrices(prices);
  assert.ok(errors.some(e => e.includes('non-empty')));
});

test('settings validation: rejects missing built-in model', () => {
  const prices = {
    'claude-opus-4': { input: 5, output: 25, cacheRead: 0.50, cacheCreation: 10 },
    'claude-haiku-4': { input: 1, output: 5, cacheRead: 0.10, cacheCreation: 2 }
  };
  const errors = validateModelPrices(prices);
  assert.ok(errors.some(e => e.includes('claude-sonnet-4')));
});

test('settings validation: uses Codex built-ins for Codex runtime', () => {
  const prices = { ...DEFAULT_CODEX_MODEL_PRICES };
  delete prices['gpt-5.5'];
  const errors = validateModelPrices(prices, 'codex');
  assert.ok(errors.some(e => e.includes('gpt-5.5')));
  assert.ok(!errors.some(e => e.includes('claude-sonnet-4')));
});

test('settings validation: accepts valid prices', () => {
  const prices = {
    ...DEFAULT_RUNTIME_MODEL_PRICES.claude,
    'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25, cacheCreation: 20 },
    'claude-fable-5': { input: 10, output: 50, cacheRead: 1.00, cacheCreation: 20 },
    'claude-opus-5': { input: 5, output: 25, cacheRead: 0.50, cacheCreation: 10 },
    'claude-opus-4': { input: 5, output: 25, cacheRead: 0.50, cacheCreation: 10 },
    'claude-sonnet-5': { input: 3, output: 15, cacheRead: 0.30, cacheCreation: 6 },
    'claude-sonnet-4': { input: 3, output: 15, cacheRead: 0.30, cacheCreation: 6 },
    'claude-haiku-4': { input: 1, output: 5, cacheRead: 0.10, cacheCreation: 2 },
    'claude-new-model': { input: 2, output: 10, cacheRead: 0.20, cacheCreation: 4 }
  };
  const errors = validateModelPrices(prices);
  assert.equal(errors.length, 0);
});

test('settings validation: rejects zero fastModeMultiplier', () => {
  const errors = validateFastMultiplier(0);
  assert.ok(errors.length > 0);
});

test('settings validation: accepts decimal fastModeMultiplier', () => {
  const errors = validateFastMultiplier(2.5);
  assert.equal(errors.length, 0);
});

test('config file preservation: non-whitelisted fields survive settings update', () => {
  const { configPath, dir } = makeTmpConfig();
  const original = parseConfigFile(configPath);

  // Simulate a settings update: read, patch whitelisted, write
  const existing = parseConfigFile(configPath);
  existing.modelPrices['claude-opus-4'].input = 10;
  existing.runtimeFastModeMultipliers.claude = 8;
  existing.fastModeMultiplier = 8;
  fs.writeFileSync(configPath, JSON.stringify(existing, null, 2) + '\n');

  const updated = parseConfigFile(configPath);
  assert.equal(updated.auth.password, 'scrypt:secret');
  assert.equal(updated.port, 3470);
  assert.equal(updated.retention.metrics, 'full');
  assert.equal(updated.modelPrices['claude-opus-4'].input, 10);
  assert.equal(updated.runtimeFastModeMultipliers.claude, 8);
  assert.equal(updated.fastModeMultiplier, 8);

  fs.rmSync(dir, { recursive: true });
});

test('loadConfig separates Claude and Codex model price tables', () => {
  withTmpZylosConfig({
    runtimeModelPrices: {
      claude: {
        'claude-opus-4': { input: 9, output: 25, cacheRead: 0.50, cacheCreation: 10 }
      },
      codex: {
        'gpt-5.5': { input: 4, output: 30, cacheRead: 0.50, cacheCreation: 4 }
      }
    }
  }, () => {
    const config = loadConfig();
    assert.equal(config.modelPrices['claude-opus-4'].input, 9);
    assert.equal(config.runtimeModelPrices.codex['gpt-5.5'].input, 4);
    assert.equal(config.runtimeModelPrices.codex['gpt-5.3-codex'].input, DEFAULT_CODEX_MODEL_PRICES['gpt-5.3-codex'].input);
    assert.equal(config.runtimeModelPrices.codex['gpt-5.4'].input, DEFAULT_CODEX_MODEL_PRICES['gpt-5.4'].input);
    assert.equal(modelPricesForRuntime(config, 'claude')['gpt-5.5'], undefined);
    assert.equal(modelPricesForRuntime(config, 'codex')['claude-opus-4'], undefined);
  });
});

test('loadConfig keeps Codex priority prices separate from standard prices', () => {
  withTmpZylosConfig({
    runtimeServiceTierModelPrices: {
      codex: {
        priority: {
          'gpt-5.5': { input: 13, output: 75, cacheRead: 1.25, cacheCreation: 13 }
        }
      }
    }
  }, () => {
    const config = loadConfig();
    assert.equal(modelPricesForRuntime(config, 'codex')['gpt-5.5'].input, DEFAULT_CODEX_MODEL_PRICES['gpt-5.5'].input);
    assert.equal(modelPricesForRuntime(config, 'codex', 'priority')['gpt-5.5'].input, 13);
    assert.equal(modelPricesForRuntime(config, 'codex', 'fast')['gpt-5.4'].input, DEFAULT_CODEX_PRIORITY_MODEL_PRICES['gpt-5.4'].input);
  });
});

test('loadConfig keeps fast mode multiplier scoped to Claude runtime', () => {
  withTmpZylosConfig({
    fastModeMultiplier: 8
  }, () => {
    const config = loadConfig();
    assert.equal(config.fastModeMultiplier, 8);
    assert.equal(config.runtimeFastModeMultipliers.claude, 8);
    assert.equal(config.runtimeFastModeMultipliers.codex, undefined);
  });
});

test('loadConfig prefers runtime fast mode multipliers over legacy field', () => {
  withTmpZylosConfig({
    fastModeMultiplier: 8,
    runtimeFastModeMultipliers: { claude: 5 }
  }, () => {
    const config = loadConfig();
    assert.equal(config.fastModeMultiplier, 5);
    assert.equal(config.runtimeFastModeMultipliers.claude, 5);
    assert.equal(config.runtimeFastModeMultipliers.codex, undefined);
  });
});

test('loadConfig migrates legacy modelPrices into Claude prices only', () => {
  withTmpZylosConfig({
    modelPrices: {
      'claude-opus-4': { input: 11, output: 25, cacheRead: 0.50, cacheCreation: 10 }
    }
  }, () => {
    const config = loadConfig();
    assert.equal(config.runtimeModelPrices.claude['claude-opus-4'].input, 11);
    assert.equal(config.runtimeModelPrices.codex['gpt-5.5'].input, DEFAULT_CODEX_MODEL_PRICES['gpt-5.5'].input);
    assert.equal(config.runtimeModelPrices.codex['claude-opus-4'], undefined);
  });
});

// HTTP integration via makeSettingsServer: actual route/config persistence;
// run when this behavior changes, skip presentation-only changes. Private
// runner roots + mock-before-import CLI, bounded fetch, owned cleanup as above.
test('GET /api/settings exposes Codex fast mode as priority service tier', async t => {
  const server = await makeSettingsServer(t, 'codex');
  try {
    const resp = await fetch(`${server.origin}/api/settings`);
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.runtime, 'codex');
    assert.equal(body.fastMode.available, true);
    assert.equal(body.fastMode.mode, 'service_tier');
    assert.equal(body.fastMode.serviceTier, 'priority');
    assert.equal(body.fastMode.multiplier, null);
    assert.equal(body.fastModeMultiplier, null);
    assert.equal(body.priorityModelPrices['gpt-5.5'].input, DEFAULT_CODEX_PRIORITY_MODEL_PRICES['gpt-5.5'].input);
    assert.ok(body.builtInPriorityModels.includes('gpt-5.5'));
  } finally {
    await server.close();
  }
});

// HTTP integration via makeSettingsServer: actual route/config persistence;
// run when this behavior changes, skip presentation-only changes. Private
// runner roots + mock-before-import CLI, bounded fetch, owned cleanup as above.
test('PUT /api/settings stores Codex priority model prices', async t => {
  const server = await makeSettingsServer(t, 'codex');
  try {
    const current = await (await fetch(`${server.origin}/api/settings`)).json();
    const priorityModelPrices = {
      ...current.priorityModelPrices,
      'gpt-5.5': { ...current.priorityModelPrices['gpt-5.5'], input: 13 }
    };
    const resp = await fetch(`${server.origin}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelPrices: current.modelPrices, priorityModelPrices })
    });
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.priorityModelPrices['gpt-5.5'].input, 13);
    const written = parseConfigFile(server.configPath);
    assert.equal(written.runtimeServiceTierModelPrices.codex.priority['gpt-5.5'].input, 13);
  } finally {
    await server.close();
  }
});

// HTTP integration via makeSettingsServer: actual route/config persistence;
// run when this behavior changes, skip presentation-only changes. Private
// runner roots + mock-before-import CLI, bounded fetch, owned cleanup as above.
test('PUT /api/settings rejects fast mode multiplier for Codex runtime', async t => {
  const server = await makeSettingsServer(t, 'codex');
  try {
    const current = await (await fetch(`${server.origin}/api/settings`)).json();
    const resp = await fetch(`${server.origin}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelPrices: current.modelPrices, fastModeMultiplier: 6 })
    });
    assert.equal(resp.status, 400);
    const body = await resp.json();
    assert.match(body.error, /not supported for codex runtime/);
  } finally {
    await server.close();
  }
});

// HTTP integration via makeSettingsServer: actual route/config persistence;
// run when this behavior changes, skip presentation-only changes. Private
// runner roots + mock-before-import CLI, bounded fetch, owned cleanup as above.
test('PUT /api/settings stores fast mode multiplier under Claude runtime', async t => {
  const server = await makeSettingsServer(t, 'claude');
  try {
    const current = await (await fetch(`${server.origin}/api/settings`)).json();
    const resp = await fetch(`${server.origin}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelPrices: current.modelPrices, fastModeMultiplier: 7 })
    });
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.fastMode.available, true);
    assert.equal(body.fastMode.multiplier, 7);
    const written = parseConfigFile(server.configPath);
    assert.equal(written.runtimeFastModeMultipliers.claude, 7);
    assert.equal(written.fastModeMultiplier, 7);
    assert.equal(written.runtimeFastModeMultipliers.codex, undefined);
  } finally {
    await server.close();
  }
});

// ─── Validation helpers (extracted from server logic for testability) ───

function builtInModelsForRuntime(runtime = 'claude') {
  return Object.keys(DEFAULT_RUNTIME_MODEL_PRICES[runtime === 'codex' ? 'codex' : 'claude'] || {});
}

function validateModelPrices(modelPrices, runtime = 'claude') {
  const errors = [];
  if (typeof modelPrices !== 'object' || modelPrices === null || Array.isArray(modelPrices)) {
    errors.push('modelPrices must be an object');
    return errors;
  }
  for (const builtIn of builtInModelsForRuntime(runtime)) {
    if (!(builtIn in modelPrices)) {
      errors.push(`Cannot remove built-in model: ${builtIn}`);
    }
  }
  for (const [prefix, prices] of Object.entries(modelPrices)) {
    if (!prefix || typeof prefix !== 'string') {
      errors.push('Model prefix must be a non-empty string');
      continue;
    }
    for (const field of ['input', 'output', 'cacheRead', 'cacheCreation']) {
      const v = prices?.[field];
      if (v == null || typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
        errors.push(`${prefix}.${field} must be a finite number >= 0`);
      }
    }
  }
  return errors;
}

function validateFastMultiplier(fm) {
  const errors = [];
  if (typeof fm !== 'number' || !Number.isFinite(fm) || fm <= 0) {
    errors.push('fastModeMultiplier must be a finite number > 0');
  }
  return errors;
}

// HTTP integration via makeSettingsServer: actual route/config persistence;
// run when this behavior changes, skip presentation-only changes. Private
// runner roots + mock-before-import CLI, bounded fetch, owned cleanup as above.
test('settings roundtrip preserves current tariff metadata and marks only explicit Fast overrides', async t => {
  const server = await makeSettingsServer(t, 'claude');
  try {
    const current = await (await fetch(`${server.origin}/api/settings`)).json();
    assert.equal(current.fastMode.configuredMultiplier, null);
    assert.equal(current.modelPrices['claude-opus-5'].fastModeMultiplier, 2);
    const put = body => fetch(`${server.origin}/api/settings`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    assert.equal((await put({ modelPrices: current.modelPrices })).status, 200);
    const unchanged = await (await fetch(`${server.origin}/api/settings`)).json();
    assert.equal(unchanged.fastMode.configuredMultiplier, null);
    assert.equal(parseConfigFile(server.configPath).fastModeMultiplier, undefined);
    assert.equal((await put({ fastModeMultiplier: 6 })).status, 200);
    const changed = await (await fetch(`${server.origin}/api/settings`)).json();
    assert.equal(changed.fastMode.configuredMultiplier, 6); // same running instance
    assert.equal(parseConfigFile(server.configPath).runtimeFastModeMultipliers.claude, 6);
    assert.equal((await put({ fastModeMultiplier: null })).status, 200);
    const reset = await (await fetch(`${server.origin}/api/settings`)).json();
    assert.equal(reset.fastMode.configuredMultiplier, null);
    assert.equal(reset.fastMode.multiplier, 6);
    const persisted = parseConfigFile(server.configPath);
    assert.equal(persisted.runtimeFastModeMultipliers.claude, undefined);
    assert.equal(persisted.fastModeMultiplier, undefined);
  } finally { await server.close(); }
});

// HTTP integration via makeSettingsServer: actual route/config persistence;
// run when this behavior changes, skip presentation-only changes. Private
// runner roots + mock-before-import CLI, bounded fetch, owned cleanup as above.
test('settings preserves long-context rates and rejects invalid tariff metadata', async t => {
  const server = await makeSettingsServer(t, 'codex');
  try {
    const current = await (await fetch(`${server.origin}/api/settings`)).json();
    const put = body => fetch(`${server.origin}/api/settings`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const body = { modelPrices: current.modelPrices, priorityModelPrices: current.priorityModelPrices };
    assert.ok(Buffer.byteLength(JSON.stringify(body)) < 16 * 1024);
    assert.equal((await put(body)).status, 200);
    const roundtrip = await (await fetch(`${server.origin}/api/settings`)).json();
    assert.deepEqual(roundtrip.modelPrices, current.modelPrices);
    assert.deepEqual(roundtrip.priorityModelPrices, current.priorityModelPrices);
    const persisted = parseConfigFile(server.configPath);
    assert.deepEqual(persisted.runtimeModelPrices.codex['gpt-6-astra'].longContext, current.modelPrices['gpt-6-astra'].longContext);
    for (const bad of [null, [], { inputTokenThreshold: -1 }, { inputTokenThreshold: 272000, input: -1, output: 1, cacheRead: 1, cacheCreation: 1 }]) {
      const modelPrices = structuredClone(current.modelPrices);
      modelPrices['gpt-6-astra'].longContext = bad;
      assert.equal((await put({ modelPrices })).status, 400);
    }
    const modelPrices = structuredClone(current.modelPrices);
    modelPrices['gpt-6-astra'].fastModeMultiplier = -2;
    assert.equal((await put({ modelPrices })).status, 400);
  } finally { await server.close(); }
});

// HTTP integration via makeSettingsServer: actual route/config persistence;
// run when this behavior changes, skip presentation-only changes. Private
// runner roots + mock-before-import CLI, bounded fetch, owned cleanup as above.
test('ordinary Settings save preserves custom prefixes without broadening built-in Codex IDs', async t => {
  const standard = { input: 9, output: 8, cacheRead: 7, cacheCreation: 6 };
  const priority = { input: 18, output: 16, cacheRead: 14, cacheCreation: 12 };
  const server = await makeSettingsServer(t, 'codex', {
    runtimeModelPrices: { codex: { 'vendor-model': standard } },
    runtimeServiceTierModelPrices: { codex: { priority: { 'vendor-model': priority } } }
  });
  function verify(config) {
    const collector = new CodexRolloutCollector({}, config);
    for (const [tier, expected] of [['standard', standard], ['priority', priority]]) {
      assert.deepEqual(collector._resolveModelPrice('vendor-model-pro', tier), expected);
      assert.equal(collector._resolveModelPrice('gpt-5.7', tier), null);
      const builtIn = collector._resolveModelPrice('gpt-6-astra', tier);
      assert.ok(builtIn);
      assert.deepEqual(collector._resolveModelPrice('gpt-6-astra-2026-09-15', tier), builtIn);
      assert.equal(collector._resolveModelPrice('gpt-6-astra-pro', tier), null);
    }
  }
  function reload() {
    const previous = process.env.ZYLOS_DIR;
    process.env.ZYLOS_DIR = server.dir;
    try { return loadConfig(); } finally {
      if (previous === undefined) delete process.env.ZYLOS_DIR;
      else process.env.ZYLOS_DIR = previous;
    }
  }
  try {
    verify(reload());
    const current = await (await fetch(`${server.origin}/api/settings`)).json();
    const response = await fetch(`${server.origin}/api/settings`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelPrices: current.modelPrices, priorityModelPrices: current.priorityModelPrices })
    });
    assert.equal(response.status, 200);
    const saved = await (await fetch(`${server.origin}/api/settings`)).json();
    verify({ runtimeModelPrices: { codex: saved.modelPrices }, runtimeServiceTierModelPrices: { codex: { priority: saved.priorityModelPrices } } });
    assert.ok(parseConfigFile(server.configPath).runtimeModelPrices.codex['gpt-5']);
    verify(reload());
  } finally { await server.close(); }
});

// Same isolated HTTP boundary and lifecycle as makeSettingsServer above.
// HTTP integration via makeSettingsServer: actual route/config persistence;
// run when this behavior changes, skip presentation-only changes. Private
// runner roots + mock-before-import CLI, bounded fetch, owned cleanup as above.
test('all-runtime settings keep legacy payload and atomically save both price tables', async t => {
  const server = await makeSettingsServer(t);
  const get = async suffix => (await fetch(server.origin + '/api/settings' + suffix)).json();
  const original = await get(''), all = await get('?all=1');
  assert.deepEqual(Object.keys(all).sort(), ['active', 'runtimes']);
  assert.equal(all.active, 'claude');
  assert.deepEqual(all.runtimes.claude, original);
  assert.deepEqual(all.runtimes.claude.builtInModels.sort(), Object.keys(DEFAULT_RUNTIME_MODEL_PRICES.claude).sort());
  assert.deepEqual(all.runtimes.codex.builtInModels.sort(), Object.keys(DEFAULT_RUNTIME_MODEL_PRICES.codex).sort());
  const claude = structuredClone(all.runtimes.claude.modelPrices);
  const codex = structuredClone(all.runtimes.codex.modelPrices);
  claude['claude-opus-4'].input = 11;
  codex['gpt-6-astra'].input = 17;
  const response = await fetch(server.origin + '/api/settings', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ runtimes: { claude: { modelPrices: claude, fastModeMultiplier: 7 }, codex: { modelPrices: codex } } }),
  });
  assert.equal(response.status, 200);
  const saved = await response.json();
  assert.deepEqual(saved, await get('?all=1'));
  assert.equal(server.mutations(), 1);
  assert.equal(saved.runtimes.claude.modelPrices['claude-opus-4'].input, 11);
  assert.equal(saved.runtimes.codex.modelPrices['gpt-6-astra'].input, 17);
  const disk = parseConfigFile(server.configPath);
  assert.equal(disk.runtimeModelPrices.codex['gpt-6-astra'].input, 17);
  assert.equal(disk.modelPrices['claude-opus-4'].input, 11);
  assert.equal(disk.runtimeFastModeMultipliers.claude, 7);
});

// HTTP integration via makeSettingsServer: actual route/config persistence;
// run when this behavior changes, skip presentation-only changes. Private
// runner roots + mock-before-import CLI, bounded fetch, owned cleanup as above.
test('invalid combined settings leave both memory and disk unchanged with zero mutations', async t => {
  const server = await makeSettingsServer(t);
  const all = await (await fetch(server.origin + '/api/settings?all=1')).json();
  const claude = structuredClone(all.runtimes.claude.modelPrices);
  claude['claude-opus-4'].input = 19;
  const missing = structuredClone(all.runtimes.codex.modelPrices);
  delete missing['gpt-6-astra'];
  const before = fs.readFileSync(server.configPath, 'utf8');
  for (const body of [
    { runtimes: { claude: { modelPrices: claude }, codex: { modelPrices: missing } } },
    { runtimes: { claude: { priorityModelPrices: {} } } },
    { runtimes: { codex: { fastModeMultiplier: 2 } } },
    { runtimes: { claude: {} }, modelPrices: claude },
    { runtimes: { foo: {} } }, { runtimes: null }, { runtimes: [] },
  ]) {
    const response = await fetch(server.origin + '/api/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal(response.status, 400);
    assert.equal(fs.readFileSync(server.configPath, 'utf8'), before);
  }
  assert.equal(server.mutations(), 0);
  assert.deepEqual(await (await fetch(server.origin + '/api/settings?all=1')).json(), all);
});

// HTTP integration via makeSettingsServer: actual route/config persistence;
// run when this behavior changes, skip presentation-only changes. Private
// runner roots + mock-before-import CLI, bounded fetch, owned cleanup as above.
test('explicit runtime metadata reads saved defaults for active and inactive runtimes', async t => {
  const server = await makeSettingsServer(t);
  fs.mkdirSync(path.join(server.dir, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(server.dir, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(server.dir, '.claude/settings.json'), JSON.stringify({ model: 'opus', effortLevel: 'low' }));
  fs.writeFileSync(path.join(server.dir, '.codex/config.toml'), 'model = "gpt-6-astra"\nmodel_reasoning_effort = "high"\n');
  t.mock.method(server.statusline, '_read', async () => ({
    identity: { runtime: 'claude', runId: 'running', sessionId: 'running-session' },
    usage: { valid: true, sampledAt: Date.now(), value: {
      model: { id: 'opus' }, effort: { level: 'high' }
    } }
  }));
  await server.statusline.collect();
  assert.equal(server.statusline.getRuntimeInfo().effort, 'high');
  for (const [runtime, effort] of [['claude', 'low'], ['codex', 'high']]) {
    const response = await fetch(server.origin + '/api/actions/meta?runtime=' + runtime);
    assert.equal(response.status, 200);
    const meta = await response.json();
    assert.equal(meta.runtime, runtime);
    assert.equal(meta.current_effort, effort);
    assert.equal(meta.runtime_cli, runtime);
  }
  assert.equal((await fetch(server.origin + '/api/actions/meta?runtime=foo')).status, 400);
  const legacy = await fetch(server.origin + '/api/actions/meta');
  assert.equal(legacy.status, 200);
  assert.equal((await legacy.json()).current_effort, 'high');
});

// HTTP integration via makeSettingsServer: actual route/config persistence;
// run when this behavior changes, skip presentation-only changes. Private
// runner roots + mock-before-import CLI, bounded fetch, owned cleanup as above.
test('override pages support read credentials and preserve bounded CLI arguments', async t => {
  const calls = [];
  const server = await makeSettingsServer(t, 'claude', { auth: { enabled: true, password: 'scrypt:fixture' } }, (file, args, options) => {
    calls.push({ file, args, options });
    return { ok: true, data: { runtimeTotal: 100000, runtime: [{ sessionGroup: 'chat:AbC', runtime: 'codex' }], nextAfter: 'chat:AbC' } };
  });
  server.store.insertApiKey({ name: 'read-fixture', keyHash: hashApiKey('zylos_ak_fixture'), scope: 'read' });
  const previousGroup = process.env.ZYLOS_SESSION_GROUP;
  t.after(() => { if (previousGroup === undefined) delete process.env.ZYLOS_SESSION_GROUP; else process.env.ZYLOS_SESSION_GROUP = previousGroup; });
  process.env.ZYLOS_SESSION_GROUP = 'fixture:unrelated-group';
  const token = exchangeApiKeyForToken('zylos_ak_fixture').token;
  const headers = { Authorization: `Bearer ${token}` };
  assert.equal((await fetch(server.origin + '/api/workbench/runtime-overrides')).status, 401);
  assert.equal(calls.length, 0);
  const response = await fetch(server.origin + '/api/workbench/runtime-overrides', { headers });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.runtimeTotal, 100000);
  assert.equal(data.runtime.length, 1);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['group', 'overrides', '--json']);
  assert.equal(calls[0].file, 'zylos');
  assert.equal(calls[0].options.env.ZYLOS_DIR, server.dir);
  assert.equal(calls[0].options.env.ZYLOS_SESSION_GROUP, undefined);
  assert.equal(calls[0].options.timeout, 15000);
  assert.equal(calls[0].options.maxBuffer, 1024 * 1024);
  for (const q of [' ', 'x'.repeat(65), '竞品', '--b', '--upstream-x']) {
    const prior = calls.length;
    const result = await fetch(server.origin + '/api/workbench/runtime-overrides?q=' + encodeURIComponent(q), { headers });
    assert.equal(result.status, 200);
    assert.equal((await result.json()).runtime.length, 0);
    assert.equal(calls.length, prior);
  }
  for (const q of ['a--b', 'AbC']) {
    await fetch(server.origin + '/api/workbench/runtime-overrides?q=' + q + '&after=chat%3Acursor', { headers });
    assert.deepEqual(calls.at(-1).args, ['group', 'overrides', '--match', q, '--after', 'chat:cursor', '--json']);
  }
  assert.equal((await fetch(server.origin + '/api/workbench/pricing', { headers })).status, 200);
});

// HTTP integration via makeSettingsServer: actual route/config persistence;
// run when this behavior changes, skip presentation-only changes. Private
// runner roots + mock-before-import CLI, bounded fetch, owned cleanup as above.
test('override search puts display-name matches first and removes them from every key page', async t => {
  const calls = [];
  const server = await makeSettingsServer(t, 'claude', {}, (_file, args) => {
    calls.push(args);
    if (args.includes('--group')) return { ok: true, data: { runtime: [{ sessionGroup: 'chat:oc_named', runtime: 'codex' }] } };
    if (args.includes('--after')) return { ok: true, data: { runtime: [
      { sessionGroup: 'chat:oc_named', runtime: 'codex' }, { sessionGroup: 'chat:oc_tail', runtime: 'claude' },
    ], nextAfter: null } };
    return { ok: true, data: { runtime: [{ sessionGroup: 'chat:oc_key', runtime: 'claude' }], nextAfter: 'chat:oc_key' } };
  });
  server.store.writeGroupDisplayName('chat:oc_named', '竞品调研 oc_', 'human');
  server.store.writeGroupDisplayName('chat:no_override', '竞品分析', 'human');
  server.store.writeGroupDisplayName('chat:oc_key', 'Saved title', 'human');
  const chinese = await (await fetch(server.origin + '/api/workbench/runtime-overrides?q=' + encodeURIComponent('竞品'))).json();
  assert.equal(chinese.runtime.length, 1);
  assert.equal(chinese.runtime[0].name.displayName, '竞品调研 oc_');
  assert.ok(calls[0].includes('chat:no_override'));
  assert.equal(calls.some(args => args.includes('--match')), false);
  calls.length = 0;
  const first = await (await fetch(server.origin + '/api/workbench/runtime-overrides?q=oc_')).json();
  assert.deepEqual(first.runtime.map(row => row.sessionGroup), ['chat:oc_named', 'chat:oc_key']);
  assert.equal(first.runtime[1].name.displayName, 'Saved title');
  const second = await (await fetch(server.origin + '/api/workbench/runtime-overrides?q=oc_&after=' + encodeURIComponent(first.nextAfter))).json();
  assert.equal(second.runtime.length, 1);
  assert.equal(second.runtime[0].sessionGroup, 'chat:oc_tail');
  assert.equal(calls.filter(args => args.includes('--group')).length, 1);
  assert.deepEqual(calls.at(-1), ['group', 'overrides', '--match', 'oc_', '--after', 'chat:oc_key', '--json']);
});

// HTTP integration via makeSettingsServer: actual route/config persistence;
// run when this behavior changes, skip presentation-only changes. Private
// runner roots + mock-before-import CLI, bounded fetch, owned cleanup as above.
test('override source failures and malformed envelopes return one failure code', async t => {
  let output;
  const server = await makeSettingsServer(t, 'claude', {}, () => {
    if (output instanceof Error) throw output;
    return output;
  });
  for (const bad of [new Error('Core failed'), '{', { ok: false }, { ok: true, data: { runtime: [{}] } },
    { ok: true, data: { runtime: [], runtimeTotal: 'invalid' } }]) {
    output = bad;
    const response = await fetch(server.origin + '/api/workbench/runtime-overrides');
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: 'override_list_failed' });
  }
  server.store.writeGroupDisplayName('chat:named', '竞品', 'human');
  output = new Error('named lookup failed');
  const response = await fetch(server.origin + '/api/workbench/runtime-overrides?q=' + encodeURIComponent('竞品'));
  assert.equal(response.status, 502);
  t.mock.method(server.store, 'searchGroupDisplayNames', () => { throw new Error('names unreadable'); });
  assert.equal((await fetch(server.origin + '/api/workbench/runtime-overrides?q=abc')).status, 502);
});

// HTTP integration via makeSettingsServer: actual route/config persistence;
// run when this behavior changes, skip presentation-only changes. Private
// runner roots + mock-before-import CLI, bounded fetch, owned cleanup as above.
test('pricing usage aggregates dimension tokens and preserves old costs after price edits', async t => {
  const server = await makeSettingsServer(t, 'codex');
  const insert = server.store.db.prepare("INSERT INTO metric_points(timestamp,runtime,metric_name,metric_value,dimensions,source) VALUES(?,?,'usage_event',999,?,'fixture')");
  const now = new Date().toISOString(), old = new Date(Date.now() - 8 * 86400000).toISOString();
  for (const [runtime, dimensions, timestamp = now] of [
    ['codex', { model: 'gpt-reserve', total_input: 1000000 }],
    ['codex', { model: 'gpt-reserve', output: 400000 }],
    ['codex', { model: 'old-unmatched', total_input: 2 }, old],
    ['claude', { model: 'claude-opus-4', cost: 3, total_input: 700, output: 300 }],
    ['codex', { model: 'gpt-6-astra', cost: 5, total_input: 900, output: 100 }],
    ['codex', { model: 'empty' }],
  ]) insert.run(timestamp, runtime, JSON.stringify(dimensions));
  const usage = await (await fetch(server.origin + '/api/workbench/pricing')).json();
  assert.equal(usage.unmatched.length, 1);
  assert.deepEqual(usage.unmatched[0], { runtime: 'codex', model: 'gpt-reserve', tokens: 1400000 });
  assert.equal(usage.models.find(row => row.model === 'claude-opus-4').cost, 3);
  assert.equal(usage.models.some(row => row.model === 'old-unmatched'), false);
  const collector = new CodexRolloutCollector(server.store, server.config);
  const mapping = { session_id: 'fixture-codex' };
  const ingest = id => collector._ingestTokenCount({ id, model: 'gpt-6-astra', last_token_usage: { input_tokens: 1000, output_tokens: 100 } }, now, mapping);
  assert.equal(ingest('price-before'), 1);
  const readCost = id => JSON.parse(server.store.db.prepare("SELECT dimensions FROM metric_points WHERE json_extract(dimensions,'$.event_id')=?").get(id).dimensions).cost;
  const before = readCost('price-before');
  const all = await (await fetch(server.origin + '/api/settings?all=1')).json();
  const prices = all.runtimes.codex.modelPrices;
  prices['gpt-6-astra'].input += 20;
  const saved = await fetch(server.origin + '/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ runtimes: { codex: { modelPrices: prices } } }) });
  assert.equal(saved.status, 200);
  assert.equal(ingest('price-after'), 1);
  assert.equal(readCost('price-before'), before);
  assert.ok(Math.abs(readCost('price-after') - before - 0.02) < 1e-9);
});

// Actual createServer timezone GET route + production PM2 wiring. Run for
// candidate-discovery/wiring changes, skip pure styles. Reuses makeSettingsServer
// isolation and teardown; collector reads are injected, no real PM2 is spawned.
test('timezone settings discover the fresh process list on every HTTP request', async t => {
  const server = await makeSettingsServer(t, 'claude', { auth: { enabled: true, password: 'fixture' } });
  server.store.insertApiKey({ name: 'timezone-read-fixture', keyHash: hashApiKey('zylos_ak_timezone_fixture'), scope: 'read' });
  const token = exchangeApiKeyForToken('zylos_ak_timezone_fixture').token;
  const headers = { Authorization: `Bearer ${token}` };
  const scheduler = path.join(server.dir, '.claude/skills/scheduler/scripts/daemon.js');
  fs.mkdirSync(path.dirname(scheduler), { recursive: true }); fs.writeFileSync(scheduler, '');
  fs.writeFileSync(path.join(server.dir, '.env'), 'TZ=UTC\n', { mode: 0o600 });
  let status = 'online', reads = 0;
  const entry = () => ({ name: 'scheduler', pm2_env: { status, pm_exec_path: scheduler, ZYLOS_DIR: server.dir } });
  t.mock.method(PM2Collector.prototype, 'getLatestPM2Data', () => ({ processes: [{ name: 'cached-service' }] }));
  t.mock.method(PM2Collector.prototype, '_execPm2Jlist', async () => { reads++; return JSON.stringify([entry()]); });
  const first = await fetch(server.origin + '/api/settings/timezone', { headers });
  assert.equal(first.status, 200);
  assert.deepEqual((await first.json()).restart_services.map(service => service.name), ['scheduler']);
  const afterFirst = reads; assert.ok(afterFirst > 0);
  status = 'stopped';
  const second = await fetch(server.origin + '/api/settings/timezone', { headers });
  assert.equal(second.status, 200); assert.deepEqual((await second.json()).restart_services, []);
  assert.ok(reads > afterFirst, 'the second route request must rediscover rather than read cached PM2 data');
});
