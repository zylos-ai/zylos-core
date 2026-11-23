import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../src/lib/store.js';
import { ConversationCollector } from '../src/lib/runtime/claude/collector.js';
import { loadCoreModule as loadTranscriptCore } from '../src/lib/core-modules.js';

const { getRuntime: getTranscriptRuntime } = await loadTranscriptCore('runtime/index.js');
const { transcript: claudeTranscript } = (await getTranscriptRuntime('claude')).usage;

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'conv-collector-test-'));
}

function makeJsonlLine(uuid, opts = {}) {
  const msg = {
    type: 'assistant',
    uuid,
    timestamp: opts.timestamp || '2026-05-17T10:00:00.000Z',
    sessionId: opts.sessionId || 'test-session-123',
    message: {
      model: opts.model || 'claude-opus-4-6',
      content: opts.content || [{ type: 'text', text: 'Hello world' }],
      usage: opts.usage ?? {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 5000,
        cache_creation_input_tokens: 2000
      }
    }
  };
  if (opts.requestId) msg.requestId = opts.requestId;
  if (opts.messageId) msg.message.id = opts.messageId;
  return JSON.stringify(msg);
}

// One API response as the transcript actually stores it: one line per content
// block, every line repeating the whole response's usage, differing only in
// uuid / parentUuid / timestamp / the block itself.
function makeResponseLines(requestId, blocks, opts = {}) {
  const usage = opts.usage ?? {
    input_tokens: 2,
    output_tokens: 537,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 68486
  };
  return blocks.map((block, i) => makeJsonlLine(`${requestId}-line-${i}`, {
    ...opts,
    requestId,
    messageId: opts.messageId || `msg_${requestId}`,
    content: [block],
    usage
  }));
}

function makeMockStore() {
  const metrics = [];
  const events = [];
  const health = {};
  let nextId = 1;
  const findByRequestId = (requestId) => metrics.find(m =>
    m.source === 'jsonl_usage' &&
    m.metric_name === 'usage_event' &&
    m.dimensions?.request_id === requestId
  );
  return {
    metrics,
    events,
    health,
    insertEvent(event) {
      const exists = events.find(e => e.ingest_id === event.ingest_id);
      if (exists) return { inserted: false };
      events.push(event);
      return { inserted: true, event_seq: events.length };
    },
    insertMetric(point) {
      metrics.push({ id: nextId++, ...point });
    },
    updateMetric(id, { metric_value, dimensions, timestamp, session_id } = {}) {
      const row = metrics.find(m => m.id === id);
      if (!row) return { updated: false };
      if (metric_value != null) row.metric_value = metric_value;
      if (dimensions) row.dimensions = dimensions;
      if (timestamp != null) {
        row.timestamp = timestamp;
        row.session_id = session_id || null;
      }
      return { updated: true };
    },
    upsertSourceHealth(name, signalType, status, extra) {
      health[`${name}:${signalType}`] = { status, extra };
    },
    db: {
      transaction(operation) { return { immediate: operation }; },
      prepare(sql) {
        return {
          get(param) {
            if (sql.includes('byte_offset')) return null;
            if (sql.includes('$.request_id')) {
              const row = findByRequestId(param);
              if (!row) return undefined;
              return {
                id: row.id,
                timestamp: row.timestamp,
                session_id: row.session_id,
                metric_value: row.metric_value,
                dimensions: JSON.stringify(row.dimensions)
              };
            }
            return { seq: 0 };
          }
        };
      }
    }
  };
}

function usageMetrics(store) {
  return store.metrics.filter(m => m.metric_name === 'usage_event');
}

