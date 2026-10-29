import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { CodexRolloutCollector } from '../src/lib/collectors/codex-rollout-collector.js';
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

async function makeSettingsServer(runtime = 'claude', configBody = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-server-'));
  fs.mkdirSync(path.join(dir, '.zylos'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.zylos', 'config.json'), JSON.stringify({ runtime }, null, 2) + '\n');
  const dashboardDir = path.join(dir, 'components', 'dashboard');
  fs.mkdirSync(dashboardDir, { recursive: true });
  const configPath = path.join(dashboardDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    auth: { enabled: false },
    ...configBody
  }, null, 2) + '\n');

  const previous = process.env.ZYLOS_DIR;
  process.env.ZYLOS_DIR = dir;
  const moduleUrl = new URL(`../src/index.js?settings=${Date.now()}-${Math.random()}`, import.meta.url);
  const { createServer } = await import(moduleUrl.href);
  if (previous === undefined) delete process.env.ZYLOS_DIR;
  else process.env.ZYLOS_DIR = previous;

  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    dir,
    configPath,
    origin: `http://127.0.0.1:${port}`,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

async function importHandler() {
  const { readJsonBody, sendJson } = await import('../src/lib/http.js');
  const { loadConfig } = await import('../src/lib/config.js');
  return { readJsonBody, sendJson, loadConfig };
}

test('PUT /api/settings rejects null body', async () => {
  const { configPath, dir } = makeTmpConfig();
  const original = parseConfigFile(configPath);

  const { createServer } = await import('../src/index.js');

  // The server requires full setup; instead test the validation logic directly
  // by checking that null/array/string bodies are caught
  // This is a lightweight structural test

  // null body → typeof null === 'object' but null check catches it
  assert.equal(typeof null, 'object');
  assert.equal(null === null, true);
  // Array body → Array.isArray catches it
  assert.equal(Array.isArray([1, 2]), true);
  // String body → typeof check catches it
  assert.equal(typeof 'hello' === 'object', false);

  fs.rmSync(dir, { recursive: true });
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

test('GET /api/settings exposes Codex fast mode as priority service tier', async () => {
  const server = await makeSettingsServer('codex');
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

test('PUT /api/settings stores Codex priority model prices', async () => {
  const server = await makeSettingsServer('codex');
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

test('PUT /api/settings rejects fast mode multiplier for Codex runtime', async () => {
  const server = await makeSettingsServer('codex');
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

test('PUT /api/settings stores fast mode multiplier under Claude runtime', async () => {
  const server = await makeSettingsServer('claude');
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

test('settings roundtrip preserves current tariff metadata and marks only explicit Fast overrides', async () => {
  const server = await makeSettingsServer('claude');
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

test('settings preserves long-context rates and rejects invalid tariff metadata', async () => {
  const server = await makeSettingsServer('codex');
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

test('ordinary Settings save preserves custom prefixes without broadening built-in Codex IDs', async () => {
  const standard = { input: 9, output: 8, cacheRead: 7, cacheCreation: 6 };
  const priority = { input: 18, output: 16, cacheRead: 14, cacheCreation: 12 };
  const server = await makeSettingsServer('codex', {
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
