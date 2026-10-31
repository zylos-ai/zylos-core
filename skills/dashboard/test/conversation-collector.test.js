import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DEFAULT_CLAUDE_MODEL_PRICES } from '../src/lib/config.js';
import { Store } from '../src/lib/store.js';
import { ConversationCollector } from '../src/lib/collectors/conversation-collector.js';
import { claudeProjectSlug } from '../src/lib/claude-project-path.js';

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
  const stateEngine = { getCurrentSessionId: getSessionId || (() => sessionId) };
  const collector = new ConversationCollector(store, config, { stateEngine });

  const zylosResolved = fs.realpathSync(tmpDir);
  const projectSlug = claudeProjectSlug(zylosResolved);
  const projectDir = path.join(tmpDir, '.claude', 'projects', projectSlug);
  fs.mkdirSync(projectDir, { recursive: true });

  const jsonlPath = path.join(projectDir, `${sessionId}.jsonl`);
  return { collector, config, jsonlPath, projectDir };
}

test('extracts usage metrics from assistant messages', () => {
  const tmpDir = makeTmpDir();
  const store = makeMockStore();
  const { collector, jsonlPath } = makeCollector(store, tmpDir);

  fs.writeFileSync(jsonlPath, makeJsonlLine('uuid-1') + '\n');
  collector.collect();

  const tokenMetrics = usageMetrics(store);
  assert.equal(tokenMetrics.length, 1);
  assert.equal(tokenMetrics[0].metric_value, 100 + 5000 + 2000); // totalInput
  assert.equal(tokenMetrics[0].dimensions.input, 100);
  assert.equal(tokenMetrics[0].dimensions.output, 50);
  assert.equal(tokenMetrics[0].dimensions.cache_read, 5000);
  assert.equal(tokenMetrics[0].dimensions.cache_creation, 2000);
  assert.equal(tokenMetrics[0].dimensions.model, 'claude-opus-4-6');
  assert.equal(tokenMetrics[0].dimensions.uuid, 'uuid-1');

  // (100 * 5 + 50 * 25 + 5000 * 0.50 + 2000 * 10) / 1_000_000
  const expectedCost = (500 + 1250 + 2500 + 20000) / 1_000_000;
  assert.ok(Math.abs(tokenMetrics[0].dimensions.cost - expectedCost) < 0.000001);

  assert.ok(Math.abs(tokenMetrics[0].dimensions.cache_hit_rate - 5000 / 7100) < 0.0001);

  fs.rmSync(tmpDir, { recursive: true });
});

test('extracts usage even when no text content (tool_use only)', () => {
  const tmpDir = makeTmpDir();
  const store = makeMockStore();
  const { collector, jsonlPath } = makeCollector(store, tmpDir);

  const line = makeJsonlLine('uuid-2', {
    content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: {} }],
    usage: { input_tokens: 200, output_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 500 }
  });
  fs.writeFileSync(jsonlPath, line + '\n');
  collector.collect();

  const tokenMetrics = usageMetrics(store);
  assert.equal(tokenMetrics.length, 1);
  assert.equal(tokenMetrics[0].metric_value, 200 + 1000 + 500);

  // No assistant_message event since there's no text
  assert.equal(store.events.length, 0);

  fs.rmSync(tmpDir, { recursive: true });
});

test('assistant summaries redact before truncation', () => {
  const tmpDir = makeTmpDir();
  const store = makeMockStore();
  const { collector, jsonlPath } = makeCollector(store, tmpDir);
  const text = `${'x'.repeat(430)} sk-abcdefghijklmnopqrstuvwxyz123456 user@example.com ${'tail '.repeat(80)}`;

  fs.writeFileSync(jsonlPath, makeJsonlLine('uuid-redact-summary', {
    content: [{ type: 'text', text }]
  }) + '\n');
  collector.collect();

  const assistantEvents = store.events.filter(e => e.event_type === 'assistant_message');
  assert.equal(assistantEvents.length, 1);
  assert.ok(assistantEvents[0].summary.length <= 500);
  assert.ok(!assistantEvents[0].summary.includes('sk-'));
  assert.ok(!assistantEvents[0].summary.includes('user@example.com'));
  assert.ok(assistantEvents[0].summary.includes('[REDACTED]'));
  assert.ok(assistantEvents[0].summary.includes('[EMAIL]'));

  fs.rmSync(tmpDir, { recursive: true });
});

test('does not double-count on re-read of same data', () => {
  const tmpDir = makeTmpDir();
  const store = makeMockStore();
  const { collector, jsonlPath } = makeCollector(store, tmpDir);

  fs.writeFileSync(jsonlPath, makeJsonlLine('uuid-3') + '\n');
  collector.collect();
  collector.collect(); // second call should not duplicate

  const tokenMetrics = usageMetrics(store);
  assert.equal(tokenMetrics.length, 1);

  fs.rmSync(tmpDir, { recursive: true });
});

