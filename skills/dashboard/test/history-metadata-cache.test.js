import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ClaudeHistory } from '../src/lib/history/claude-history.js';
import { CodexHistory } from '../src/lib/history/codex-history.js';
import { claudeProjectSlug } from '../src/lib/claude-project-path.js';

async function fixture(t, runtime, count = 260) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'history-metadata-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const homeDir = path.join(root, 'home');
  const zylosDir = path.join(homeDir, 'zylos');
  await fs.mkdir(zylosDir, { recursive: true });
  const transcriptRoot = runtime === 'claude'
    ? path.join(homeDir, '.claude', 'projects', claudeProjectSlug(zylosDir))
    : path.join(homeDir, '.codex', 'sessions');
  await fs.mkdir(transcriptRoot, { recursive: true });
  const rows = Array.from({ length: count }, (_, i) => ({
    session_id: `session-${i}`,
    transcript_path: path.join(transcriptRoot, `${runtime === 'codex' ? 'rollout-' : ''}session-${i}.jsonl`)
  }));
  await Promise.all(rows.map((row, i) => fs.writeFile(row.transcript_path, JSON.stringify(runtime === 'claude'
    ? { type: 'user', timestamp: '2026-09-27T00:00:00Z', message: { content: `Title ${i}` } }
    : { type: 'session_meta', timestamp: '2026-09-27T00:00:00Z', payload: { id: row.session_id } }) + '\n')));
  const options = { homeDir, zylosDir, store: {
    listCodexRolloutPaths: () => rows,
    latestCodexRolloutPath: () => rows[0]
  } };
  return { options, rows, transcriptRoot };
}

function transcriptIO(t) {
  const metrics = { opens: 0, bytes: 0 };
  const open = fs.open.bind(fs);
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await open(...args);
    if (String(args[0]).endsWith('.jsonl')) {
      metrics.opens++;
      const read = handle.read.bind(handle);
      handle.read = async (...readArgs) => {
        const result = await read(...readArgs);
        metrics.bytes += result.bytesRead;
        return result;
      };
    }
    return handle;
  });
  return metrics;
}

async function assertWarmListing(parser, metrics, count) {
  metrics.opens = 0; metrics.bytes = 0;
  assert.equal((await parser.listSessions()).sessions.length, count);
  assert.deepEqual(metrics, { opens: 0, bytes: 0 }, 'unchanged listing must not reopen or read transcripts');
}

for (const [runtime, Parser] of [['claude', ClaudeHistory], ['codex', CodexHistory]]) {
  test(`${runtime}: 260 unchanged sessions retain metadata with zero warm transcript IO`, async t => {
    const { options, rows } = await fixture(t, runtime);
    const metrics = transcriptIO(t);
    const parser = new Parser(options);
    assert.equal((await parser.listSessions()).sessions.length, rows.length);
    assert.ok(metrics.opens >= rows.length, 'instrumentation observes cold transcript opens');
    assert.ok(metrics.bytes > 0, 'instrumentation observes cold transcript reads');
    assert.equal(parser.metadataCache.size, rows.length);
    await assertWarmListing(parser, metrics, rows.length);
    await assertWarmListing(parser, metrics, rows.length);
  });

  test(`${runtime}: deleted files prune metadata even when rollout rows remain`, async t => {
    const { options, rows } = await fixture(t, runtime, 3);
    const parser = new Parser(options);
    await parser.listSessions();
    await fs.unlink(rows[0].transcript_path);
    const metrics = transcriptIO(t);
    const list = await parser.listSessions();
    assert.equal(rows.length, 3, 'discovery store deliberately retains the deleted rollout row');
    assert.equal(list.sessions.length, 2);
    assert.equal(list.sessions.some(session => session.id === rows[0].session_id), false);
    assert.equal(parser.paths.has(rows[0].session_id), false);
    assert.equal(parser.metadataCache.has(rows[0].transcript_path), false);
    assert.equal(parser.metadataCache.size, 2);
    assert.deepEqual(metrics, { opens: 0, bytes: 0 });
    await assertWarmListing(parser, metrics, 2);
  });

  test(`${runtime}: disappearing root clears stale paths and metadata`, async t => {
    const { options, rows, transcriptRoot } = await fixture(t, runtime, 2);
    const parser = new Parser(options);
    await parser.listSessions();
    assert.equal(parser.paths.size, 2);
    assert.equal(parser.metadataCache.size, 2);
    await fs.rename(transcriptRoot, transcriptRoot + '-moved');
    assert.deepEqual(await parser.listSessions(), { runtime, current: null, sessions: [] });
    assert.equal(parser.paths.size, 0);
    assert.equal(parser.metadataCache.size, 0);
    assert.equal(rows.length, 2, 'Codex store retains stale rows while the root is absent');
  });
}

test('Codex: excluded subagent metadata stays warm and is pruned only when its file disappears', async t => {
  const { options, rows } = await fixture(t, 'codex', 2);
  await fs.writeFile(rows[1].transcript_path, JSON.stringify({
    type: 'session_meta', payload: { id: rows[1].session_id, source: { subagent: 'review' } }
  }) + '\n');
  const parser = new CodexHistory(options);
  const metrics = transcriptIO(t);
  const list = await parser.listSessions();
  assert.deepEqual(list.sessions.map(session => session.id), [rows[0].session_id]);
  assert.ok(metrics.bytes > 0);
  assert.equal(parser.metadataCache.size, 2, 'hidden subagent metadata belongs to the scanned-file set');
  assert.equal(parser.paths.has(rows[1].session_id), false);
  await assertWarmListing(parser, metrics, 1);
  await assertWarmListing(parser, metrics, 1);
  await fs.unlink(rows[1].transcript_path);
  await assertWarmListing(parser, metrics, 1);
  assert.equal(parser.metadataCache.has(rows[1].transcript_path), false);
  assert.equal(parser.metadataCache.size, 1);
});

test('negative control: restoring Claude fixed-256 eviction fails the same warm-list acceptance', async t => {
  const { options, rows } = await fixture(t, 'claude');
  const sourceUrl = new URL('../src/lib/history/claude-history.js', import.meta.url);
  const source = await fs.readFile(sourceUrl, 'utf8');
  const insertion = 'this.metadataCache.set(filePath, result);';
  assert.equal(source.split(insertion).length, 2, 'mutant must alter exactly one metadata insertion');
  const mutantSource = source.replace(insertion, `${insertion}\n    while (this.metadataCache.size > 256) this.metadataCache.delete(this.metadataCache.keys().next().value);`)
    .replace(/from '([.][^']+)'/g, (_, relative) => `from '${new URL(relative, sourceUrl).href}'`);
  const { ClaudeHistory: Mutant } = await import(`data:text/javascript;base64,${Buffer.from(mutantSource).toString('base64')}`);
  const metrics = transcriptIO(t);
  const live = new ClaudeHistory(options);
  await live.listSessions();
  await assertWarmListing(live, metrics, rows.length);
  const mutant = new Mutant(options);
  assert.equal((await mutant.listSessions()).sessions.length, rows.length);
  await assert.rejects(assertWarmListing(mutant, metrics, rows.length), {
    code: 'ERR_ASSERTION', message: /unchanged listing must not reopen or read transcripts/
  });
  assert.ok(metrics.opens > 0 && metrics.bytes > 0, 'fixed-size eviction causes real transcript rereads');
});
