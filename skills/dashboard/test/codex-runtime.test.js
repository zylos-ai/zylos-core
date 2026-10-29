import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Store } from '../src/lib/store.js';
import { Sanitizer } from '../src/lib/sanitizer.js';
import { MetricResolver } from '../src/lib/metric-resolver.js';
import { CodexRolloutCollector } from '../src/lib/collectors/codex-rollout-collector.js';
import { DEFAULT_CODEX_MODEL_PRICES, DEFAULT_CODEX_PRIORITY_MODEL_PRICES } from '../src/lib/config.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codex-runtime-test-'));
}

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, 'fixtures/codex', name), 'utf8'));
}

function usageEvents(store) {
  return store.queryMetrics({ name: 'usage_event' });
}

function collectRateLimitDimensions(rateLimits, expectedWritten = 1) {
  const dir = tmpDir();
  const rolloutPath = path.join(dir, 'rollout-rate-limits.jsonl');
  const lines = [
    {
      type: 'session_meta',
      timestamp: '2026-08-24T01:00:00.000Z',
      payload: { id: 'codex-rate-limit-session', originator: 'codex-tui' }
    },
    {
      type: 'event_msg',
      timestamp: '2026-08-24T01:00:01.000Z',
      payload: {
        type: 'token_count',
        rate_limits: rateLimits,
        info: { model_context_window: 200000 }
      }
    }
  ];
  fs.writeFileSync(rolloutPath, `${lines.map(line => JSON.stringify(line)).join('\n')}\n`);

  const store = new Store(path.join(dir, 'dashboard.db'));
  store.upsertCodexRolloutPath({
    runtime: 'codex',
    sessionId: 'codex-rate-limit-session',
    transcriptPath: rolloutPath,
    lastEventAt: '2026-08-24T01:00:00.000Z'
  });

  const collector = new CodexRolloutCollector(store, { modelPrices: {} });
  assert.equal(collector.collect(), expectedWritten);
  const [event] = usageEvents(store);
  const dimensions = event?.dimensions ?? null;

  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
  return dimensions;
}

test('Sanitizer preserves safe Codex locator metadata and strips raw payload fields', () => {
  const raw = fixture('pre-tool-use.json');
  const sanitizer = new Sanitizer('/tmp/zylos');
  const sanitized = sanitizer.sanitizeHookPayload('PreToolUse', raw);

  assert.equal(sanitized.session_id, 'codex-session-1');
  assert.equal(sanitized.metadata.turn_id, 'codex-turn-1');
  assert.equal(sanitized.metadata.transcript_path, '/tmp/zylos-dashboard-codex/rollout-codex-session-1.jsonl');
  assert.equal(sanitized.metadata.model, 'gpt-5.3-codex');
  assert.equal(sanitized.metadata.permission_mode, 'default');
  assert.equal(sanitized.metadata.tool_name, 'functions.exec_command');
  assert.equal(sanitized.metadata.tool_use_id, 'call-1');
  assert.equal(sanitized.metadata.tool_input, undefined);
  assert.equal(sanitized.metadata.prompt, undefined);
});

test('Store persists hook-derived Codex rollout path and cursor', () => {
  const dir = tmpDir();
  const store = new Store(path.join(dir, 'dashboard.db'));

  store.upsertCodexRolloutPath({
    runtime: 'codex',
    sessionId: 'codex-session-1',
    transcriptPath: '/tmp/zylos-dashboard-codex/rollout-codex-session-1.jsonl',
    lastEventAt: '2026-05-23T01:00:00.000Z'
  });
  store.upsertCodexRolloutCursor({
    transcriptPath: '/tmp/zylos-dashboard-codex/rollout-codex-session-1.jsonl',
    byteOffset: 42,
    sessionId: 'codex-session-1'
  });

  const mapping = store.latestCodexRolloutPath('codex');
  assert.equal(mapping.session_id, 'codex-session-1');
  assert.equal(mapping.transcript_path, '/tmp/zylos-dashboard-codex/rollout-codex-session-1.jsonl');

  const cursor = store.getCodexRolloutCursor(mapping.transcript_path);
  assert.equal(cursor.byte_offset, 42);
  assert.equal(cursor.session_id, 'codex-session-1');

  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CodexRolloutCollector reports unavailable without hook transcript path', () => {
  const dir = tmpDir();
  const store = new Store(path.join(dir, 'dashboard.db'));
  const collector = new CodexRolloutCollector(store, { modelPrices: {} });

  assert.equal(collector.collect(), 0);
  const health = store.getSourceHealth().find(h => h.name === 'codex_rollout');
  assert.equal(health.status, 'unavailable');
  assert.equal(health.extra.reason, 'no_hook_transcript_path');

  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CodexRolloutCollector ingests rollout fixture metrics from hook-derived path only', () => {
  const dir = tmpDir();
  const rolloutPath = path.join(dir, 'rollout-codex-session-1.jsonl');
  const fixtureText = fs.readFileSync(path.resolve(import.meta.dirname, 'fixtures/codex/rollout.jsonl'), 'utf8');
  fs.writeFileSync(rolloutPath, fixtureText);

  const store = new Store(path.join(dir, 'dashboard.db'));
  store.upsertCodexRolloutPath({
    runtime: 'codex',
    sessionId: 'codex-session-1',
    transcriptPath: rolloutPath,
    lastEventAt: '2026-05-23T01:00:00.000Z'
  });

  const collector = new CodexRolloutCollector(store, {
    modelPrices: {
      'gpt-5.3-codex': { input: 2, output: 8, cacheRead: 0.5, cacheCreation: 2 }
    }
  });
  const runtimeUpdates = [];
  collector._onRuntimeInfo = (info) => runtimeUpdates.push(info);

  const written = collector.collect();
  assert.equal(written, 5);
  assert.equal(runtimeUpdates.length, 1);
  assert.equal(runtimeUpdates[0].model_id, 'gpt-5.3-codex');
  assert.equal(runtimeUpdates[0].session_id, 'codex-session-1');
  assert.equal(runtimeUpdates[0].cli_version, '0.130.0');
  assert.equal(collector.getRuntimeInfo().model_id, 'gpt-5.3-codex');
  assert.equal(collector.getRuntimeInfo().cli_version, '0.130.0');

  const tokens = usageEvents(store);
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].runtime, 'codex');
  assert.equal(tokens[0].metric_value, 12000);
  assert.equal(tokens[0].dimensions.model, 'gpt-5.3-codex');
  assert.equal(tokens[0].dimensions.output, 800);
  assert.equal(tokens[0].dimensions.reasoning, 150);
  assert.equal(tokens[0].dimensions.total_input, 12000);
  assert.equal(tokens[0].dimensions.uncached_input, 9000);
  assert.equal(tokens[0].dimensions.runtime_semantics, 'openai_input_includes_cached');
  assert.equal(tokens[0].dimensions.context_pct, 6);
  assert.equal(tokens[0].dimensions.rate_limit, 37.5);
  assert.equal(tokens[0].dimensions.rate_limit_7d, 12.25);
  const fixtureLines = fixtureText.split('\n');
  const tokenOffset = Buffer.byteLength(`${fixtureLines[0]}\n${fixtureLines[1]}\n`, 'utf8');
  assert.equal(tokens[0].dimensions.rollout_offset, tokenOffset);
  assert.equal(tokens[0].dimensions.rollout_line, 3);
  assert.ok(tokens[0].dimensions.event_id.startsWith(`token_count-codex-session-1-${tokenOffset}-3-`));

  const aggregateTokens = store.aggregateTokens({ sessionId: 'codex-session-1' });
  assert.equal(aggregateTokens.input, 12000);
  assert.equal(aggregateTokens.cache_read, 3000);
  assert.equal(aggregateTokens.cache_rate, 0.25);

  const tokenSeries = store.aggregateTokenSeries({
    since: '2026-05-23T00:00:00.000Z',
    until: '2026-05-23T02:00:00.000Z',
    bucketSeconds: 3600
  });
  assert.equal(tokenSeries.length, 1);
  assert.equal(tokenSeries[0].input_sum, 12000);
  assert.equal(tokenSeries[0].cache_read_sum, 3000);
  assert.equal(tokenSeries[0].cache_rate, 0.25);

  assert.equal(tokens[0].dimensions.cache_hit_rate, 0.25);
  assert.equal(tokens[0].dimensions.cost_confidence, 'estimated');
  assert.ok(Math.abs(tokens[0].dimensions.cost - 0.0259) < 0.000001);

  const ttft = store.queryMetrics({ name: 'ttft' });
  assert.equal(ttft[0].metric_value, 987);

  const duration = store.queryMetrics({ name: 'turn_duration' });
  assert.equal(duration[0].metric_value, 45123);
  assert.equal(duration[0].dimensions.rollout_line, 4);

  const [turnEvent] = store.queryEvents({ types: ['turn_complete'] });
  assert.equal(turnEvent.runtime, 'codex');
  assert.equal(turnEvent.category, 'turn');
  assert.equal(turnEvent.summary, 'Turn completed');
  assert.equal(turnEvent.duration_ms, 45123);
  assert.equal(turnEvent.metadata.ttft_ms, 987);
  assert.equal(turnEvent.metadata.source_event, 'task_complete');
  assert.equal(turnEvent.metadata.rollout_line, 4);

  const cursor = store.getCodexRolloutCursor(rolloutPath);
  assert.equal(cursor.byte_offset, fs.statSync(rolloutPath).size);

  assert.equal(collector.collect(), 0);

  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CodexRolloutCollector routes a primary-only seven-day limit by window duration', () => {
  const dimensions = collectRateLimitDimensions({
    primary: { used_percent: 12, window_minutes: 10080, resets_at: 1780083600 }
  });

  assert.equal(dimensions.rate_limit, undefined);
  assert.equal(dimensions.rate_limit_resets_at, undefined);
  assert.equal(dimensions.rate_limit_7d, 12);
  assert.equal(dimensions.rate_limit_7d_window_minutes, 10080);
  assert.equal(dimensions.rate_limit_7d_resets_at, 1780083600);
});

