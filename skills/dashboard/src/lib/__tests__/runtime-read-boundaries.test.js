import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../store.js';
import { HistoryService } from '../history/history-service.js';
import { createHistoryScope } from '../history/history-scope.js';
import { claudeProjectSlug } from '../claude-project-path.js';

// Local files, private SQLite and in-process HTTP handlers only. The official
// runner isolates HOME/ZYLOS_DIR before imports. No server, tmux, PM2 or network.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-reads-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(path.join(root, 'dashboard.db'));
  t.after(() => store.close());
  return { root, store };
}
const event = (runtime, id, timestamp) => ({ runtime, id, ingest_id: id, session_id: id,
  session_group: 'dashboard:team', timestamp, event_type: 'session_start', category: 'lifecycle' });

test('history attribution retains AGY in cold reads, warm imports and external commits', async t => {
  const { root, store } = fixture(t);
  store.insertEvent(event('claude', 'old', '2026-01-01T00:00:00Z'));
  store.insertEvent(event('agy', 'cold', '2026-01-02T00:00:00Z'));
  assert.equal(store.getHistoryAttribution()[0].runtime, 'agy');
  assert.equal(store.getHistoryAttribution()[0].session_id, 'cold');
  const revision = store.historyRevision;
  store.insertEvent(event('agy', 'warm', '2026-01-03T00:00:00Z'));
  assert.ok(store.historyRevision > revision);
  assert.equal(store.getHistoryAttribution()[0].session_id, 'warm');
  const external = new Store(path.join(root, 'dashboard.db'));
  t.after(() => external.close());
  external.insertEvent(event('agy', 'external', '2026-01-04T00:00:00Z'));
  assert.equal(store.getHistoryAttribution()[0].session_id, 'external');
  const resolve = createHistoryScope({ config: { runtime: 'claude' }, store,
    load: async name => name === 'config.js' ? { readSessionMode: () => ({ mode: 'multi' }) }
      : { assertSessionGroup: () => {} } });
  assert.equal((await resolve(new URLSearchParams({ session_group: 'dashboard:team' }))).runtime, 'agy');
});

async function request(service, suffix) {
  const url = new URL('/api/observer/history/' + suffix, 'http://fixture');
  const response = { apiPath: url.pathname,
    writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
  assert.equal(await service.handle({ method: 'GET' }, response, url), true);
  return response;
}
const redactor = { async redact(text) { return { text, count: 0, kinds: [] }; } };

for (const scoped of [false, true]) test(`AGY ${scoped ? 'group override' : 'instance'} history does not expose Claude files`, async t => {
  const { root } = fixture(t);
  const project = path.join(os.homedir(), '.claude/projects', claudeProjectSlug(root));
  fs.mkdirSync(project, { recursive: true });
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  fs.writeFileSync(path.join(project, 'claude-session.jsonl'), JSON.stringify({ type: 'assistant',
    message: { content: [{ type: 'text', text: 'Claude-only transcript' }] } }) + '\n');
  const config = { runtime: scoped ? 'claude' : 'agy', zylosDir: root };
  const service = new HistoryService({ config, redactor, resolveScope: scoped ? async () => ({
    runtime: 'agy', revision: 1, currentSessionId: 'claude-session', sessionIds: null,
    excludedSessionIds: new Set(),
  }) : undefined });
  t.after(() => service.close());
  const listing = scoped ? (await request(service, 'sessions?session_group=dashboard:team')).body : await service.sessions();
  assert.deepEqual(listing, { runtime: 'agy', current: null, sessions: [] });
  for (const suffix of ['entries?session=claude-session', 'content?session=claude-session&entry=o:0&field=body',
    'search?session=claude-session&q=Claude']) {
    const response = await request(service, suffix);
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'session_not_found');
  }
  // The sentinel is a valid real Claude transcript, so emptiness above proves
  // runtime separation rather than an unreadable fixture.
  const claude = new HistoryService({ config: { ...config, runtime: 'claude' }, redactor });
  t.after(() => claude.close());
  assert.equal((await claude.sessions()).sessions[0].id, 'claude-session');
});
