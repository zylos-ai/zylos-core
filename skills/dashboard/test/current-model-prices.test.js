import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadConfig, DEFAULT_CODEX_MODEL_PRICES, DEFAULT_CODEX_PRIORITY_MODEL_PRICES, DEFAULT_CLAUDE_MODEL_PRICES } from '../src/lib/config.js';
import { CodexRolloutCollector } from '../src/lib/collectors/codex-rollout-collector.js';
import { ConversationCollector } from '../src/lib/collectors/conversation-collector.js';
import { Store } from '../src/lib/store.js';

const defaults = {
  runtimeModelPrices: { codex: DEFAULT_CODEX_MODEL_PRICES, claude: DEFAULT_CLAUDE_MODEL_PRICES },
  runtimeServiceTierModelPrices: { codex: { priority: DEFAULT_CODEX_PRIORITY_MODEL_PRICES } }
};
function closeTo(actual, expected) { assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`); }
function withConfig(value, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-price-config-'));
  const prev = process.env.ZYLOS_DIR;
  process.env.ZYLOS_DIR = dir;
  if (value !== null) {
    fs.mkdirSync(path.join(dir, 'components/dashboard'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'components/dashboard/config.json'), JSON.stringify(value));
  }
  try { fn(loadConfig()); } finally {
    if (prev === undefined) delete process.env.ZYLOS_DIR; else process.env.ZYLOS_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
function ingest(t, { model = 'gpt-6-astra', serviceTier = 'standard', usage, config = defaults, cumulative = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-price-usage-'));
  const store = new Store(path.join(dir, 'test.db'));
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const collector = new CodexRolloutCollector(store, config);
  const info = { id: 'test-usage', model, service_tier: serviceTier, [cumulative ? 'total_token_usage' : 'last_token_usage']: usage };
  const mapping = { session_id: 'test-session' };
  collector._ingestTokenCount(info, '2026-09-15T00:00:00Z', mapping);
  return { store, collector, info, mapping, row: store.queryMetrics({ name: 'usage_event' })[0] };
}

// Independent tariff expectations: OpenAI API pricing, checked 2026-09-15
// (GPT-6 Sol/Luna checked 2026-09-28; GPT-6.1 Sol checked 2026-09-30).
for (const [model, shortCost] of [
  ['gpt-6-astra', 1.76], ['gpt-6.1-sol', 0.342], ['gpt-6-sol', 0.352], ['gpt-6-luna', 0.0176], ['gpt-5.6-sol', 0.704],
  ['gpt-5.6-terra', 0.3744], ['gpt-5.6-luna', 0.03744], ['gpt-5.6', 0.704]
]) {
  for (const [tier, factor] of [['standard', 1], ['priority', 2], ['fast', 2]]) {
    test(`${model} ${tier} prices distinct cache writes without double-counting input`, t => {
      const { row } = ingest(t, { model, serviceTier: tier, usage: {
        input_tokens: 200000, cached_input_tokens: 100000, cache_write_input_tokens: 40000, output_tokens: 11200
      } });
      assert.equal(row.dimensions.cache_creation, 40000);
      assert.equal(row.dimensions.uncached_input, 60000);
      closeTo(row.dimensions.cost, shortCost * factor);
    });
  }
}
for (const [count, expected] of [[271999, 2.71999], [272000, 2.72], [272001, 5.44002]]) {
  test(`Astra long context threshold at ${count} is strictly above 272K`, t => {
    const { row } = ingest(t, { usage: { input_tokens: count, output_tokens: 0 } });
    closeTo(row.dimensions.cost, expected);
  });
}
for (const [model, tier, count, expected] of [
  ['gpt-6.1-sol', 'standard', 272000, 0.544], ['gpt-6.1-sol', 'standard', 272001, 1.088004],
  ['gpt-6.1-sol', 'priority', 272001, 2.176008],
  ['gpt-6-sol', 'standard', 272000, 0.544], ['gpt-6-sol', 'standard', 272001, 1.088004],
  ['gpt-6-sol', 'priority', 272001, 2.176008], ['gpt-6-luna', 'standard', 272001, 0.0544002],
  ['gpt-6-luna', 'priority', 272001, 0.1088004]
]) {
  test(`${model} ${tier} switches to long-context prices strictly above 272K (${count})`, t => {
    const { row } = ingest(t, { model, serviceTier: tier, usage: { input_tokens: count, output_tokens: 0 } });
    closeTo(row.dimensions.cost, expected);
  });
}
// GPT-5.5/5.4 standard requests above 272K bill the whole request at 2x input
// and 1.5x output; their Priority rates publish no long-context tier.
for (const [model, tier, count, expected] of [
  ['gpt-5.5', 'standard', 272000, 1.66], ['gpt-5.5', 'standard', 272001, 3.17001],
  ['gpt-5.4', 'standard', 272000, 0.83], ['gpt-5.4', 'standard', 272001, 1.585005],
  ['gpt-5.5', 'priority', 300000, 4.5], ['gpt-5.4', 'priority', 300000, 1.8]
]) {
  test(`${model} ${tier} context pricing at ${count} input tokens`, t => {
    const { row } = ingest(t, { model, serviceTier: tier, usage: { input_tokens: count, output_tokens: 10000 } });
    closeTo(row.dimensions.cost, expected);
  });
}
test('long context includes cached and write input; Fast stacks for the whole request', t => {
  const { row } = ingest(t, { serviceTier: 'priority', usage: {
    input_tokens: 300000, input_tokens_details: { cached_tokens: 200000, cache_write_tokens: 50000 }, output_tokens: 10000
  } });
  assert.equal(row.dimensions.uncached_input, 50000);
  assert.equal(row.dimensions.cache_creation, 50000);
  closeTo(row.dimensions.cost, 6.8); // 50K*40 + 200K*4 + 50K*50 + 10K*150
});
test('native Codex cache fields win over API and legacy variants, including explicit zero', t => {
  const { row } = ingest(t, { usage: {
    input_tokens: 1000, cached_input_tokens: 0, cache_write_input_tokens: 0,
    input_tokens_details: { cached_tokens: 500, cache_write_tokens: 200 }, cache_creation_input_tokens: 100
  } });
  assert.equal(row.dimensions.cache_read, 0);
  assert.equal(row.dimensions.cache_creation, 0);
  closeTo(row.dimensions.cost, 0.01);
});
test('legacy cache creation remains accepted', t => {
  const { row } = ingest(t, { usage: { input_tokens: 1000, cache_creation_input_tokens: 100 } });
  assert.equal(row.dimensions.cache_creation, 100);
  closeTo(row.dimensions.cost, 0.01025);
});
test('cumulative-only fallback does not infer a request context tier', t => {
  const { row } = ingest(t, { cumulative: true, usage: { input_tokens: 1000000 } });
  closeTo(row.dimensions.cost, 10);
  assert.equal(row.dimensions.cost_estimation_note, 'cannot_determine_request_context');
});
test('exact override wins independent of insertion order; only dated snapshots inherit', () => {
  const custom = { input: 9, output: 8, cacheRead: 7, cacheCreation: 6 };
  const collector = new CodexRolloutCollector({}, { runtimeModelPrices: { codex: {
    'gpt-5': DEFAULT_CODEX_MODEL_PRICES['gpt-5'], ...DEFAULT_CODEX_MODEL_PRICES,
    'gpt-5.6-sol-2026-07-09': custom
  } } });
  assert.equal(collector._resolveModelPrice('gpt-5.6-sol-2026-07-09'), custom);
  assert.equal(collector._resolveModelPrice('gpt-5.6-sol'), DEFAULT_CODEX_MODEL_PRICES['gpt-5.6-sol']);
  assert.equal(collector._resolveModelPrice('gpt-6-astra-2026-09-10'), DEFAULT_CODEX_MODEL_PRICES['gpt-6-astra']);
  for (const model of ['gpt-5.7', 'gpt-5.6-sol-next', 'gpt-6-astra-pro', 'gpt-5.6-terra2']) {
    assert.equal(collector._resolveModelPrice(model), null);
  }
});
test('configured price rows replace defaults, including long-context treatment', () => {
  const custom = { input: 1, output: 1, cacheRead: 1, cacheCreation: 1 };
  withConfig({ runtimeModelPrices: { codex: { 'gpt-6-astra': custom } },
    runtimeServiceTierModelPrices: { codex: { priority: { 'gpt-6-astra': { ...custom, longContext: {
      inputTokenThreshold: 400000, input: 3, output: 3, cacheRead: 3, cacheCreation: 3
    } } } } } }, config => {
    const collector = new CodexRolloutCollector({}, config);
    assert.deepEqual(collector._resolveModelPrice('gpt-6-astra'), custom);
    closeTo(collector._calculateCost({ input: 500000, output: 0, cache_read: 0, cache_creation: 0 }, collector._resolveModelPrice('gpt-6-astra')), 0.5);
    closeTo(collector._calculateCost({ input: 500000, output: 0, cache_read: 0, cache_creation: 0 }, collector._resolveModelPrice('gpt-6-astra', 'priority')), 1.5);
  });
});
for (const tier of ['standard', 'priority']) {
  test(`legacy custom Codex prefixes still match suffixes (${tier})`, () => {
    const custom = { input: 9, output: 8, cacheRead: 7, cacheCreation: 6 };
    const specific = { ...custom, input: 3 };
    withConfig({
      runtimeModelPrices: { codex: { 'vendor-model': custom, 'vendor-model-pro': specific } },
      runtimeServiceTierModelPrices: { codex: { priority: { 'vendor-model': custom, 'vendor-model-pro': specific } } }
    }, config => {
      const collector = new CodexRolloutCollector({}, config);
      assert.deepEqual(collector._resolveModelPrice('vendor-model-lite', tier), custom);
      assert.deepEqual(collector._resolveModelPrice('vendor-model-pro', tier), specific);
      assert.deepEqual(collector._resolveModelPrice('vendor-model-pro-next', tier), specific);
    });
  });
  test(`built-in Codex IDs stay exact/date even when overridden (${tier})`, () => {
    const custom = { input: 9, output: 8, cacheRead: 7, cacheCreation: 6 };
    withConfig({
      runtimeModelPrices: { codex: { 'gpt-5': custom } },
      runtimeServiceTierModelPrices: { codex: { priority: { 'gpt-5': custom } } }
    }, config => {
      const collector = new CodexRolloutCollector({}, config);
      assert.deepEqual(collector._resolveModelPrice('gpt-5', tier), custom);
      assert.deepEqual(collector._resolveModelPrice('gpt-5-2026-09-15', tier), custom);
      assert.equal(collector._resolveModelPrice('gpt-5.7', tier), null);
    });
  });
}
test('replaying an already stored usage row does not reprice history', t => {
  const old = { ...defaults, runtimeModelPrices: { codex: { 'gpt-6-astra': { input: 1, output: 1, cacheRead: 1, cacheCreation: 1 } } } };
  const { store, info, mapping, row } = ingest(t, { config: old, usage: { input_tokens: 300000, cache_write_input_tokens: 100000 } });
  const current = new CodexRolloutCollector(store, defaults);
  assert.equal(current._ingestTokenCount(info, '2026-09-15T00:00:00Z', mapping), 0);
  assert.deepEqual(store.queryMetrics({ name: 'usage_event' })[0], row);
});
for (const supplied of [null, {}]) {
  test(`Claude missing ${supplied === null ? 'file' : 'setting'} uses model Fast defaults`, () => {
    withConfig(supplied, config => {
      const collector = new ConversationCollector({}, config);
      for (const model of ['claude-opus-5', 'claude-opus-4-8']) {
        closeTo(collector._calculateCost({ input_tokens: 1000000 }, collector._resolveModelPrice(model), 'fast'), 10);
      }
      closeTo(collector._calculateCost({ input_tokens: 1000000 }, collector._resolveModelPrice('claude-opus-4-5'), 'fast'), 30);
    });
  });
}
for (const supplied of [{ fastModeMultiplier: 6 }, { runtimeFastModeMultipliers: { claude: 6 } }, { fastModeMultiplier: 7, runtimeFastModeMultipliers: { claude: 4 } }]) {
  test(`Claude explicit multiplier wins: ${JSON.stringify(supplied)}`, () => {
    withConfig(supplied, config => {
      const collector = new ConversationCollector({}, config);
      const multiplier = supplied.runtimeFastModeMultipliers?.claude ?? supplied.fastModeMultiplier;
      closeTo(collector._calculateCost({ input_tokens: 1000000 }, collector._resolveModelPrice('claude-opus-5'), 'fast'), 5 * multiplier);
    });
  });
}
test('Claude current prices and new Mythos cache discounts remain model-specific', () => {
  const collector = new ConversationCollector({}, defaults);
  for (const [model, cost] of [['claude-fable-5-1', 0.25], ['claude-mythos-5-1', 0.25], ['claude-mythos-5', 1], ['claude-opus-5', 0.5], ['claude-sonnet-5', 0.2]]) {
    closeTo(collector._calculateCost({ cache_read_input_tokens: 1000000 }, collector._resolveModelPrice(model), 'standard'), cost);
  }
});
test('Claude Opus 5.5 uses its own prices instead of the Opus 5 prefix', () => {
  const collector = new ConversationCollector({}, defaults);
  for (const model of ['claude-opus-5-5', 'claude-opus-5-5[1m]']) {
    const price = collector._resolveModelPrice(model);
    assert.equal(price, DEFAULT_CLAUDE_MODEL_PRICES['claude-opus-5-5']);
    closeTo(collector._calculateCost({ input_tokens: 1000000, output_tokens: 1000000 }, price, 'standard'), 24);
    closeTo(collector._calculateCost({ input_tokens: 1000000, output_tokens: 1000000 }, price, 'fast'), 48);
    closeTo(collector._calculateCost({ cache_read_input_tokens: 1000000 }, price, 'standard'), 0.2);
  }
  assert.equal(collector._resolveModelPrice('claude-opus-5[1m]'), DEFAULT_CLAUDE_MODEL_PRICES['claude-opus-5']);
});