test('CodexRolloutCollector routes a primary-only five-hour limit by window duration', () => {
  const dimensions = collectRateLimitDimensions({
    primary: { used_percent: 37.5, window_minutes: 300, resets_at: 1779516000 }
  });

  assert.equal(dimensions.rate_limit, 37.5);
  assert.equal(dimensions.rate_limit_window_minutes, 300);
  assert.equal(dimensions.rate_limit_resets_at, 1779516000);
  assert.equal(dimensions.rate_limit_7d, undefined);
  assert.equal(dimensions.rate_limit_7d_resets_at, undefined);
});

test('CodexRolloutCollector ignores primary and secondary roles when routing limits', () => {
  const dimensions = collectRateLimitDimensions({
    primary: { used_percent: 12.25, window_minutes: 10080, resets_at: 1780083600 },
    secondary: { used_percent: 37.5, window_minutes: 300, resets_at: 1779516000 }
  });

  assert.equal(dimensions.rate_limit, 37.5);
  assert.equal(dimensions.rate_limit_window_minutes, 300);
  assert.equal(dimensions.rate_limit_7d, 12.25);
  assert.equal(dimensions.rate_limit_7d_window_minutes, 10080);
});

test('CodexRolloutCollector does not guess a slot for unknown window durations', () => {
  const dimensions = collectRateLimitDimensions({
    primary: { used_percent: 50, window_minutes: 1440, resets_at: 1780083600 }
  }, 0);

  assert.equal(dimensions, null);
});

