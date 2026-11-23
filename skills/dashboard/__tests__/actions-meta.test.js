import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { getActionsMeta, handleAction } from '../src/lib/actions.js';

async function withCodexHome(fn) {
  const prev = process.env.CODEX_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-codex-actions-'));
  process.env.CODEX_HOME = dir;
  try {
    return await fn(dir);
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function makeZylosDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-zylos-'));
  fs.mkdirSync(path.join(dir, '.codex'), { recursive: true });
  return dir;
}

test('handleAction stores Codex model and effort in config.toml', async () => {
  await withCodexHome(async (codexHome) => {
    const zylosDir = makeZylosDir();
    fs.writeFileSync(path.join(codexHome, 'models_cache.json'), JSON.stringify({
      models: [{
        slug: 'gpt-5.5',
        visibility: 'list',
        supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'xhigh' }]
      }]
    }));

    const modelResult = await handleAction('switch-model', { model: 'gpt-6.1-sol' }, { runtime: 'codex', zylosDir });
    assert.equal(modelResult.ok, true);
    const effortResult = await handleAction('switch-effort', { effort: 'xhigh' }, { runtime: 'codex', zylosDir });
    assert.equal(effortResult.ok, true);

    const config = fs.readFileSync(path.join(zylosDir, '.codex', 'config.toml'), 'utf8');
    assert.match(config, /^model = "gpt-6\.1-sol"$/m);
    assert.match(config, /^model_reasoning_effort = "xhigh"$/m);
    assert.equal(fs.existsSync(path.join(codexHome, 'config.toml')), false);

    fs.rmSync(zylosDir, { recursive: true, force: true });
  });
});

test('threshold writes require a model and engine, preserve another model and reject values above the maximum', async () => {
  const zylosDir = makeZylosDir();
  try {
    fs.mkdirSync(path.join(zylosDir, '.zylos')); fs.mkdirSync(path.join(zylosDir, '.claude'));
    fs.writeFileSync(path.join(zylosDir, '.claude/settings.json'), JSON.stringify({ model: 'opus' }));
    fs.writeFileSync(path.join(zylosDir, '.zylos/config.json'), JSON.stringify({ new_session_threshold: 68 }));
    const config = { zylosDir, runtime: 'codex' };
    assert.equal((await handleAction('set-threshold', { model: 'opus', value: 63 }, config)).error, 'INVALID_RUNTIME');
    assert.equal((await handleAction('set-threshold', { runtime: 'claude', value: 63 }, config)).error, 'invalid_model');
    assert.equal((await handleAction('set-threshold', { runtime: 'claude', model: 'opus[1m]', value: 96 }, config)).error, 'invalid_value');
    assert.equal((await handleAction('set-threshold', { runtime: 'claude', model: 'opus[1m]', value: '35junk' }, config)).error, 'invalid_value');
    assert.equal((await handleAction('set-threshold', { runtime: 'claude', model: 'opus[1m]', value: true }, config)).error, 'invalid_value');
    for (const runtime of ['claude', 'codex']) {
      const rejected = await handleAction('set-threshold', { runtime, model: 'opus[1m]', value: 9 }, config);
      assert.equal(rejected.error, 'invalid_value');
      assert.match(rejected.message, /between 10 and 95/);
      assert.equal((await handleAction('set-threshold', { runtime, model: 'opus[1m]', value: 10 }, config)).ok, true);
    }
    assert.equal((await handleAction('set-threshold', { runtime: 'claude', model: 'opus[1m]', value: 35 }, config)).ok, true);
    const stored = JSON.parse(fs.readFileSync(path.join(zylosDir, '.zylos/config.json'), 'utf8'));
    assert.equal(stored.model_rotation_thresholds.claude.opus, 68);
    assert.equal(stored.model_rotation_thresholds.claude['opus[1m]'], 35);
    assert.equal(stored.new_session_threshold, 68, 'legacy key remains unchanged');
  } finally { fs.rmSync(zylosDir, { recursive: true, force: true }); }
});

test('hot TTL actions save integer minutes as seconds and preserve unrelated configuration', async () => {
  const zylosDir = makeZylosDir();
  const previous = process.env.ZYLOS_SESSION_HOT_TTL_SECONDS;
  delete process.env.ZYLOS_SESSION_HOT_TTL_SECONDS;
  try {
    fs.mkdirSync(path.join(zylosDir, '.zylos'));
    const file = path.join(zylosDir, '.zylos/config.json');
    const initial = { session_mode: 'multi', session_hot_ttl_seconds: 1800,
      session_evict_min_idle_seconds: 300, model_rotation_thresholds: { claude: { opus: 65 } } };
    fs.writeFileSync(file, JSON.stringify(initial));
    const config = { zylosDir };
    for (const minutes of [4, 1441, 1.5, 5.5, '5x', false, '', null, undefined]) {
      const before = fs.readFileSync(file, 'utf8');
      const result = await handleAction('set-session-hot-ttl', { minutes }, config);
      assert.equal(result.ok, false);
      assert.equal(result.messageKey, 'result.invalid_hot_ttl');
      assert.equal(fs.readFileSync(file, 'utf8'), before, 'invalid minutes must not change the file');
    }
    for (const minutes of [5, 1440]) {
      const result = await handleAction('set-session-hot-ttl', { minutes }, config);
      assert.equal(result.ok, true);
      assert.equal(result.seconds, minutes * 60);
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(saved.session_hot_ttl_seconds, minutes * 60);
      assert.equal(saved.session_evict_min_idle_seconds, initial.session_evict_min_idle_seconds);
      assert.deepEqual(saved.model_rotation_thresholds, initial.model_rotation_thresholds);
      const meta = getActionsMeta({ ...saved, zylosDir }, {}).session_hot_ttl;
      assert.equal(meta.minutes, minutes);
      assert.equal(meta.read_only, false);
    }
    fs.writeFileSync(file, JSON.stringify({ session_hot_ttl_seconds: initial.session_hot_ttl_seconds }));
    const before = fs.readFileSync(file, 'utf8');
    const single = await handleAction('set-session-hot-ttl', { minutes: 25 }, { ...config, session_mode: 'multi' });
    assert.equal(single.messageKey, 'result.hot_ttl_multi_only', 'actual config mode takes precedence over a stale caller');
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  } finally {
    if (previous === undefined) delete process.env.ZYLOS_SESSION_HOT_TTL_SECONDS;
    else process.env.ZYLOS_SESSION_HOT_TTL_SECONDS = previous;
    fs.rmSync(zylosDir, { recursive: true, force: true });
  }
});

// Covers native single's Dashboard write and effective metadata, with a fixture
// config only. Run for reclaim configuration/actions; skip unrelated settings.