function makeCollector(store, tmpDir, sessionId = 'test-session-123', getSessionId = null, configOverrides = {}) {
  const config = {
    zylosDir: tmpDir,
    homeDir: tmpDir,
    modelPrices: {
      'claude-opus-4': { input: 5, output: 25, cacheRead: 0.50, cacheCreation: 10 },
      'claude-sonnet-4': { input: 3, output: 15, cacheRead: 0.30, cacheCreation: 6 },
      // Custom rates isolate the TTL arithmetic from the shipped price table:
      // cacheCreation is the 1-hour rate; the 5-minute rate is 3 * 1.25.
      'claude-sonnet-5': { input: 3, output: 15, cacheRead: 0.30, cacheCreation: 6 }
    },
    ...configOverrides
  };
  const zylosResolved = fs.realpathSync(tmpDir);
  const projectDir = claudeTranscript.projectDir({ home: tmpDir, zylosDir: zylosResolved });
  fs.mkdirSync(projectDir, { recursive: true });

  const jsonlPath = path.join(projectDir, `${sessionId}.jsonl`);
  const offsets = new Map();
  const transcripts = { collect(runtime, callback) {
    const current = getSessionId ? getSessionId() : sessionId;
    if (!current) return 0;
    const main = path.join(projectDir, `${current}.jsonl`);
    const files = [{ file: main, parent: null }];
    const subdir = path.join(projectDir, current, 'subagents');
    if (fs.existsSync(subdir)) for (const name of fs.readdirSync(subdir)) {
      if (name.endsWith('.jsonl')) files.push({ file: path.join(subdir, name), parent: main });
    }
    let written = 0;
    for (const { file, parent } of files) {
      const result = callback({ transcript_path: file, session_id: current,
        session_group: null, run_id: null, parent_path: parent, byte_offset: offsets.get(file) ?? 0 }, true);
      offsets.set(file, result.byteOffset); written += result.written;
    }
    return written;
  } };
  const collector = new ConversationCollector(store, config, { transcripts });
  return { collector, config, jsonlPath, projectDir };
}

test('offset persistence prevents duplication on restart', async t => {
  const tmpDir = makeTmpDir();
  let store = new Store(path.join(tmpDir, 'dashboard.db'));
  t.after(() => { store.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });
  const { config, jsonlPath } = makeCollector(store, tmpDir);
  fs.mkdirSync(path.join(tmpDir, 'activity-monitor'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'activity-monitor', 'statusline.json'), JSON.stringify({ session_id: 'test-session-123' }));
  fs.writeFileSync(jsonlPath, makeJsonlLine('uuid-4') + '\n');
  await new ConversationCollector(store, config, { getSnapshot: async () => ({ listKnown: true, rows: [] }) }).collect();
  assert.equal(store.getUsageTranscript(jsonlPath).byte_offset, fs.statSync(jsonlPath).size);
  store.close(); store = new Store(path.join(tmpDir, 'dashboard.db'));
  const collector = new ConversationCollector(store, config, { getSnapshot: async () => ({ listKnown: true, rows: [] }) });
  const original = collector._collectFile.bind(collector);
  t.mock.method(collector, '_collectFile', (file, options) => {
    assert.equal(collector._offsets.get(file), fs.statSync(file).size);
    return original(file, options);
  });
  await collector.collect();
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM metric_points WHERE metric_name='usage_event'").get().n, 1);
});

test('one response split across content-block lines is billed once', () => {
  const tmpDir = makeTmpDir();
  const store = makeMockStore();
  const { collector, jsonlPath } = makeCollector(store, tmpDir);

  // Exactly the real shape: thinking + text + tool_use, one line each, all
  // three repeating the same usage. Before the fix this billed 3x.
  const lines = makeResponseLines('req_A', [
    { type: 'thinking', thinking: 'pondering' },
    { type: 'text', text: 'Here is the answer' },
    { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/x/workspace/proj/a.js' } }
  ]);
  fs.writeFileSync(jsonlPath, lines.join('\n') + '\n');
  collector.collect();

  const tokenMetrics = usageMetrics(store);
  assert.equal(tokenMetrics.length, 1, 'three lines of one response must yield one usage row');
  assert.equal(tokenMetrics[0].dimensions.output, 537);
  assert.equal(tokenMetrics[0].metric_value, 2 + 68486);
  assert.equal(tokenMetrics[0].dimensions.request_id, 'req_A');

  fs.rmSync(tmpDir, { recursive: true });
});

// --- Cache-write TTL pricing -------------------------------------------------
// A cache write costs 1.25x input at a 5-minute TTL and 2x at 1 hour. The
// collector used to multiply the flat cache_creation total by the single
// `cacheCreation` price (the 1-hour rate), billing every 5-minute write at
// 2 / 1.25 = 1.6x contract. These cases pin each TTL to its own rate and pin
// the split into `dimensions`, without which the cost cannot be re-derived.

// One request whose cache write is entirely one TTL class. `usage.cache_creation`
// is the nested breakdown the transcript actually carries; the flat total is
// kept alongside it, exactly as Claude Code writes both.

// Token counts from real Claude Code JSONL responses; identifiers and content
// are replaced. Expected dollar amounts use the published per-model rates.