test('CodexRolloutCollector bounds each collect pass by complete lines', () => {
  const dir = tmpDir();
  const rolloutPath = path.join(dir, 'rollout-codex-session-1.jsonl');
  const fixtureText = fs.readFileSync(path.resolve(import.meta.dirname, 'fixtures/codex/rollout.jsonl'), 'utf8');
  fs.writeFileSync(rolloutPath, fixtureText);

  const store = new Store(path.join(dir, 'dashboard.db'));
  store.upsertCodexRolloutPath({
    runtime: 'codex',
    sessionId: 'codex-session-1',
    transcriptPath: rolloutPath,
    lastEventAt: '2026-05-23T01:00:00.000Z'
  });

  const collector = new CodexRolloutCollector(store, {
    modelPrices: {
      'gpt-5.3-codex': { input: 2, output: 8, cacheRead: 0.5, cacheCreation: 2 }
    },
    codexRolloutMaxLinesPerCollect: 2
  });

  assert.equal(collector.collect(), 0);
  const fixtureLines = fixtureText.split('\n');
  const firstCursor = store.getCodexRolloutCursor(rolloutPath);
  assert.equal(firstCursor.byte_offset, Buffer.byteLength(`${fixtureLines[0]}\n${fixtureLines[1]}\n`, 'utf8'));

  assert.equal(collector.collect(), 4);
  const secondCursor = store.getCodexRolloutCursor(rolloutPath);
  assert.equal(secondCursor.byte_offset, Buffer.byteLength(`${fixtureLines[0]}\n${fixtureLines[1]}\n${fixtureLines[2]}\n${fixtureLines[3]}\n`, 'utf8'));
  const health = store.getSourceHealth().find(h => h.name === 'jsonl_usage' && h.signal_type === 'runtime_progress');
  assert.equal(health.status, 'healthy');

  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CodexRolloutCollector advances cursor past oversized rollout lines', () => {
  const dir = tmpDir();
  const rolloutPath = path.join(dir, 'rollout-codex-session-1.jsonl');
  const oversizedLine = 'x'.repeat(5000);
  const sessionMeta = '{"type":"session_meta","timestamp":"2026-05-23T01:00:00.000Z","payload":{"id":"codex-session-1","cli_version":"0.130.0"}}';
  fs.writeFileSync(rolloutPath, `${oversizedLine}\n${sessionMeta}\n`);

  const store = new Store(path.join(dir, 'dashboard.db'));
  store.upsertCodexRolloutPath({
    runtime: 'codex',
    sessionId: 'codex-session-1',
    transcriptPath: rolloutPath,
    lastEventAt: '2026-05-23T01:00:00.000Z'
  });

  const collector = new CodexRolloutCollector(store, {
    modelPrices: {},
    codexRolloutMaxBytesPerCollect: 4096
  });

  assert.equal(collector.collect(), 0);
  const skippedCursor = store.getCodexRolloutCursor(rolloutPath);
  assert.equal(skippedCursor.byte_offset, Buffer.byteLength(`${oversizedLine}\n`, 'utf8'));
  const skipHealth = store.getSourceHealth().find(h => h.name === 'codex_rollout');
  assert.equal(skipHealth.extra.reason, 'oversized_line_skipped');

  assert.equal(collector.collect(), 0);
  assert.equal(collector.getRuntimeInfo().cli_version, '0.130.0');
  const finalCursor = store.getCodexRolloutCursor(rolloutPath);
  assert.equal(finalCursor.byte_offset, fs.statSync(rolloutPath).size);

  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CodexRolloutCollector extracts cli_version from session_meta without a model', () => {
  const dir = tmpDir();
  const rolloutPath = path.join(dir, 'rollout-codex-session-1.jsonl');
  fs.writeFileSync(
    rolloutPath,
    '{"type":"session_meta","timestamp":"2026-05-23T01:00:00.000Z","payload":{"id":"codex-session-1","cli_version":"0.130.0"}}\n'
  );

  const store = new Store(path.join(dir, 'dashboard.db'));
  store.upsertCodexRolloutPath({
    runtime: 'codex',
    sessionId: 'codex-session-1',
    transcriptPath: rolloutPath,
    lastEventAt: '2026-05-23T01:00:00.000Z'
  });

  const collector = new CodexRolloutCollector(store, { modelPrices: {} });
  const runtimeUpdates = [];
  collector._onRuntimeInfo = (info) => runtimeUpdates.push(info);

  assert.equal(collector.collect(), 0);
  assert.equal(runtimeUpdates.length, 1);
  assert.equal(collector.getRuntimeInfo().cli_version, '0.130.0');
  assert.equal(collector.getRuntimeInfo().model_id, undefined);

  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CodexRolloutCollector preserves cli_version when turn_context arrives later', () => {
  const dir = tmpDir();
  const rolloutPath = path.join(dir, 'rollout-codex-session-1.jsonl');
  fs.writeFileSync(
    rolloutPath,
    [
      '{"type":"session_meta","timestamp":"2026-05-23T01:00:00.000Z","payload":{"id":"codex-session-1","cli_version":"0.130.0"}}',
      '{"type":"turn_context","timestamp":"2026-05-23T01:00:01.000Z","payload":{"model":"gpt-5.3-codex","service_tier":"priority"}}',
      ''
    ].join('\n')
  );

  const store = new Store(path.join(dir, 'dashboard.db'));
  store.upsertCodexRolloutPath({
    runtime: 'codex',
    sessionId: 'codex-session-1',
    transcriptPath: rolloutPath,
    lastEventAt: '2026-05-23T01:00:01.000Z'
  });

  const collector = new CodexRolloutCollector(store, { modelPrices: {} });
  collector.collect();

  assert.equal(collector.getRuntimeInfo().cli_version, '0.130.0');
  assert.equal(collector.getRuntimeInfo().model_id, 'gpt-5.3-codex');
  assert.equal(collector.getRuntimeInfo().service_tier, 'priority');

  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CodexRolloutCollector preserves model and service tier when session_meta arrives later', () => {
  const dir = tmpDir();
  const rolloutPath = path.join(dir, 'rollout-codex-session-1.jsonl');
  const firstLine = '{"type":"turn_context","timestamp":"2026-05-23T01:00:00.000Z","payload":{"model":"gpt-5.3-codex","service_tier":"priority"}}\n';
  fs.writeFileSync(rolloutPath, firstLine);

  const store = new Store(path.join(dir, 'dashboard.db'));
  store.upsertCodexRolloutPath({
    runtime: 'codex',
    sessionId: 'codex-session-1',
    transcriptPath: rolloutPath,
    lastEventAt: '2026-05-23T01:00:00.000Z'
  });

  const collector = new CodexRolloutCollector(store, { modelPrices: {} });
  collector.collect();
  fs.appendFileSync(
    rolloutPath,
    '{"type":"session_meta","timestamp":"2026-05-23T01:00:01.000Z","payload":{"id":"codex-session-1","cli_version":"0.130.0"}}\n'
  );

  collector.collect();

  assert.equal(collector.getRuntimeInfo().model_id, 'gpt-5.3-codex');
  assert.equal(collector.getRuntimeInfo().service_tier, 'priority');
  assert.equal(collector.getRuntimeInfo().cli_version, '0.130.0');

  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CodexRolloutCollector backfills cli_version when cursor is already at EOF', () => {
  const dir = tmpDir();
  const rolloutPath = path.join(dir, 'rollout-codex-session-1.jsonl');
  fs.writeFileSync(
    rolloutPath,
    '{"type":"session_meta","timestamp":"2026-05-23T01:00:00.000Z","payload":{"id":"codex-session-1","cli_version":"0.130.0"}}\n'
  );

  const store = new Store(path.join(dir, 'dashboard.db'));
  store.upsertCodexRolloutPath({
    runtime: 'codex',
    sessionId: 'codex-session-1',
    transcriptPath: rolloutPath,
    lastEventAt: '2026-05-23T01:00:00.000Z'
  });
  store.upsertCodexRolloutCursor({
    transcriptPath: rolloutPath,
    byteOffset: fs.statSync(rolloutPath).size,
    sessionId: 'codex-session-1'
  });

  const collector = new CodexRolloutCollector(store, { modelPrices: {} });

  assert.equal(collector.collect(), 0);
  assert.equal(collector.getRuntimeInfo().cli_version, '0.130.0');

  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CodexRolloutCollector ignores session_meta without cli_version and keeps installed-version fallback available', () => {
  const dir = tmpDir();
  const rolloutPath = path.join(dir, 'rollout-codex-session-1.jsonl');
  fs.writeFileSync(
    rolloutPath,
    [
      '{"type":"session_meta","timestamp":"2026-05-23T01:00:00.000Z","payload":{"id":"codex-session-1"}}',
      '{"type":"turn_context","timestamp":"2026-05-23T01:00:01.000Z","payload":{"model":"gpt-5.3-codex"}}',
      ''
    ].join('\n')
  );

  const store = new Store(path.join(dir, 'dashboard.db'));
  store.upsertCodexRolloutPath({
    runtime: 'codex',
    sessionId: 'codex-session-1',
    transcriptPath: rolloutPath,
    lastEventAt: '2026-05-23T01:00:01.000Z'
  });

  const collector = new CodexRolloutCollector(store, { modelPrices: {} });
  collector.collect();

  assert.equal(collector.getRuntimeInfo().model_id, 'gpt-5.3-codex');
  assert.equal(collector.getRuntimeInfo().cli_version, undefined);

  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CodexRolloutCollector does not carry cli_version across active session changes', () => {
  const dir = tmpDir();
  const rolloutAPath = path.join(dir, 'rollout-codex-session-a.jsonl');
  const rolloutBPath = path.join(dir, 'rollout-codex-session-b.jsonl');
  fs.writeFileSync(
    rolloutAPath,
    [
      '{"type":"session_meta","timestamp":"2026-05-23T01:00:00.000Z","payload":{"id":"codex-session-a","cli_version":"0.130.0"}}',
      '{"type":"turn_context","timestamp":"2026-05-23T01:00:01.000Z","payload":{"model":"gpt-5.3-codex"}}',
      ''
    ].join('\n')
  );
  fs.writeFileSync(
    rolloutBPath,
    '{"type":"turn_context","timestamp":"2026-05-23T01:01:00.000Z","payload":{"model":"gpt-5.5"}}\n'
  );

  const store = new Store(path.join(dir, 'dashboard.db'));
  store.upsertCodexRolloutPath({
    runtime: 'codex',
    sessionId: 'codex-session-a',
    transcriptPath: rolloutAPath,
    lastEventAt: '2026-05-23T01:00:01.000Z'
  });

  const collector = new CodexRolloutCollector(store, { modelPrices: {} });
  collector.collect();

  assert.equal(collector.getRuntimeInfo().session_id, 'codex-session-a');
  assert.equal(collector.getRuntimeInfo().model_id, 'gpt-5.3-codex');
  assert.equal(collector.getRuntimeInfo().cli_version, '0.130.0');

  store.upsertCodexRolloutPath({
    runtime: 'codex',
    sessionId: 'codex-session-b',
    transcriptPath: rolloutBPath,
    lastEventAt: '2026-05-23T01:01:00.000Z'
  });
  store.db.prepare(`
    UPDATE codex_rollout_paths
    SET updated_at = '2099-05-23 01:01:00'
    WHERE session_id = 'codex-session-b'
  `).run();
  collector.collect();

  assert.equal(collector.getRuntimeInfo().session_id, 'codex-session-b');
  assert.equal(collector.getRuntimeInfo().model_id, 'gpt-5.5');
  assert.equal(collector.getRuntimeInfo().cli_version, undefined);

  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CodexRolloutCollector deduplicates metrics when rollout cursor is replayed', () => {
  const dir = tmpDir();
  const rolloutPath = path.join(dir, 'rollout-codex-session-1.jsonl');
  fs.copyFileSync(path.resolve(import.meta.dirname, 'fixtures/codex/rollout.jsonl'), rolloutPath);

  const store = new Store(path.join(dir, 'dashboard.db'));
  store.upsertCodexRolloutPath({
    runtime: 'codex',
    sessionId: 'codex-session-1',
    transcriptPath: rolloutPath,
    lastEventAt: '2026-05-23T01:00:00.000Z'
  });

  const collector = new CodexRolloutCollector(store, {
    modelPrices: {
      'gpt-5.3-codex': { input: 2, output: 8, cacheRead: 0.5, cacheCreation: 2 }
    }
  });
  const liveMetrics = [];
  collector._onMetric = (metric) => liveMetrics.push(metric);

  assert.equal(collector.collect(), 5);
  assert.deepEqual(
    liveMetrics.map(m => m.metric_name),
    [
      'usage_event',
      'turn_duration',
      'ttft'
    ]
  );
  store.upsertCodexRolloutCursor({
    transcriptPath: rolloutPath,
    byteOffset: 0,
    sessionId: 'codex-session-1'
  });

  assert.equal(collector.collect(), 0);
  assert.equal(liveMetrics.length, 3);
  assert.equal(usageEvents(store).length, 1);
  assert.equal(store.queryMetrics({ name: 'ttft' }).length, 1);
  assert.equal(store.queryMetrics({ name: 'turn_duration' }).length, 1);
  assert.equal(store.queryEvents({ types: ['turn_complete'] }).length, 1);

  const aggregateTokens = store.aggregateTokens({ sessionId: 'codex-session-1' });
  assert.equal(aggregateTokens.input, 12000);
  assert.equal(aggregateTokens.output, 800);

  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Project distribution uses canonical total input without double-counting Codex cached tokens', () => {
  const dir = tmpDir();
  const store = new Store(path.join(dir, 'dashboard.db'));

  store.insertMetric({
    timestamp: '2026-05-23T01:00:01.000Z',
    runtime: 'codex',
    session_id: 'codex-session-1',
    metric_name: 'api_request_tokens',
    metric_value: 12000,
    dimensions: {
      input: 12000,
      total_input: 12000,
      uncached_input: 9000,
      output: 800,
      cache_read: 3000,
      cache_creation: 0,
      runtime_semantics: 'openai_input_includes_cached',
      projects: ['zylos-dashboard']
    },
    source: 'jsonl_usage',
    confidence: 'actual'
  });

  const distribution = store.getProjectDistribution({
    since: '2026-05-23T00:00:00.000Z',
    until: '2026-05-23T02:00:00.000Z'
  });

  assert.equal(distribution.totalTokens, 12800);
  assert.equal(distribution.totalOutput, 800);
  assert.equal(distribution.items[0].name, 'zylos-dashboard');

  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Project distribution falls back to Codex rollout project signals', () => {
  const dir = tmpDir();
  const rolloutPath = path.join(dir, 'rollout-codex-session-1.jsonl');
  fs.writeFileSync(rolloutPath, [
    JSON.stringify({
      type: 'response_item',
      timestamp: '2026-05-23T01:00:01.000Z',
      payload: {
        type: 'function_call',
        name: 'exec_command',
        arguments: JSON.stringify({
          cmd: 'npm test',
          workdir: '/Users/howard/zylos/workspace/zylos-dashboard'
        }),
        call_id: 'call-project'
      }
    }),
    ''
  ].join('\n'));

  const store = new Store(path.join(dir, 'dashboard.db'));
  store.upsertCodexRolloutPath({
    runtime: 'codex',
    sessionId: 'codex-session-1',
    transcriptPath: rolloutPath,
    lastEventAt: '2026-05-23T01:00:01.000Z'
  });
  store.insertMetric({
    timestamp: '2026-05-23T01:00:02.000Z',
    runtime: 'codex',
    session_id: 'codex-session-1',
    metric_name: 'api_request_tokens',
    metric_value: 12000,
    dimensions: {
      input: 12000,
      total_input: 12000,
      output: 800,
      cache_read: 3000,
      cache_creation: 0,
      runtime_semantics: 'openai_input_includes_cached'
    },
    source: 'jsonl_usage',
    confidence: 'actual'
  });

  const distribution = store.getProjectDistribution({
    since: '2026-05-23T00:00:00.000Z',
    until: '2026-05-23T02:00:00.000Z'
  });

  assert.equal(distribution.totalTokens, 12800);
  assert.equal(distribution.items.length, 1);
  assert.equal(distribution.items[0].name, 'zylos-dashboard');
  assert.equal(distribution.items[0].outputTokens, 800);

  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CodexRolloutCollector uses rollout position identity when response item call_id is absent', () => {
  const dir = tmpDir();
  const rolloutPath = path.join(dir, 'rollout-codex-session-1.jsonl');
  const line = JSON.stringify({
    type: 'response_item',
    timestamp: '2026-05-23T01:00:04.000Z',
    payload: {
      type: 'function_call',
      name: 'functions.exec_command',
      arguments: JSON.stringify({ cmd: 'npm test' })
    }
  });
  fs.writeFileSync(rolloutPath, `${line}\n`);

  const store = new Store(path.join(dir, 'dashboard.db'));
  store.upsertCodexRolloutPath({
    runtime: 'codex',
    sessionId: 'codex-session-1',
    transcriptPath: rolloutPath,
    lastEventAt: '2026-05-23T01:00:00.000Z'
  });

  const collector = new CodexRolloutCollector(store, { modelPrices: {} });
  assert.equal(collector.collect(), 1);

  const [event] = store.queryEvents({ limit: 10, order: 'asc' });
  assert.equal(event.metadata.call_id, null);
  assert.equal(event.metadata.rollout_offset, 0);
  assert.equal(event.metadata.rollout_line, 1);
  assert.ok(event.ingest_id.includes('response_item-codex-session-1-0-1-'));

  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CodexRolloutCollector does not backfill legacy rate-limit rows when cursor already passed initial rollout event', () => {
  const dir = tmpDir();
  const rolloutPath = path.join(dir, 'rollout-codex-session-1.jsonl');
  fs.copyFileSync(path.resolve(import.meta.dirname, 'fixtures/codex/rollout.jsonl'), rolloutPath);

  const store = new Store(path.join(dir, 'dashboard.db'));
  store.upsertCodexRolloutPath({
    runtime: 'codex',
    sessionId: 'codex-session-1',
    transcriptPath: rolloutPath,
    lastEventAt: '2026-05-23T01:00:00.000Z'
  });
  store.upsertCodexRolloutCursor({
    transcriptPath: rolloutPath,
    byteOffset: fs.statSync(rolloutPath).size,
    sessionId: 'codex-session-1'
  });

  const collector = new CodexRolloutCollector(store, { modelPrices: {} });
  assert.equal(collector.collect(), 0);

  const rate = store.queryMetrics({ name: 'rate_limit' });
  assert.equal(rate.length, 0);
  const weekly = store.queryMetrics({ name: 'rate_limit_7d' });
  assert.equal(weekly.length, 0);

  assert.equal(collector.collect(), 0);

  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('MetricResolver does not fall back to historical rollout account data', () => {
  const dir = tmpDir();
  const store = new Store(path.join(dir, 'dashboard.db'));
  const staleTimestamp = new Date(Date.now() - 2000).toISOString();
  store.insertMetric({
    timestamp: staleTimestamp,
    runtime: 'codex',
    session_id: 'codex-session-1',
    metric_name: 'rate_limit',
    metric_value: 37.5,
    dimensions: { window_minutes: 300, resets_at: 1779516000 },
    source: 'rollout',
    confidence: 'actual'
  });

  const resolver = new MetricResolver(store, {}, { runtime: 'codex', metricStalenessSeconds: 1 });
  const rate = resolver.resolve('rate_limit');

  assert.equal(rate.value, null);
  assert.equal(rate.selected_source, null);
  assert.equal(rate.dimensions.rate_limit_resets_at, null);

  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('MetricResolver does not fall back to Claude statusline metrics while running Codex', () => {
  const dir = tmpDir();
  const store = new Store(path.join(dir, 'dashboard.db'));
  const now = new Date().toISOString();
  const staleCodexTimestamp = new Date(Date.now() - 2000).toISOString();
  store.insertMetric({
    timestamp: now,
    runtime: 'claude',
    session_id: 'claude-session',
    metric_name: 'statusline_summary',
    metric_value: 0,
    dimensions: {
      context_pct: 6,
      rate_limit: 99,
      session_cost: 1.23
    },
    source: 'statusline',
    confidence: 'actual'
  });
  store.insertMetric({
    timestamp: staleCodexTimestamp,
    runtime: 'codex',
    session_id: 'codex-session',
    metric_name: 'rate_limit',
    metric_value: 37.5,
    dimensions: { window_minutes: 300 },
    source: 'rollout',
    confidence: 'actual'
  });

  const resolver = new MetricResolver(store, {}, {
    runtime: 'codex',
    metricStalenessSeconds: 1
  });
  const rate = resolver.resolve('rate_limit');
  const context = resolver.resolve('context_pct');

  assert.equal(rate.value, null);
  assert.equal(rate.selected_source, null);
  assert.equal(context.value, null);
  assert.equal(context.selected_source, null);

  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('MetricResolver exposes Codex rollout TTFT and turn duration', () => {
  const dir = tmpDir();
  const store = new Store(path.join(dir, 'dashboard.db'));
  const timestamp = new Date().toISOString();
  store.insertMetric({
    timestamp,
    runtime: 'codex',
    session_id: 'codex-session-1',
    metric_name: 'ttft',
    metric_value: 987,
    dimensions: null,
    source: 'rollout',
    confidence: 'actual'
  });
  store.insertMetric({
    timestamp,
    runtime: 'codex',
    session_id: 'codex-session-1',
    metric_name: 'turn_duration',
    metric_value: 45123,
    dimensions: null,
    source: 'rollout',
    confidence: 'actual'
  });

  const resolver = new MetricResolver(store, {}, { runtime: 'codex', metricStalenessSeconds: 120 });
  const ttft = resolver.resolve('ttft');
  const duration = resolver.resolve('turn_duration');

  assert.equal(ttft.value, 987);
  assert.equal(ttft.selected_source, 'rollout');
  assert.equal(ttft.confidence, 'actual');
  assert.equal(duration.value, 45123);
  assert.equal(duration.selected_source, 'rollout');
  assert.equal(duration.confidence, 'actual');

  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CodexRolloutCollector skips cost when model price is missing', () => {
  const dir = tmpDir();
  const rolloutPath = path.join(dir, 'rollout-codex-session-1.jsonl');
  fs.copyFileSync(path.resolve(import.meta.dirname, 'fixtures/codex/rollout.jsonl'), rolloutPath);

  const store = new Store(path.join(dir, 'dashboard.db'));
  store.upsertCodexRolloutPath({
    runtime: 'codex',
    sessionId: 'codex-session-1',
    transcriptPath: rolloutPath,
    lastEventAt: '2026-05-23T01:00:00.000Z'
  });

  const collector = new CodexRolloutCollector(store, { modelPrices: {} });
  collector.collect();

  const [usage] = usageEvents(store);
  assert.equal(usage.metric_value, 12000);
  assert.equal(usage.dimensions.cost, undefined);
  const health = store.getSourceHealth().find(h => h.name === 'codex_cost');
  assert.equal(health.status, 'unavailable');
  assert.equal(health.extra.reason, 'missing_model_price');

  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CodexRolloutCollector computes cost from default Codex runtime prices', () => {
  const dir = tmpDir();
  const rolloutPath = path.join(dir, 'rollout-codex-session-1.jsonl');
  const fixtureText = fs.readFileSync(path.resolve(import.meta.dirname, 'fixtures/codex/rollout.jsonl'), 'utf8')
    .replaceAll('gpt-5.3-codex', 'gpt-5.5');
  fs.writeFileSync(rolloutPath, fixtureText);

  const store = new Store(path.join(dir, 'dashboard.db'));
  store.upsertCodexRolloutPath({
    runtime: 'codex',
    sessionId: 'codex-session-1',
    transcriptPath: rolloutPath,
    lastEventAt: '2026-05-23T01:00:00.000Z'
  });

  const collector = new CodexRolloutCollector(store, {
    runtimeModelPrices: { codex: DEFAULT_CODEX_MODEL_PRICES }
  });
  collector.collect();

  const [usage] = usageEvents(store);
  assert.equal(usage.dimensions.model, 'gpt-5.5');
  assert.ok(Math.abs(usage.dimensions.cost - 0.0705) < 0.000001);

  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CodexRolloutCollector ingests assistant output text into timeline', () => {
  const dir = tmpDir();
  const rolloutPath = path.join(dir, 'rollout-codex-session-1.jsonl');
  const assistantLine = JSON.stringify({
    type: 'response_item',
    timestamp: '2026-05-23T01:00:04.000Z',
    payload: {
      type: 'message',
      role: 'assistant',
      phase: 'commentary',
      content: [{ type: 'output_text', text: 'I checked the code and found the missing path.' }]
    }
  });
  fs.writeFileSync(rolloutPath, `${assistantLine}\n`);

  const store = new Store(path.join(dir, 'dashboard.db'));
  store.upsertCodexRolloutPath({
    runtime: 'codex',
    sessionId: 'codex-session-1',
    transcriptPath: rolloutPath,
    lastEventAt: '2026-05-23T01:00:00.000Z'
  });

  let stateEvent = null;
  const collector = new CodexRolloutCollector(store, { modelPrices: {} });
  collector._onEvent = (event) => { stateEvent = event; };

  assert.equal(collector.collect(), 1);

  const events = store.queryEvents({ types: ['assistant_message'] });
  assert.equal(events.length, 1);
  assert.equal(events[0].runtime, 'codex');
  assert.equal(events[0].event_type, 'assistant_message');
  assert.equal(events[0].category, 'assistant');
  assert.equal(events[0].summary, 'I checked the code and found the missing path.');
  assert.equal(events[0].metadata.phase, 'commentary');
  assert.equal(stateEvent.summary, events[0].summary);

  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CodexRolloutCollector redacts and caps assistant output summaries', () => {
  const dir = tmpDir();
  const rolloutPath = path.join(dir, 'rollout-codex-session-1.jsonl');
  const longText = `Contact user@example.com with sk-abcdefghijklmnopqrstuvwxyz123456 ${'x'.repeat(700)}`;
  const assistantLine = JSON.stringify({
    type: 'response_item',
    timestamp: '2026-05-23T01:00:04.000Z',
    payload: {
      type: 'message',
      role: 'assistant',
      phase: 'final_answer',
      content: [{ type: 'output_text', text: longText }]
    }
  });
  fs.writeFileSync(rolloutPath, `${assistantLine}\n`);

  const store = new Store(path.join(dir, 'dashboard.db'));
  store.upsertCodexRolloutPath({
    runtime: 'codex',
    sessionId: 'codex-session-1',
    transcriptPath: rolloutPath,
    lastEventAt: '2026-05-23T01:00:00.000Z'
  });

  const collector = new CodexRolloutCollector(store, { modelPrices: {} });
  assert.equal(collector.collect(), 1);

  const events = store.queryEvents({ types: ['assistant_message'] });
  assert.equal(events.length, 1);
  assert.ok(events[0].summary.length <= 500);
  assert.ok(!events[0].summary.includes('user@example.com'));
  assert.ok(!events[0].summary.includes('sk-abcdefghijklmnopqrstuvwxyz123456'));
  assert.ok(events[0].summary.includes('[EMAIL]'));
  assert.ok(events[0].summary.includes('[REDACTED]'));

  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CodexRolloutCollector skips user message text in timeline', () => {
  const dir = tmpDir();
  const rolloutPath = path.join(dir, 'rollout-codex-session-1.jsonl');
  const userLine = JSON.stringify({
    type: 'response_item',
    timestamp: '2026-05-23T01:00:04.000Z',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'Please check the dashboard timeline.' }]
    }
  });
  fs.writeFileSync(rolloutPath, `${userLine}\n`);

  const store = new Store(path.join(dir, 'dashboard.db'));
  store.upsertCodexRolloutPath({
    runtime: 'codex',
    sessionId: 'codex-session-1',
    transcriptPath: rolloutPath,
    lastEventAt: '2026-05-23T01:00:00.000Z'
  });

  const collector = new CodexRolloutCollector(store, { modelPrices: {} });

  assert.equal(collector.collect(), 0);

  const events = store.queryEvents({ types: ['user_message'] });
  assert.equal(events.length, 0);

  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CodexRolloutCollector uses human-friendly summaries for shell and patch calls', () => {
  const dir = tmpDir();
  const rolloutPath = path.join(dir, 'rollout-codex-session-1.jsonl');
  const shellLine = JSON.stringify({
    type: 'response_item',
    timestamp: '2026-05-23T01:00:04.000Z',
    payload: {
      type: 'function_call',
      name: 'functions.exec_command',
      call_id: 'call-shell',
      arguments: JSON.stringify({ cmd: 'npm test', workdir: '/tmp/project' })
    }
  });
  const shellOutputLine = JSON.stringify({
    type: 'response_item',
    timestamp: '2026-05-23T01:00:05.000Z',
    payload: { type: 'function_call_output', call_id: 'call-shell', output: 'ok' }
  });
  const patchLine = JSON.stringify({
    type: 'response_item',
    timestamp: '2026-05-23T01:00:06.000Z',
    payload: {
      type: 'custom_tool_call',
      name: 'apply_patch',
      call_id: 'call-patch',
      input: '*** Begin Patch\n*** Update File: /Users/howard/zylos/workspace/zylos-dashboard/src/lib/store.js\n@@\n*** Add File: test/new-fixture.js\n+ok\n*** End Patch\n'
    }
  });
  const shellWaitLine = JSON.stringify({
    type: 'response_item',
    timestamp: '2026-05-23T01:00:06.500Z',
    payload: {
      type: 'function_call',
      name: 'functions.write_stdin',
      call_id: 'call-shell-wait',
      arguments: JSON.stringify({ session_id: 95158, chars: '', yield_time_ms: 1000 })
    }
  });
  const fallbackLine = JSON.stringify({
    type: 'response_item',
    timestamp: '2026-05-23T01:00:07.000Z',
    payload: {
      type: 'function_call',
      name: 'functions.exec_command',
      call_id: 'call-fallback',
      arguments: JSON.stringify({ cmd: 'python scripts/do_custom_thing.py --token sk-abcdefghijklmnopqrstuvwxyz123456 --file /Users/howard/zylos/workspace/zylos-dashboard/src/index.js' })
    }
  });
  const browserLine = JSON.stringify({
    type: 'response_item',
    timestamp: '2026-05-23T01:00:08.000Z',
    payload: {
      type: 'function_call',
      name: 'functions.exec_command',
      call_id: 'call-browser',
      arguments: JSON.stringify({ cmd: 'node scripts/browser-check.js --runner playwright --screenshot /tmp/dashboard.png' })
    }
  });
  const syntaxLine = JSON.stringify({
    type: 'response_item',
    timestamp: '2026-05-23T01:00:09.000Z',
    payload: {
      type: 'function_call',
      name: 'functions.exec_command',
      call_id: 'call-syntax',
      arguments: JSON.stringify({ cmd: 'node --check public/js/app.js' })
    }
  });
  const diffLine = JSON.stringify({
    type: 'response_item',
    timestamp: '2026-05-23T01:00:10.000Z',
    payload: {
      type: 'function_call',
      name: 'functions.exec_command',
      call_id: 'call-diff',
      arguments: JSON.stringify({ cmd: 'git diff --check' })
    }
  });
  const dbLine = JSON.stringify({
    type: 'response_item',
    timestamp: '2026-05-23T01:00:11.000Z',
    payload: {
      type: 'function_call',
      name: 'functions.exec_command',
      call_id: 'call-db',
      arguments: JSON.stringify({ cmd: 'sqlite3 /Users/howard/zylos/.claude/skills/dashboard/dashboard.db "select count(*) from events;"' })
    }
  });
  fs.writeFileSync(rolloutPath, `${shellLine}\n${shellOutputLine}\n${patchLine}\n${shellWaitLine}\n${fallbackLine}\n${browserLine}\n${syntaxLine}\n${diffLine}\n${dbLine}\n`);

  const store = new Store(path.join(dir, 'dashboard.db'));
  store.upsertCodexRolloutPath({
    runtime: 'codex',
    sessionId: 'codex-session-1',
    transcriptPath: rolloutPath,
    lastEventAt: '2026-05-23T01:00:00.000Z'
  });

  const collector = new CodexRolloutCollector(store, { modelPrices: {} });
  assert.equal(collector.collect(), 9);

  const events = store.queryEvents({ limit: 10, order: 'asc' });
  assert.deepEqual(events.map(e => e.summary), [
    'Run verification: npm test',
    'Run verification: npm test',
    'Edit files: src/lib/store.js, test/new-fixture.js',
    'Wait for command output: 95158',
    'Run shell command: python scripts/do_custom_thing.py --token [REDACTED] --file zylos-dashboard/src/index.js',
    'Run verification: browser screenshot check',
    'Run verification: node --check public/js/app.js',
    'Run verification: git diff --check',
    'Inspect database: sqlite3 skills/dashboard/dashboard.db "select count(*) from events;"'
  ]);
  assert.deepEqual(events.map(e => e.event_type), ['tool_call', 'tool_result', 'tool_call', 'tool_call', 'tool_call', 'tool_call', 'tool_call', 'tool_call', 'tool_call']);
  const patchEvent = events.find(e => e.metadata.call_id === 'call-patch');
  assert.equal(patchEvent.metadata.tool_name, 'apply_patch');
  assert.ok(patchEvent.summary.includes('src/lib/store.js'));
  assert.ok(patchEvent.summary.includes('test/new-fixture.js'));
  assert.equal(patchEvent.metadata.input, undefined);
  assert.equal(patchEvent.metadata.arguments, undefined);
  assert.equal(patchEvent.metadata.tool_input, undefined);

  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CodexRolloutCollector reconstructs subagent lifecycle from rollout tools', () => {
  const dir = tmpDir();
  const rolloutPath = path.join(dir, 'rollout-codex-session-1.jsonl');
  const spawnCall = JSON.stringify({
    type: 'response_item',
    timestamp: '2026-05-23T01:00:04.000Z',
    payload: {
      type: 'function_call',
      name: 'spawn_agent',
      call_id: 'call-spawn',
      arguments: JSON.stringify({
        agent_type: 'worker',
        message: `Investigate the bug for user@example.com using token sk-abcdefghijklmnopqrstuvwxyz123456 ${'details '.repeat(40)}`
      })
    }
  });
  const spawnOutput = JSON.stringify({
    type: 'response_item',
    timestamp: '2026-05-23T01:00:05.000Z',
    payload: {
      type: 'function_call_output',
      call_id: 'call-spawn',
      output: JSON.stringify({ agent_id: 'agent-1', nickname: 'Ada' })
    }
  });
  const sendInput = JSON.stringify({
    type: 'response_item',
    timestamp: '2026-05-23T01:00:06.000Z',
    payload: {
      type: 'function_call',
      name: 'send_input',
      call_id: 'call-send',
      arguments: JSON.stringify({ target: 'agent-1', message: 'Please check logs.' })
    }
  });
  const waitCall = JSON.stringify({
    type: 'response_item',
    timestamp: '2026-05-23T01:00:06.500Z',
    payload: {
      type: 'function_call',
      name: 'wait_agent',
      call_id: 'call-wait',
      arguments: JSON.stringify({ targets: ['agent-1'], timeout_ms: 1000 })
    }
  });
  const waitOutput = JSON.stringify({
    type: 'response_item',
    timestamp: '2026-05-23T01:00:07.000Z',
    payload: {
      type: 'function_call_output',
      call_id: 'call-wait',
      output: JSON.stringify({ status: { 'agent-1': { completed: 'Done' } }, timed_out: false })
    }
  });
  fs.writeFileSync(rolloutPath, `${spawnCall}\n${spawnOutput}\n${sendInput}\n${waitCall}\n${waitOutput}\n`);

  const store = new Store(path.join(dir, 'dashboard.db'));
  store.upsertCodexRolloutPath({
    runtime: 'codex',
    sessionId: 'codex-session-1',
    transcriptPath: rolloutPath,
    lastEventAt: '2026-05-23T01:00:00.000Z'
  });

  const collector = new CodexRolloutCollector(store, { modelPrices: {} });
  const liveEvents = [];
  collector._onEvent = (event) => liveEvents.push(event);
  assert.equal(collector.collect(), 9);

  const subagentEvents = store.queryEvents({ types: ['subagent_start', 'subagent_stop'] });
  assert.deepEqual(subagentEvents.map(e => e.event_type), ['subagent_start', 'subagent_stop']);
  assert.equal(subagentEvents[0].metadata.agent_id, 'agent-1');
  assert.equal(subagentEvents[0].metadata.nickname, 'Ada');
  assert.equal(subagentEvents[0].metadata.agent_type, 'worker');
  assert.ok(subagentEvents[0].metadata.description.length <= 200);
  assert.ok(!subagentEvents[0].metadata.description.includes('user@example.com'));
  assert.ok(!subagentEvents[0].metadata.description.includes('sk-abcdefghijklmnopqrstuvwxyz123456'));
  assert.equal(subagentEvents[1].metadata.source_tool, 'wait_agent');
  assert.equal(subagentEvents[1].metadata.completion_summary, 'Done');
  assert.equal(subagentEvents[1].metadata.wait_latency_ms, 500);
  assert.equal(subagentEvents[1].duration_ms, 2000);

  const sendEvent = store.queryEvents({ limit: 10 }).find(e => e.metadata?.call_id === 'call-send');
  assert.equal(sendEvent.metadata.agent_id, 'agent-1');
  assert.equal(sendEvent.summary, 'Send input to subagent: agent-1');

  const updates = store.queryEvents({ types: ['subagent_update'] });
  assert.deepEqual(updates.map(e => e.metadata.source_tool), ['send_input', 'wait_agent']);
  assert.equal(updates[0].summary, 'Subagent input sent');
  assert.equal(updates[0].metadata.status, 'running');
  assert.equal(updates[0].metadata.message, undefined);
  assert.equal(updates[0].metadata.input, undefined);
  assert.equal(updates[1].summary, 'Waiting for subagent');
  assert.equal(updates[1].metadata.status, 'waiting');
  assert.equal(updates[1].metadata.wait_timeout_ms, 1000);
  assert.equal(updates[1].metadata.wait_started_at, '2026-05-23T01:00:06.500Z');
  assert.deepEqual(
    liveEvents.filter(e => e.event_type.startsWith('subagent_')).map(e => e.event_type),
    ['subagent_start', 'subagent_update', 'subagent_update', 'subagent_stop']
  );

  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CodexRolloutCollector keeps timed-out wait_agent active', () => {
  const dir = tmpDir();
  const rolloutPath = path.join(dir, 'rollout-codex-session-1.jsonl');
  const spawnCall = JSON.stringify({
    type: 'response_item',
    timestamp: '2026-05-23T01:00:04.000Z',
    payload: {
      type: 'function_call',
      name: 'spawn_agent',
      call_id: 'call-spawn',
      arguments: JSON.stringify({ agent_type: 'worker', message: 'Inspect timeout behavior' })
    }
  });
  const spawnOutput = JSON.stringify({
    type: 'response_item',
    timestamp: '2026-05-23T01:00:05.000Z',
    payload: {
      type: 'function_call_output',
      call_id: 'call-spawn',
      output: JSON.stringify({ agent_id: 'agent-timeout', nickname: 'Lin' })
    }
  });
  const waitCall = JSON.stringify({
    type: 'response_item',
    timestamp: '2026-05-23T01:00:05.500Z',
    payload: {
      type: 'function_call',
      name: 'wait_agent',
      call_id: 'call-wait',
      arguments: JSON.stringify({ targets: ['agent-timeout'], timeout_ms: 1000 })
    }
  });
  const waitOutput = JSON.stringify({
    type: 'response_item',
    timestamp: '2026-05-23T01:00:06.000Z',
    payload: {
      type: 'function_call_output',
      call_id: 'call-wait',
      output: JSON.stringify({ status: { 'agent-timeout': { running: true } }, timed_out: true })
    }
  });
  fs.writeFileSync(rolloutPath, `${spawnCall}\n${spawnOutput}\n${waitCall}\n${waitOutput}\n`);

  const store = new Store(path.join(dir, 'dashboard.db'));
  store.upsertCodexRolloutPath({
    runtime: 'codex',
    sessionId: 'codex-session-1',
    transcriptPath: rolloutPath,
    lastEventAt: '2026-05-23T01:00:00.000Z'
  });

  const collector = new CodexRolloutCollector(store, { modelPrices: {} });
  assert.equal(collector.collect(), 7);

  const stops = store.queryEvents({ types: ['subagent_stop'] });
  assert.equal(stops.length, 0);
  const updates = store.queryEvents({ types: ['subagent_update'] });
  assert.equal(updates.length, 2);
  assert.deepEqual(updates.map(e => e.summary), ['Waiting for subagent', 'Subagent wait timed out']);
  assert.equal(updates[1].metadata.agent_id, 'agent-timeout');
  assert.equal(updates[1].metadata.status, 'waiting');
  assert.equal(updates[1].metadata.wait_timed_out, true);
  assert.equal(updates[1].metadata.failure_reason, 'wait_timeout');
  assert.equal(updates[1].metadata.wait_timeout_ms, 1000);
  assert.equal(updates[1].metadata.wait_latency_ms, 500);

  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CodexRolloutCollector handles wait_agent top-level completed map', () => {
  const dir = tmpDir();
  const rolloutPath = path.join(dir, 'rollout-codex-session-1.jsonl');
  const spawnCall = JSON.stringify({
    type: 'response_item',
    timestamp: '2026-05-23T01:00:04.000Z',
    payload: {
      type: 'function_call',
      name: 'spawn_agent',
      call_id: 'call-spawn',
      arguments: JSON.stringify({ agent_type: 'worker', message: 'Inspect completed map handling' })
    }
  });
  const spawnOutput = JSON.stringify({
    type: 'response_item',
    timestamp: '2026-05-23T01:00:05.000Z',
    payload: {
      type: 'function_call_output',
      call_id: 'call-spawn',
      output: JSON.stringify({ agentId: 'agent-map', nickname: 'Mira' })
    }
  });
  const waitCall = JSON.stringify({
    type: 'response_item',
    timestamp: '2026-05-23T01:00:05.500Z',
    payload: {
      type: 'function_call',
      name: 'wait_agent',
      call_id: 'call-wait',
      arguments: JSON.stringify({ agentIds: ['agent-map'], timeoutMs: 1000 })
    }
  });
  const waitOutput = JSON.stringify({
    type: 'response_item',
    timestamp: '2026-05-23T01:00:06.250Z',
    payload: {
      type: 'function_call_output',
      call_id: 'call-wait',
      output: JSON.stringify({ completed: { 'agent-map': { summary: 'Mapped completion' } }, timedOut: false })
    }
  });
  fs.writeFileSync(rolloutPath, `${spawnCall}\n${spawnOutput}\n${waitCall}\n${waitOutput}\n`);

  const store = new Store(path.join(dir, 'dashboard.db'));
  store.upsertCodexRolloutPath({
    runtime: 'codex',
    sessionId: 'codex-session-1',
    transcriptPath: rolloutPath,
    lastEventAt: '2026-05-23T01:00:00.000Z'
  });

  const collector = new CodexRolloutCollector(store, { modelPrices: {} });
  assert.equal(collector.collect(), 7);

  const stops = store.queryEvents({ types: ['subagent_stop'] });
  assert.equal(stops.length, 1);
  assert.equal(stops[0].metadata.agent_id, 'agent-map');
  assert.equal(stops[0].metadata.completion_summary, 'Mapped completion');
  assert.equal(stops[0].metadata.wait_latency_ms, 750);
  assert.equal(stops[0].duration_ms, 1250);

  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CodexRolloutCollector handles wait_agent array status timeout and agent_id aliases', () => {
  const dir = tmpDir();
  const rolloutPath = path.join(dir, 'rollout-codex-session-1.jsonl');
  const waitCall = JSON.stringify({
    type: 'response_item',
    timestamp: '2026-05-23T01:00:05.500Z',
    payload: {
      type: 'function_call',
      name: 'wait_agent',
      call_id: 'call-wait',
      arguments: JSON.stringify({ agent_id: 'agent-array', timeout_ms: 1000 })
    }
  });
  const waitOutput = JSON.stringify({
    type: 'response_item',
    timestamp: '2026-05-23T01:00:06.000Z',
    payload: {
      type: 'function_call_output',
      call_id: 'call-wait',
      output: JSON.stringify({ status: [{ agent_id: 'agent-array', state: 'timed_out' }] })
    }
  });
  fs.writeFileSync(rolloutPath, `${waitCall}\n${waitOutput}\n`);

  const store = new Store(path.join(dir, 'dashboard.db'));
  store.upsertCodexRolloutPath({
    runtime: 'codex',
    sessionId: 'codex-session-1',
    transcriptPath: rolloutPath,
    lastEventAt: '2026-05-23T01:00:00.000Z'
  });

  const collector = new CodexRolloutCollector(store, { modelPrices: {} });
  assert.equal(collector.collect(), 4);

  const updates = store.queryEvents({ types: ['subagent_update'] });
  assert.equal(updates.length, 2);
  assert.equal(updates[0].metadata.agent_id, 'agent-array');
  assert.equal(updates[0].summary, 'Waiting for subagent');
  assert.equal(updates[1].summary, 'Subagent wait timed out');
  assert.equal(updates[1].metadata.wait_timed_out, true);
  assert.equal(updates[1].metadata.failure_reason, 'wait_timeout');
  assert.equal(updates[1].metadata.wait_latency_ms, 500);

  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CodexRolloutCollector computes cost from Codex priority prices when fast tier is recorded', () => {
  const dir = tmpDir();
  const rolloutPath = path.join(dir, 'rollout-codex-session-1.jsonl');
  const fixtureText = fs.readFileSync(path.resolve(import.meta.dirname, 'fixtures/codex/rollout.jsonl'), 'utf8')
    .replace('"model":"gpt-5.3-codex"', '"model":"gpt-5.3-codex","service_tier":"priority"');
  fs.writeFileSync(rolloutPath, fixtureText);

  const store = new Store(path.join(dir, 'dashboard.db'));
  store.upsertCodexRolloutPath({
    runtime: 'codex',
    sessionId: 'codex-session-1',
    transcriptPath: rolloutPath,
    lastEventAt: '2026-05-23T01:00:00.000Z'
  });

  const collector = new CodexRolloutCollector(store, {
    runtimeModelPrices: { codex: DEFAULT_CODEX_MODEL_PRICES },
    runtimeServiceTierModelPrices: { codex: { priority: DEFAULT_CODEX_PRIORITY_MODEL_PRICES } }
  });
  collector.collect();

  const [usage] = usageEvents(store);
  assert.equal(usage.dimensions.model, 'gpt-5.3-codex');
  assert.equal(usage.dimensions.service_tier, 'priority');
  assert.ok(Math.abs(usage.dimensions.cost - 0.05495) < 0.000001);

  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