test('offset persistence prevents duplication on restart', () => {
  const tmpDir = makeTmpDir();
  const store = makeMockStore();
  const { collector, jsonlPath } = makeCollector(store, tmpDir);

  fs.writeFileSync(jsonlPath, makeJsonlLine('uuid-4') + '\n');
  collector.collect();

  assert.equal(usageMetrics(store).length, 1);

  // Simulate restart: create new collector with same store (which has persisted offset)
  const persistedOffset = store.health['conversation_reader:byte_offset'];
  assert.ok(persistedOffset);
  assert.ok(persistedOffset.extra.offset > 0);

  // New collector that reads the persisted offset
  const store2 = makeMockStore();
  store2.db = {
    prepare(sql) {
      return {
        get(param) {
          if (sql.includes('byte_offset')) {
            return { extra: JSON.stringify(persistedOffset.extra) };
          }
          if (sql.includes('jsonl_usage')) return undefined;
          return { seq: 0 };
        }
      };
    }
  };
  const { collector: collector2 } = makeCollector(store2, tmpDir);
  collector2._restoreOffset();
  collector2.collect();

  // No new metrics since offset was restored past existing data
  assert.equal(usageMetrics(store2).length, 0);

  fs.rmSync(tmpDir, { recursive: true });
});

test('uuid dedup prevents double-counting on crash recovery replay', () => {
  const tmpDir = makeTmpDir();
  const store = makeMockStore();
  const { collector, jsonlPath } = makeCollector(store, tmpDir);

  fs.writeFileSync(jsonlPath, makeJsonlLine('uuid-replay') + '\n');
  collector.collect();

  assert.equal(usageMetrics(store).length, 1);

  // Simulate crash recovery: offset NOT persisted (simulating crash before persist)
  // Create new collector at offset 0 (as if no offset was saved)
  const store2 = makeMockStore();
  // Pre-seed store2's metrics with existing data (simulating DB survived the crash)
  store2.metrics.push(...store.metrics);
  const { collector: collector2 } = makeCollector(store2, tmpDir);
  collector2.collect();

  // uuid-replay should NOT be double-counted because dedup check finds it
  const tokenMetrics = usageMetrics(store2);
  assert.equal(tokenMetrics.length, 1); // still just 1, not 2

  fs.rmSync(tmpDir, { recursive: true });
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

test('distinct requests are still counted separately', () => {
  const tmpDir = makeTmpDir();
  const store = makeMockStore();
  const { collector, jsonlPath } = makeCollector(store, tmpDir);

  const lines = [
    ...makeResponseLines('req_A', [{ type: 'thinking', thinking: 'a' }, { type: 'text', text: 'a' }]),
    ...makeResponseLines('req_B', [{ type: 'thinking', thinking: 'b' }, { type: 'text', text: 'b' }])
  ];
  fs.writeFileSync(jsonlPath, lines.join('\n') + '\n');
  collector.collect();

  const tokenMetrics = usageMetrics(store);
  assert.equal(tokenMetrics.length, 2);
  assert.deepEqual(tokenMetrics.map(m => m.dimensions.request_id).sort(), ['req_A', 'req_B']);

  fs.rmSync(tmpDir, { recursive: true });
});

test('a later line carrying more complete usage wins (upsert, not skip)', () => {
  const tmpDir = makeTmpDir();
  const store = makeMockStore();
  const { collector, jsonlPath } = makeCollector(store, tmpDir);

  // Robustness: the observed transcripts repeat usage byte-identically, but the
  // collector must not silently drop a fuller reading if a shape ever differs.
  const first = makeJsonlLine('l1', {
    requestId: 'req_C', messageId: 'msg_C',
    content: [{ type: 'thinking', thinking: 'partial' }],
    usage: { input_tokens: 2, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 500 }
  });
  const second = makeJsonlLine('l2', {
    requestId: 'req_C', messageId: 'msg_C',
    content: [{ type: 'text', text: 'complete' }],
    usage: { input_tokens: 2, output_tokens: 900, cache_read_input_tokens: 0, cache_creation_input_tokens: 500 }
  });
  fs.writeFileSync(jsonlPath, first + '\n' + second + '\n');
  collector.collect();

  const tokenMetrics = usageMetrics(store);
  assert.equal(tokenMetrics.length, 1, 'still one row per request');
  assert.equal(tokenMetrics[0].dimensions.output, 900, 'the fuller output must win');

  fs.rmSync(tmpDir, { recursive: true });
});

test('a later line with less complete usage does not shrink the row', () => {
  const tmpDir = makeTmpDir();
  const store = makeMockStore();
  const { collector, jsonlPath } = makeCollector(store, tmpDir);

  const full = makeJsonlLine('l1', {
    requestId: 'req_D', messageId: 'msg_D',
    content: [{ type: 'text', text: 'full' }],
    usage: { input_tokens: 2, output_tokens: 900, cache_read_input_tokens: 0, cache_creation_input_tokens: 500 }
  });
  const partial = makeJsonlLine('l2', {
    requestId: 'req_D', messageId: 'msg_D',
    content: [{ type: 'tool_use', id: 't', name: 'Read', input: {} }],
    usage: { input_tokens: 2, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 500 }
  });
  fs.writeFileSync(jsonlPath, full + '\n' + partial + '\n');
  collector.collect();

  const tokenMetrics = usageMetrics(store);
  assert.equal(tokenMetrics.length, 1);
  assert.equal(tokenMetrics[0].dimensions.output, 900, 'must not regress to the smaller reading');

  fs.rmSync(tmpDir, { recursive: true });
});

test('projects from every content-block line are merged onto the single row', () => {
  const tmpDir = makeTmpDir();
  const store = makeMockStore();
  const { collector, jsonlPath } = makeCollector(store, tmpDir);

  // The thinking line knows no project; the tool_use lines do. Deduping to the
  // first line alone would lose attribution entirely.
  const lines = makeResponseLines('req_E', [
    { type: 'thinking', thinking: 'no project here' },
    { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/home/u/zylos/workspace/alpha/a.js' } },
    { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/home/u/zylos/workspace/beta/b.js' } }
  ]);
  fs.writeFileSync(jsonlPath, lines.join('\n') + '\n');
  collector.collect();

  const tokenMetrics = usageMetrics(store);
  assert.equal(tokenMetrics.length, 1);
  assert.deepEqual([...tokenMetrics[0].dimensions.projects].sort(), ['alpha', 'beta']);

  fs.rmSync(tmpDir, { recursive: true });
});

test('falls back to message.id, then uuid, when requestId is absent', () => {
  const tmpDir = makeTmpDir();
  const store = makeMockStore();
  const { collector, jsonlPath } = makeCollector(store, tmpDir);

  // No requestId (observed on <synthetic> records): message.id still groups the
  // lines of one response.
  const a = makeJsonlLine('u1', { messageId: 'msg_F', content: [{ type: 'thinking', thinking: 'x' }] });
  const b = makeJsonlLine('u2', { messageId: 'msg_F', content: [{ type: 'text', text: 'y' }] });
  // Neither requestId nor message.id: falls back to uuid, one row per line.
  const c = makeJsonlLine('u3', { content: [{ type: 'text', text: 'z' }] });
  fs.writeFileSync(jsonlPath, [a, b, c].join('\n') + '\n');
  collector.collect();

  const tokenMetrics = usageMetrics(store);
  assert.equal(tokenMetrics.length, 2, 'msg_F collapses to one row; the keyless line stands alone');
  assert.deepEqual(tokenMetrics.map(m => m.dimensions.request_id).sort(), ['msg_F', 'u3']);

  fs.rmSync(tmpDir, { recursive: true });
});

test('subagent transcripts are collected and billed to the parent session', () => {
  const tmpDir = makeTmpDir();
  const store = makeMockStore();
  const { collector, jsonlPath, projectDir } = makeCollector(store, tmpDir);

  fs.writeFileSync(jsonlPath, makeResponseLines('req_main', [
    { type: 'thinking', thinking: 'main' }, { type: 'text', text: 'main' }
  ]).join('\n') + '\n');

  // A Task/background agent writes its own transcript under <session>/subagents/.
  const subDir = path.join(projectDir, 'test-session-123', 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(path.join(subDir, 'agent-abc123.jsonl'), makeResponseLines('req_sub', [
    { type: 'thinking', thinking: 'sub' }, { type: 'text', text: 'sub work' }
  ], { sessionId: 'subagent-own-session', model: 'claude-sonnet-4-5' }).join('\n') + '\n');

  collector.collect();

  const tokenMetrics = usageMetrics(store);
  assert.equal(tokenMetrics.length, 2, 'main + subagent usage, one row each');

  const sub = tokenMetrics.find(m => m.dimensions.request_id === 'req_sub');
  assert.ok(sub, 'subagent usage must be ingested');
  assert.equal(sub.dimensions.agent_id, 'abc123', 'tagged with the agent it came from');
  assert.equal(sub.session_id, 'test-session-123', 'billed to the parent session, not its own');

  const main = tokenMetrics.find(m => m.dimensions.request_id === 'req_main');
  assert.equal(main.dimensions.agent_id, undefined, 'main rows carry no agent_id');

  // Subagent text must not enter the activity feed.
  const feed = store.events.filter(e => e.event_type === 'assistant_message');
  assert.equal(feed.length, 1, 'only the main session contributes feed events');
  assert.ok(feed[0].summary.includes('main'));

  fs.rmSync(tmpDir, { recursive: true });
});

test('subagent transcripts are not re-ingested on the next pass', () => {
  const tmpDir = makeTmpDir();
  const store = makeMockStore();
  const { collector, jsonlPath, projectDir } = makeCollector(store, tmpDir);

  fs.writeFileSync(jsonlPath, makeJsonlLine('m1', { requestId: 'req_main' }) + '\n');
  const subDir = path.join(projectDir, 'test-session-123', 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  const subFile = path.join(subDir, 'agent-xyz.jsonl');
  fs.writeFileSync(subFile, makeJsonlLine('s1', { requestId: 'req_sub1' }) + '\n');

  collector.collect();
  assert.equal(usageMetrics(store).length, 2);

  collector.collect();
  assert.equal(usageMetrics(store).length, 2, 'no duplication on re-read');

  // Appending to the subagent transcript is picked up from its own offset.
  fs.appendFileSync(subFile, makeJsonlLine('s2', { requestId: 'req_sub2' }) + '\n');
  collector.collect();
  assert.equal(usageMetrics(store).length, 3, 'new subagent usage is collected incrementally');

  fs.rmSync(tmpDir, { recursive: true });
});

test('per-file offsets survive a restart', () => {
  const tmpDir = makeTmpDir();
  const store = makeMockStore();
  const { collector, jsonlPath, projectDir } = makeCollector(store, tmpDir);

  fs.writeFileSync(jsonlPath, makeJsonlLine('m1', { requestId: 'req_main' }) + '\n');
  const subDir = path.join(projectDir, 'test-session-123', 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(path.join(subDir, 'agent-xyz.jsonl'), makeJsonlLine('s1', { requestId: 'req_sub1' }) + '\n');

  collector.collect();
  assert.equal(usageMetrics(store).length, 2);

  const persisted = store.health['conversation_reader:byte_offset'].extra;
  assert.ok(persisted.files, 'per-file offsets are persisted');
  assert.equal(Object.keys(persisted.files).length, 2);

  // Fresh collector restoring those offsets must not re-read either file.
  const store2 = makeMockStore();
  store2.db = {
    prepare(sql) {
      return {
        get(param) {
          if (sql.includes('byte_offset')) return { extra: JSON.stringify(persisted) };
          if (sql.includes('$.request_id')) return undefined;
          return { seq: 0 };
        }
      };
    }
  };
  const { collector: collector2 } = makeCollector(store2, tmpDir);
  collector2._restoreOffset();
  collector2.collect();
  assert.equal(usageMetrics(store2).length, 0, 'nothing re-read after restart');

  fs.rmSync(tmpDir, { recursive: true });
});

test('falls back to the statusline session id when the state engine has none', () => {
  const tmpDir = makeTmpDir();
  const store = makeMockStore();
  // State engine reports nothing — the situation after a mid-session restart,
  // where collection used to stall until the user's next prompt.
  const { collector, jsonlPath } = makeCollector(store, tmpDir, 'test-session-123', () => null);

  fs.mkdirSync(path.join(tmpDir, 'activity-monitor'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, 'activity-monitor', 'statusline.json'),
    JSON.stringify({ session_id: 'test-session-123' })
  );

  fs.writeFileSync(jsonlPath, makeJsonlLine('u1', { requestId: 'req_fallback' }) + '\n');
  collector.collect();

  assert.equal(usageMetrics(store).length, 1, 'collection proceeds via the statusline session id');
  assert.equal(usageMetrics(store)[0].session_id, 'test-session-123');

  fs.rmSync(tmpDir, { recursive: true });
});

test('state engine session id wins over the statusline fallback', () => {
  const tmpDir = makeTmpDir();
  const store = makeMockStore();
  const { collector, jsonlPath } = makeCollector(store, tmpDir, 'test-session-123');

  fs.mkdirSync(path.join(tmpDir, 'activity-monitor'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, 'activity-monitor', 'statusline.json'),
    JSON.stringify({ session_id: 'some-other-session' })
  );

  fs.writeFileSync(jsonlPath, makeJsonlLine('u1', { requestId: 'req_primary' }) + '\n');
  collector.collect();

  assert.equal(usageMetrics(store).length, 1);
  assert.equal(usageMetrics(store)[0].session_id, 'test-session-123');

  fs.rmSync(tmpDir, { recursive: true });
});

test('unknown model writes token metrics but skips cost', () => {
  const tmpDir = makeTmpDir();
  const store = makeMockStore();
  const { collector, jsonlPath } = makeCollector(store, tmpDir);

  const line = makeJsonlLine('uuid-5', { model: 'claude-unknown-99' });
  fs.writeFileSync(jsonlPath, line + '\n');
  collector.collect();

  const tokenMetrics = usageMetrics(store);
  assert.equal(tokenMetrics.length, 1);

  assert.equal(tokenMetrics[0].dimensions.cost, undefined);

  fs.rmSync(tmpDir, { recursive: true });
});

test('handles malformed JSON lines gracefully', () => {
  const tmpDir = makeTmpDir();
  const store = makeMockStore();
  const { collector, jsonlPath } = makeCollector(store, tmpDir);

  const content = [
    '{invalid json',
    makeJsonlLine('uuid-6'),
    '',
    '{"type": "user", "uuid": "uuid-7"}',
    makeJsonlLine('uuid-8')
  ].join('\n') + '\n';

  fs.writeFileSync(jsonlPath, content);
  collector.collect();

  const tokenMetrics = usageMetrics(store);
  assert.equal(tokenMetrics.length, 2); // uuid-6 and uuid-8 only

  fs.rmSync(tmpDir, { recursive: true });
});

test('partial trailing line is not consumed', () => {
  const tmpDir = makeTmpDir();
  const store = makeMockStore();
  const { collector, jsonlPath } = makeCollector(store, tmpDir);

  // Write a complete line + an incomplete line (no trailing newline)
  const content = makeJsonlLine('uuid-9') + '\n' + '{"type": "assistant", "incomplete...';
  fs.writeFileSync(jsonlPath, content);
  collector.collect();

  const tokenMetrics = usageMetrics(store);
  assert.equal(tokenMetrics.length, 1); // only uuid-9

  // Now complete the line
  const completeLine = makeJsonlLine('uuid-10');
  fs.writeFileSync(jsonlPath, makeJsonlLine('uuid-9') + '\n' + completeLine + '\n');
  collector.collect();

  const tokenMetrics2 = usageMetrics(store);
  assert.equal(tokenMetrics2.length, 2); // uuid-9 + uuid-10

  fs.rmSync(tmpDir, { recursive: true });
});

test('missing usage field does not crash', () => {
  const tmpDir = makeTmpDir();
  const store = makeMockStore();
  const { collector, jsonlPath } = makeCollector(store, tmpDir);

  const line = JSON.stringify({
    type: 'assistant',
    uuid: 'uuid-11',
    timestamp: '2026-05-17T10:00:00.000Z',
    sessionId: 'test-session-123',
    message: {
      model: 'claude-opus-4-6',
      content: [{ type: 'text', text: 'No usage field' }]
    }
  });

  fs.writeFileSync(jsonlPath, line + '\n');
  collector.collect();

  const assistantEvents = store.events.filter(e => e.event_type === 'assistant_message');
  assert.equal(assistantEvents.length, 1);
  assert.equal(store.metrics.length, 0);

  fs.rmSync(tmpDir, { recursive: true });
});

test('session file switch resets offset', () => {
  const tmpDir = makeTmpDir();
  const store = makeMockStore();

  const config = {
    zylosDir: tmpDir,
    homeDir: tmpDir,
    modelPrices: {
      'claude-opus-4': { input: 5, output: 25, cacheRead: 0.50, cacheCreation: 10 }
    }
  };

  let currentSession = 'session-a';
  const stateEngine = { getCurrentSessionId: () => currentSession };
  const collector = new ConversationCollector(store, config, { stateEngine });

  const zylosResolved = fs.realpathSync(tmpDir);
  const projectSlug = claudeProjectSlug(zylosResolved);
  const projectDir = path.join(tmpDir, '.claude', 'projects', projectSlug);
  fs.mkdirSync(projectDir, { recursive: true });

  // Write session A
  const pathA = path.join(projectDir, 'session-a.jsonl');
  fs.writeFileSync(pathA, makeJsonlLine('uuid-a1', { sessionId: 'session-a' }) + '\n');
  collector.collect();

  assert.equal(usageMetrics(store).length, 1);

  // Switch to session B
  currentSession = 'session-b';
  const pathB = path.join(projectDir, 'session-b.jsonl');
  fs.writeFileSync(pathB, makeJsonlLine('uuid-b1', { sessionId: 'session-b' }) + '\n');
  collector.collect();

  assert.equal(usageMetrics(store).length, 2);

  // Session A data doesn't leak into session B
  const sessionBMetrics = store.metrics.filter(m => m.session_id === 'session-b');
  assert.equal(sessionBMetrics.length, 1);

  fs.rmSync(tmpDir, { recursive: true });
});

test('cache rate formula: cache_read / (input + cache_read + cache_creation)', () => {
  const tmpDir = makeTmpDir();
  const store = makeMockStore();
  const { collector, jsonlPath } = makeCollector(store, tmpDir);

  const line = makeJsonlLine('uuid-rate', {
    usage: {
      input_tokens: 1000,
      output_tokens: 500,
      cache_read_input_tokens: 8000,
      cache_creation_input_tokens: 1000
    }
  });
  fs.writeFileSync(jsonlPath, line + '\n');
  collector.collect();

  const cacheMetric = usageMetrics(store)[0];
  // cache_read / (input + cache_read + cache_creation) = 8000 / (1000 + 8000 + 1000) = 0.8
  assert.ok(Math.abs(cacheMetric.dimensions.cache_hit_rate - 0.8) < 0.0001);

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
function makeTtlUsage(breakdown, extra = {}) {
  const flat = Object.values(breakdown).reduce((a, b) => a + (b || 0), 0);
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: flat,
    cache_creation: breakdown,
    ...extra
  };
}

function collectTtlRow(usage, { configOverrides } = {}) {
  const tmpDir = makeTmpDir();
  const store = makeMockStore();
  const { collector, jsonlPath } = makeCollector(
    store, tmpDir, 'test-session-123', null, configOverrides
  );
  fs.writeFileSync(jsonlPath, makeJsonlLine('uuid-ttl', {
    model: 'claude-sonnet-5', usage
  }) + '\n');
  collector.collect();
  const rows = usageMetrics(store);
  fs.rmSync(tmpDir, { recursive: true });
  return rows[0];
}

test('5-minute cache writes bill at 1.25x input, not the 1-hour rate', () => {
  const row = collectTtlRow(makeTtlUsage({
    ephemeral_5m_input_tokens: 1_000_000,
    ephemeral_1h_input_tokens: 0
  }));

  // 1M pure 5m tokens on Sonnet 5 (input 3): contract is 3 * 1.25 = $3.75.
  assert.ok(Math.abs(row.dimensions.cost - 3.75) < 1e-9,
    `expected $3.75, got ${row.dimensions.cost}`);
  // Negative control: the pre-fix formula (1M * cacheCreation 6) gave $6.
  assert.ok(Math.abs(row.dimensions.cost - 6) > 1e-9,
    'still billing 5-minute writes at the 1-hour rate');

  // The split must survive into dimensions or this row can never be re-costed.
  assert.equal(row.dimensions.cache_creation, 1_000_000);
  assert.equal(row.dimensions.cache_creation_5m, 1_000_000);
  assert.equal(row.dimensions.cache_creation_1h, 0);
});

test('1-hour cache writes still bill at 2x input', () => {
  const row = collectTtlRow(makeTtlUsage({
    ephemeral_5m_input_tokens: 0,
    ephemeral_1h_input_tokens: 1_000_000
  }));

  // Unchanged by the fix: 1M * 3 * 2 = $6. Guards against "correcting" the
  // rate that was already right.
  assert.ok(Math.abs(row.dimensions.cost - 6) < 1e-9,
    `expected $6.00, got ${row.dimensions.cost}`);
  assert.equal(row.dimensions.cache_creation_5m, 0);
  assert.equal(row.dimensions.cache_creation_1h, 1_000_000);
});

test('mixed-TTL cache writes bill each portion at its own rate', () => {
  const row = collectTtlRow(makeTtlUsage({
    ephemeral_5m_input_tokens: 400_000,
    ephemeral_1h_input_tokens: 600_000
  }));

  // 400k * 3 * 1.25 + 600k * 3 * 2 = 1.50 + 3.60 = $5.10.
  assert.ok(Math.abs(row.dimensions.cost - 5.10) < 1e-9,
    `expected $5.10, got ${row.dimensions.cost}`);
  // The flat total alone would have priced the same row at $6.00 — the two
  // must not coincide, or the test would pass without the split being read.
  assert.ok(Math.abs(row.dimensions.cost - 6) > 1e-9);

  assert.equal(row.dimensions.cache_creation, 1_000_000);
  assert.equal(row.dimensions.cache_creation_5m, 400_000);
  assert.equal(row.dimensions.cache_creation_1h, 600_000);
});

test('fast mode multiplies TTL-aware cache-write cost', () => {
  const row = collectTtlRow(
    makeTtlUsage({ ephemeral_5m_input_tokens: 400_000, ephemeral_1h_input_tokens: 600_000 },
      { speed: 'fast' }),
    { configOverrides: { fastModeMultiplier: 4 } }
  );

  // Same tokens as above at 4x: 5.10 * 4 = $20.40. Pins that the fast-mode
  // path still applies after the cache-write term stopped being a single
  // price lookup.
  assert.ok(Math.abs(row.dimensions.cost - 20.40) < 1e-9,
    `expected $20.40, got ${row.dimensions.cost}`);
  assert.equal(row.dimensions.speed, 'fast');
  assert.equal(row.dimensions.cache_creation_5m, 400_000);
  assert.equal(row.dimensions.cache_creation_1h, 600_000);
});

test('a cache write with no TTL breakdown keeps the 1-hour rate and is marked unknown', () => {
  // Older transcripts (and any future line that omits the nested object) carry
  // only the flat total. The TTL is genuinely unknowable there, so pricing must
  // not change and the row must distinguish "no 5m tokens" from
  // "TTL unrecorded" when inspecting the charged usage.
  const row = collectTtlRow({
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 1_000_000
  });

  assert.ok(Math.abs(row.dimensions.cost - 6) < 1e-9,
    `expected the unchanged $6.00, got ${row.dimensions.cost}`);
  assert.equal(row.dimensions.cache_creation, 1_000_000);
  assert.equal('cache_creation_5m' in row.dimensions, false);
  assert.equal('cache_creation_1h' in row.dimensions, false);
});

test('an unrecognised TTL class is billed, not dropped', () => {
  // If a new TTL is added upstream, its tokens are still in the flat total but
  // in no known bucket. They must keep costing money (at the highest known
  // write rate) rather than silently falling out of the bill.
  const row = collectTtlRow({
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 1_000_000,
    cache_creation: {
      ephemeral_5m_input_tokens: 400_000,
      ephemeral_1h_input_tokens: 0,
      ephemeral_12h_input_tokens: 600_000
    }
  });

  // 400k at 1.25x + 600k unknown at the 1-hour 2x = 1.50 + 3.60 = $5.10.
  assert.ok(Math.abs(row.dimensions.cost - 5.10) < 1e-9,
    `expected $5.10, got ${row.dimensions.cost}`);
  assert.equal(row.dimensions.cache_creation_unknown_ttl, 600_000);
});

test('the TTL split survives the per-content-block upsert', () => {
  // One response is written as several lines that each repeat the whole usage
  // object; the collector merges them into one row. The split must not be lost
  // or halved by that merge.
  const tmpDir = makeTmpDir();
  const store = makeMockStore();
  const { collector, jsonlPath } = makeCollector(store, tmpDir);

  const usage = makeTtlUsage({
    ephemeral_5m_input_tokens: 400_000,
    ephemeral_1h_input_tokens: 600_000
  });
  const lines = makeResponseLines('req-ttl-1', [
    { type: 'thinking', thinking: 'considering' },
    { type: 'text', text: 'answer' },
    { type: 'tool_use', id: 'tu1', name: 'Read', input: {} }
  ], { usage, model: 'claude-sonnet-5' });

  fs.writeFileSync(jsonlPath, lines.join('\n') + '\n');
  collector.collect();

  const rows = usageMetrics(store);
  assert.equal(rows.length, 1, 'three content-block lines are one billable request');
  assert.equal(rows[0].dimensions.cache_creation_5m, 400_000);
  assert.equal(rows[0].dimensions.cache_creation_1h, 600_000);
  assert.ok(Math.abs(rows[0].dimensions.cost - 5.10) < 1e-9,
    `expected $5.10 charged once, got ${rows[0].dimensions.cost}`);

  fs.rmSync(tmpDir, { recursive: true });
});

// Token counts from real Claude Code JSONL responses; identifiers and content
// are replaced. Expected dollar amounts use the published per-model rates.
for (const sample of [
  {
    model: 'claude-sonnet-5', expected: 0.085584,
    usage: { input_tokens: 2, output_tokens: 290, cache_read_input_tokens: 0,
      cache_creation_input_tokens: 33072,
      cache_creation: { ephemeral_5m_input_tokens: 33072, ephemeral_1h_input_tokens: 0 } }
  },
  {
    model: 'claude-fable-5-1', expected: 0.12718725,
    usage: { input_tokens: 32, output_tokens: 1129, cache_read_input_tokens: 129189,
      cache_creation_input_tokens: 1906,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1906 } }
  }
]) {
  test(`shipped prices charge real ${sample.model} usage correctly`, (t) => {
    const tmpDir = makeTmpDir();
    t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
    const store = makeMockStore();
    const { collector, jsonlPath } = makeCollector(store, tmpDir, undefined, null, {
      modelPrices: DEFAULT_CLAUDE_MODEL_PRICES
    });
    fs.writeFileSync(jsonlPath, makeJsonlLine('price-sample', sample) + '\n');
    collector.collect();
    const rows = usageMetrics(store);
    assert.equal(rows.length, 1);
    assert.ok(Math.abs(rows[0].dimensions.cost - sample.expected) < 1e-12,
      `expected $${sample.expected}, got $${rows[0].dimensions.cost}`);
  });
}

test('specific Claude model prices win regardless of insertion order and retain configured overrides', (t) => {
  const tmpDir = makeTmpDir();
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const family = DEFAULT_CLAUDE_MODEL_PRICES['claude-fable-5'];
  const specific = DEFAULT_CLAUDE_MODEL_PRICES['claude-fable-5-1'];
  const override = { ...specific, cacheRead: 0.125 };
  const { collector } = makeCollector(makeMockStore(), tmpDir, undefined, null, {
    runtimeModelPrices: { claude: {
      'claude-fable-5': family,
      'claude-fable-5-1': override
    } }
  });
  assert.equal(collector._resolveModelPrice('claude-fable-5-1'), override);
  assert.equal(collector._resolveModelPrice('claude-fable-5-1-20260901'), override);
  assert.equal(collector._resolveModelPrice('claude-fable-5'), family);
  assert.equal(collector._resolveModelPrice('unpriced-model'), null);
});

for (const scenario of [
  { name: 'cross day', oldTime: '2026-09-13T23:59:50.000Z', newTime: '2026-09-14T00:00:10.000Z', session: 'old-session' },
  { name: 'equal time', oldTime: '2026-09-14T00:00:10.000Z', newTime: '2026-09-14T00:00:10.000Z', session: 'new-session' },
  { name: 'negative offset', oldTime: '2026-09-13T16:00:10.000-08:00', newTime: '2026-09-14T00:00:20.000Z', session: 'old-session' },
  { name: 'offset time', oldTime: '2026-09-14T07:59:50.000+08:00', newTime: '2026-09-14T00:00:10.000Z', session: 'old-session' }
]) {
  for (const reverse of [false, true]) {
    test(`one subagent response across session files is billed once (${scenario.name}, ${reverse ? 'new first' : 'old first'})`, (t) => {
      const tmpDir = makeTmpDir();
      let store = new Store(path.join(tmpDir, 'usage.db'));
      t.after(() => {
        store.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
      });
      const { config } = makeCollector(store, tmpDir, undefined, null, {
        modelPrices: DEFAULT_CLAUDE_MODEL_PRICES
      });
      const usage = { input_tokens: 2, output_tokens: 1, cache_read_input_tokens: 100,
        cache_creation_input_tokens: 200,
        cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 0 } };
      // A continuing agent keeps its request/message IDs while its parent session
      // rotates. The tool block links back to the old thinking block's UUID.
      const old = JSON.parse(makeJsonlLine('old-thinking', {
        timestamp: scenario.oldTime, sessionId: 'old-session', requestId: 'continued-request', messageId: 'continued-message',
        model: 'claude-sonnet-5', usage,
        content: [{ type: 'thinking', thinking: 'redacted' }]
      }));
      const next = JSON.parse(makeJsonlLine('new-tool', {
        timestamp: scenario.newTime, sessionId: 'new-session', requestId: 'continued-request', messageId: 'continued-message',
        model: 'claude-sonnet-5', usage: { ...usage, output_tokens: 50 },
        content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: {} }]
      }));
      next.parentUuid = old.uuid;
      for (const record of [old, next]) {
        record.agentId = 'continuing-agent';
        record.isSidechain = true;
      }
      const files = [old, next].map(record => {
        const file = path.join(tmpDir, `${record.sessionId}.jsonl`);
        fs.writeFileSync(file, JSON.stringify(record) + '\n');
        return { file, sessionId: record.sessionId };
      });
      if (reverse) files.reverse();
      for (const { file, sessionId } of files) {
        // Reopen the database between observations as well as before replay.
        store.close();
        store = new Store(path.join(tmpDir, 'usage.db'));
        const collector = new ConversationCollector(store, config);
        collector._collectFile(file, { sessionId, agentId: 'continuing-agent', usageOnly: true });
      }
      // Restart removes in-memory request/UUID caches and exercises SQLite dedup.
      store.close();
      store = new Store(path.join(tmpDir, 'usage.db'));
      const restarted = new ConversationCollector(store, config);
      for (const { file, sessionId } of files) {
        restarted._collectFile(file, { sessionId, agentId: 'continuing-agent', usageOnly: true });
      }
      const rows = store.db.prepare("SELECT * FROM metric_points WHERE source = 'jsonl_usage' AND metric_name = 'usage_event'").all();
      assert.equal(rows.length, 1);
      const dims = JSON.parse(rows[0].dimensions);
      assert.equal(dims.output, 50);
      assert.equal(dims.request_id, 'continued-request');
      assert.ok(Math.abs(dims.cost - 0.001024) < 1e-12);
      const expectedTime = new Date(scenario.session === 'old-session' ? scenario.oldTime : scenario.newTime).toISOString();
      assert.equal(rows[0].timestamp, expectedTime);
      assert.equal(rows[0].session_id, scenario.session);
      for (const bucketSeconds of [3600, 86400]) {
        const series = store.aggregateCostSeries({
          since: '2026-09-13', until: '2026-09-15', bucketSeconds
        });
        assert.equal(series.length, 1);
        assert.equal(series[0].bucket_start, Math.floor(Date.parse(expectedTime) / (bucketSeconds * 1000)) * bucketSeconds);
        assert.equal(series[0].request_count, 1);
        assert.ok(Math.abs(series[0].cost_sum - 0.001024) < 1e-12);
        const start = Math.floor(Date.parse(expectedTime) / (bucketSeconds * 1000)) * bucketSeconds * 1000;
        const window = { since: new Date(start).toISOString(), until: new Date(start + bucketSeconds * 1000 - 1).toISOString(), bucketSeconds };
        assert.deepEqual(store.aggregateCostSeries(window), series);
        assert.equal(store.aggregateCostSeries({
          since: new Date(start - bucketSeconds * 1000).toISOString(),
          until: new Date(start - 1).toISOString(), bucketSeconds
        }).length, 0);
        assert.equal(store.aggregateCostSeries({
          since: new Date(start + bucketSeconds * 1000).toISOString(),
          until: new Date(start + 2 * bucketSeconds * 1000 - 1).toISOString(), bucketSeconds
        }).length, 0);
      }
      const sessions = store.db.prepare("SELECT session_id, SUM(json_extract(dimensions, '$.cost')) AS cost FROM metric_points WHERE source = 'jsonl_usage' GROUP BY session_id").all();
      assert.deepEqual(sessions, [{ session_id: scenario.session, cost: dims.cost }]);
    });
  }
}
