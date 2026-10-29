import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { createRedactor, redact, UNAVAILABLE } from '../src/lib/redaction/engine.js';
import { HistoryService } from '../src/lib/history/history-service.js';
import { ObserverService } from '../src/lib/observer-service.js';

const engineURL = new URL('../src/lib/redaction/engine.js', import.meta.url);
const workerURL = new URL('../src/lib/redaction/worker.js', import.meta.url);

function fixture(sessionCount) {
  const sessions = new Map();
  const secrets = [];
  for (let s = 0; s < sessionCount; s++) {
    const id = `session-${s}`;
    const entries = Array.from({ length: 200 }, (_, i) => {
      const marker = `session ${s} entry ${i}`;
      const secret = `zylos_st_queue_fixture_${s}_${i}_private_value`;
      secrets.push(secret);
      return {
        id: `o:${i * 10}`, kind: i % 2 ? 'internal' : 'text',
        summary: `${marker} summary`,
        fields: {
          body: `${marker} body 中文 ${secret} end`,
          raw: { note: `${marker} raw ${secret} end`, plain: `${marker} ordinary text` },
        },
      };
    });
    sessions.set(id, entries);
  }
  return {
    sessions, secrets,
    parser: {
      async listSessions() { return { sessions: [...sessions.keys()].map(id => ({ id })) }; },
      async loadSession(id) {
        const entries = sessions.get(id);
        return { entries, index: { lines: entries.map(entry => ({ offset: Number(entry.id.slice(2)) })) }, generation: 1 };
      },
    },
  };
}

async function pages(createEngine, sessionCount) {
  const data = fixture(sessionCount);
  const history = new HistoryService({ parser: data.parser, redactor: createEngine({ workerURL }) });
  const observer = new ObserverService({ historyService: history,
    containment: {}, manager: {},
    coordinator: { historyStatus: async () => ({ state: 'installed', desired: { enabled: true } }) },
    authGate: { enabled: true, resolveAuthContext: () => ({ kind: 'api', scope: 'admin' }) },
  });
  const server = http.createServer((req, res) => observer.handle(req, res, new URL(req.url, 'http://localhost')));
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/observer/history/entries`;
    const responses = await Promise.all([...data.sessions.keys()].map(async session => {
      const response = await fetch(`${base}?session=${session}&internal=1&limit=200`);
      return { session, status: response.status, body: await response.json() };
    }));
    return { ...data, responses };
  } finally {
    await history.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

// Shared acceptance predicate for the live implementation and source mutant.
// Exact content checks distinguish successful redaction from fail-closed masking.
function assertComplete(result) {
  for (const { session, status, body } of result.responses) {
    assert.equal(status, 200);
    assert.equal(body.entries.length, 200);
    assert.equal(body.entries.filter(entry => entry.kind === 'internal').length, 100);
    assert.equal(JSON.stringify(body).includes(UNAVAILABLE), false, `${session}: all fields remain available`);
    for (const secret of result.secrets) assert.equal(JSON.stringify(body).includes(secret), false);
    const originals = result.sessions.get(session);
    for (let i = 0; i < originals.length; i++) {
      const original = originals[i], actual = body.entries[i];
      assert.equal(actual.id, original.id);
      assert.equal(actual.kind, original.kind);
      assert.equal(actual.summary, original.summary);
      assert.deepEqual(Object.keys(actual.fields), ['body', 'raw']);
      const expected = {
        body: redact(original.fields.body).text,
        raw: JSON.stringify({ note: redact(original.fields.raw.note).text, plain: original.fields.raw.plain }, null, 2),
      };
      for (const [field, text] of Object.entries(expected)) {
        assert.deepEqual(actual.fields[field], { preview: text, total: text.length, truncated: false }, `${session}/${actual.id}/${field}`);
        assert.match(text, /已遮蔽/);
      }
      assert.equal(actual.redaction.count, 2);
    }
  }
}

test('HTTP internal=1&limit=200 returns every field with the production redactor', async () => {
  assertComplete(await pages(createRedactor, 1));
});

test('four concurrent cold HTTP pages of 200 entries remain complete and redacted', async () => {
  // Distinct sessions and values prevent a warmed cache from hiding queue pressure.
  assertComplete(await pages(createRedactor, 4));
});

test('negative control: restoring the 128-job rejection fails the same HTTP acceptance predicate', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'history-queue-mutant-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workerSource = await fs.readFile(new URL('../src/lib/redaction/worker-client.js', import.meta.url), 'utf8');
  const guard = /if \(closed\)\s*return Promise\.resolve\(failure\(\)\);/;
  assert.match(workerSource, guard, 'mutation anchor must match the production closed guard');
  const mutantWorker = workerSource.replace(guard, 'if (closed || queue.length + Number(Boolean(active)) >= 128) return Promise.resolve(failure());');
  const mutantWorkerURL = pathToFileURL(path.join(root, 'worker-client.mjs'));
  await fs.writeFile(mutantWorkerURL, mutantWorker);
  const source = await fs.readFile(engineURL, 'utf8');
  const mutantEngine = source.replace(/from '(\.\/?[^']+)'/g, (_, specifier) => {
    const target = specifier === './worker-client.js' ? mutantWorkerURL : new URL(specifier, engineURL);
    return `from ${JSON.stringify(target.href)}`;
  });
  const mutantEngineURL = pathToFileURL(path.join(root, 'engine.mjs'));
  await fs.writeFile(mutantEngineURL, mutantEngine);
  const mutant = await import(mutantEngineURL.href);
  for (const count of [1, 4]) {
    const result = await pages(mutant.createRedactor, count);
    assert.throws(() => assertComplete(result), /all fields remain available/);
    assert.ok(result.responses.some(({ body }) => body.entries.some(entry => JSON.stringify(entry).includes(UNAVAILABLE))));
    // The mutant must fail availability, while retaining fail-closed credential safety.
    for (const { body } of result.responses) {
      const serialized = JSON.stringify(body);
      for (const secret of result.secrets) assert.equal(serialized.includes(secret), false);
    }
  }
});
