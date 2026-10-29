import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { IngestHandler } from '../src/lib/ingest-handler.js';

function blockFor(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) { /* deliberately starve the loop */ }
}

function makeHandler({ slowMs, onEvent }) {
  const store = {
    insertEvent: () => ({ inserted: true }),
    upsertSourceHealth: () => {}
  };
  const sanitizer = {
    sanitizeHookPayload: (_name, body) => ({
      session_id: body.session_id,
      summary: 'Bash: echo',
      duration_ms: 1,
      metadata: '{}'
    })
  };
  const stateEngine = { onEvent };
  return new IngestHandler(store, sanitizer, stateEngine, {
    observability: { slow_ingest_warn_ms: slowMs }
  });
}

async function postEvent(handler) {
  const server = http.createServer((req, res) => handler.handle(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ingest_id: 'evt-1',
        hook_event_name: 'PostToolUse',
        session_id: 's1'
      })
    });
    return resp;
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function captureStderr(fn) {
  const lines = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => {
    lines.push(String(chunk));
    return original.call(process.stderr, chunk, ...rest);
  };
  try {
    await fn();
  } finally {
    process.stderr.write = original;
  }
  return lines;
}

test('ingest handler warns when one event exceeds the slow threshold (#260)', async () => {
  const handler = makeHandler({ slowMs: 20, onEvent: () => blockFor(60) });
  const lines = await captureStderr(async () => {
    const resp = await postEvent(handler);
    assert.equal(resp.status, 200);
  });
  const slow = lines.filter(l => l.includes('[ingest-handler] slow event'));
  assert.equal(slow.length, 1);
  assert.match(slow[0], /slow event: PostToolUse took \d+ms \(payload \d+B\)/);
});

test('ingest handler stays quiet for fast events (#260)', async () => {
  const handler = makeHandler({ slowMs: 50, onEvent: () => {} });
  const lines = await captureStderr(async () => {
    const resp = await postEvent(handler);
    assert.equal(resp.status, 200);
  });
  assert.equal(lines.filter(l => l.includes('slow event')).length, 0);
});
