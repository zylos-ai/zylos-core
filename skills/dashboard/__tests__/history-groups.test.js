import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Store } from '../src/lib/store.js';
import { HistoryService } from '../src/lib/history/history-service.js';
import { createHistoryScope } from '../src/lib/history/history-scope.js';
import { claudeProjectSlug } from '../src/lib/claude-project-path.js';
import { assertSessionGroup } from '../../../cli/lib/session-group-paths.js';

// Real parsers, imported attribution and HTTP handlers; only the session-mode
// reader is injected. Run for history scope/runtime/read changes. Fixtures live
// under the runner's isolated HOME/ZYLOS_DIR, and no terminal or PM2 is opened.
test('history isolates Origin, offline groups and cross-runtime sessions on every route', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'history-groups-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const zylosDir = path.join(root, 'zylos');
  await fs.mkdir(zylosDir);
  const store = new Store(path.join(root, 'history.db'));
  t.after(() => store.close());
  let mode = 'multi';
  let liveSingleSessionId = null;
  const load = async name => name === 'config.js' ? { readSessionMode: () => ({ mode }) } : { assertSessionGroup };
  const config = { zylosDir, runtime: 'claude' };
  const project = path.join(os.homedir(), '.claude', 'projects', claudeProjectSlug(zylosDir));
  await fs.mkdir(project, { recursive: true });
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  const record = text => JSON.stringify({ type: 'assistant', timestamp: 1700000000000, message: { content: [{ type: 'text', text }] } }) + '\n';
  for (const [id, group, runtime] of [['origin-session', null, 'claude'], ['team-session', 'telegram:team', 'claude'], ['codex-session', 'dashboard:codex', 'codex']]) {
    store.insertEvent({ id, ingest_id: id, session_id: id, session_group: group, runtime,
      event_type: 'session_start', category: 'lifecycle', timestamp: '2026-01-01T00:00:00Z' });
    if (runtime === 'claude') await fs.writeFile(path.join(project, id + '.jsonl'), record(id + ' needle'));
  }
  await fs.writeFile(path.join(project, 'unattributed.jsonl'), record('legacy needle'));
  const subagents = path.join(project, 'team-session', 'subagents');
  await fs.mkdir(subagents, { recursive: true });
  await fs.writeFile(path.join(subagents, 'agent-child.jsonl'), record('child needle'));
  const codexRoot = path.join(os.homedir(), '.codex', 'sessions');
  await fs.mkdir(codexRoot, { recursive: true });
  const rollout = path.join(codexRoot, 'rollout-history-group-fixture.jsonl');
  t.after(() => fs.rm(rollout, { force: true }));
  await fs.writeFile(rollout, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'codex needle' }] } }) + '\n');
  store.db.prepare('INSERT INTO codex_rollout_paths(runtime,session_id,transcript_path) VALUES(?,?,?)').run('codex', 'codex-session', rollout);
  const service = new HistoryService({ config, store, resolveScope: createHistoryScope({ config, store, load,
    readCurrentSessionId: () => liveSingleSessionId }) });
  t.after(() => service.close());
  const server = http.createServer((req, res) => { const url = new URL(req.url, 'http://fixture'); res.apiPath = url.pathname; return service.handle(req, res, url); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const observations = [];
  let attributionScans = 0, directoryScans = 0;
  const prepare = store.db.prepare.bind(store.db);
  t.mock.method(store.db, 'prepare', (sql, ...args) => {
    if (sql.includes('GROUP BY session_id, runtime, session_group')) attributionScans++;
    return prepare(sql, ...args);
  });
  const readdir = fs.readdir.bind(fs);
  t.mock.method(fs, 'readdir', (...args) => {
    if (String(args[0]).startsWith(project)) directoryScans++;
    return readdir(...args);
  });
  const get = async (route, params = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/observer/history/${route}?${new URLSearchParams(params)}`);
    const result = { status: response.status, body: await response.json() };
    observations.push({ mode, method: 'GET', route: '/api/observer/history/' + route, params, ...result });
    return result;
  };
  assert.deepEqual((await get('sessions')).body.sessions.map(row => row.id).sort(), ['origin-session', 'unattributed']);
  const team = await get('sessions', { session_group: 'telegram:team' });
  assert.deepEqual(team.body.sessions.map(row => row.id).sort(), ['team-session', 'team-session/agent-child']);
  assert.equal(team.body.current, null, 'offline groups need no live session');
  const codex = await get('sessions', { session_group: 'dashboard:codex' });
  assert.equal(codex.body.runtime, 'codex');
  assert.deepEqual(codex.body.sessions.map(row => row.id), ['codex-session']);
  for (const group of ['telegram:team', 'dashboard:codex']) {
    const session = group === 'telegram:team' ? 'team-session' : 'codex-session';
    for (const route of ['entries', 'content', 'search']) {
      const params = { session_group: group, session, entry: 'o:0', field: 'body', q: 'needle' };
      assert.equal((await get(route, params)).status, 200, `${group} ${route}`);
      const denied = await get(route, { ...params, session: 'origin-session' });
      assert.equal(denied.status, 404);
      assert.equal(denied.body.error.code, 'session_not_found');
    }
  }
  const parallel = await Promise.all(['telegram:team', 'dashboard:codex', 'origin'].map(session_group => get('sessions', { session_group })));
  assert.deepEqual(parallel.map(item => item.body.runtime), ['claude', 'codex', 'claude']);
  assert.equal(parallel[2].body.sessions.some(row => row.id.startsWith('team-session')), false);
  assert.equal(attributionScans, 1, 'one attribution query serves all groups');
  const scans = directoryScans;
  store.insertEvent({ id: 'ordinary-event', ingest_id: 'ordinary-event', session_id: 'team-session', session_group: 'telegram:team',
    runtime: 'claude', event_type: 'tool_use', category: 'tool', timestamp: '2026-01-02T00:00:00Z' });
  await get('sessions', { session_group: 'telegram:team' });
  assert.equal(attributionScans, 1, 'ordinary events reuse attribution');
  await get('entries', { session_group: 'telegram:team', session: 'team-session' });
  assert.equal(directoryScans, scans, 'warm requests reuse the scoped resolver paths');
  await fs.writeFile(path.join(project, 'new-team-session.jsonl'), record('new session needle'));
  store.insertEvent({ id: 'new-team-event', ingest_id: 'new-team-event', session_id: 'new-team-session', session_group: 'telegram:team',
    runtime: 'claude', event_type: 'session_start', category: 'lifecycle', timestamp: '2026-01-02T00:00:00Z' });
  assert.ok((await get('sessions', { session_group: 'telegram:team' })).body.sessions.some(row => row.id === 'new-team-session'));
  assert.equal(attributionScans, 1, 'a new combination is added incrementally');
  assert.ok(directoryScans > scans, 'a new import refreshes transcript discovery');
  await fs.writeFile(path.join(subagents, 'agent-later.jsonl'), record('later child needle'));
  assert.ok((await get('sessions', { session_group: 'telegram:team' })).body.sessions.some(row => row.id === 'team-session/agent-later'),
    'new subagent files are discovered without any new attribution');
  const external = new Store(path.join(root, 'history.db'));
  try {
    external.db.prepare('DELETE FROM runtime_events WHERE session_id = ?').run('new-team-session');
    assert.equal((await get('sessions', { session_group: 'telegram:team' })).body.sessions.some(row => row.id === 'new-team-session'), false,
      'CLI deletion through another connection invalidates cached group membership');
    assert.equal(attributionScans, 2, 'external commit refreshes attribution once');
  } finally { external.close(); }
  const readyDir = path.join(zylosDir, 'activity-monitor', 'session-groups', 'telegram:team');
  await fs.mkdir(readyDir, { recursive: true });
  await fs.writeFile(path.join(readyDir, 'current-session.json'), JSON.stringify({ sessionId: 'team-session' }));
  assert.equal((await get('sessions', { session_group: 'telegram:team' })).body.current, 'team-session');
  assert.equal((await get('entries', { session: 'team-session' })).status, 404);
  assert.equal((await get('sessions', { session_group: '../escape' })).status, 400);
  mode = 'single';
  assert.equal((await get('sessions', { session_group: 'telegram:team' })).body.error.code, 'target_mismatch');
  const staleOrigin = path.join(zylosDir, 'activity-monitor', 'session-groups', 'origin');
  await fs.mkdir(staleOrigin, { recursive: true });
  await fs.writeFile(path.join(staleOrigin, 'current-session.json'), JSON.stringify({ sessionId: 'origin-session' }));
  await fs.writeFile(path.join(zylosDir, 'activity-monitor', 'statusline.json'), JSON.stringify({ session_id: 'unattributed' }));
  assert.equal((await get('sessions', { session_group: 'origin' })).body.current, null, 'single mode ignores a stale multi-session pointer');
  liveSingleSessionId = 'origin-session';
  const single = await get('sessions', { session_group: 'origin' });
  assert.equal(single.status, 200);
  assert.equal(single.body.current, 'origin-session');
  for (const route of ['entries', 'content', 'search']) {
    assert.equal((await get(route, { session_group: 'origin', session: 'origin-session', entry: 'o:0', field: 'body', q: 'needle' })).status, 200);
  }
  if (process.env.DASHBOARD_HISTORY_EVIDENCE) {
    await fs.mkdir(path.dirname(process.env.DASHBOARD_HISTORY_EVIDENCE), { recursive: true });
    await fs.writeFile(process.env.DASHBOARD_HISTORY_EVIDENCE, JSON.stringify(observations, null, 2));
  }
});

test('history revisions track path changes and local deletion without invalidating on rollout timestamps', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'history-revisions-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new Store(path.join(root, 'history.db'));
  t.after(() => store.close());
  store.insertEvent({ id: 'old', ingest_id: 'old', session_id: 'session', runtime: 'codex',
    session_group: 'telegram:team', event_type: 'tool_end', category: 'tool', timestamp: '2020-01-01T00:00:00Z' });
  assert.equal(store.getHistoryAttribution().length, 1);
  store.insertEvent({ id: 'backfill', ingest_id: 'backfill', session_id: 'older-session', runtime: 'claude',
    session_group: 'telegram:team', event_type: 'tool_end', category: 'tool', timestamp: '2019-01-01T00:00:00Z' });
  assert.equal(store.getHistoryAttribution()[0].runtime, 'codex', 'backfilled events retain latest-runtime ordering');
  store.upsertCodexRolloutPath({ sessionId: 'session', transcriptPath: '/isolated/rollout.jsonl', lastEventAt: '2020-01-01T00:00:00Z' });
  const revision = store.historyRevision;
  store.upsertCodexRolloutPath({ sessionId: 'session', transcriptPath: '/isolated/rollout.jsonl', lastEventAt: '2020-01-02T00:00:00Z' });
  assert.equal(store.historyRevision, revision, 'timestamp-only imports keep discovery warm');
  store.upsertCodexRolloutPath({ sessionId: 'session', transcriptPath: '/isolated/rollout-moved.jsonl' });
  assert.ok(store.historyRevision > revision, 'a moved transcript refreshes discovery');
  store.deleteEventsOlderThan(1, '2026-01-01T00:00:00Z');
  assert.equal(store.getHistoryAttribution().length, 0, 'local pruning clears stale attribution');
});
