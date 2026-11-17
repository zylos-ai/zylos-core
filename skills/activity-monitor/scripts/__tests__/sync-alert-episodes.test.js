import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SyncAlertEpisodes } from '../sync-alert-episodes.js';

// Real atomic JSON publication and restart reads, entirely within owned temporary
// roots. Run for episode persistence/notification ownership changes; unrelated
// UI or prompts may skip. The official runner isolates HOME and ZYLOS_DIR before
// import; each fixture removes its private files. No processes or sockets start.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-episodes-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ZYLOS_DIR: root }, diagnostics = [];
  let clock = 1800000000000;
  return { root, env, diagnostics, advance: ms => { clock += ms; },
    create: extra => new SyncAlertEpisodes({ env, now: () => clock, diagnostic: row => diagnostics.push(row), ...extra }) };
}
const alert = (type = 'backlog', extra = {}) => ({ type, kind: 'group', scope: 'origin', ...extra });

test('an unresolved episode sends once across long duration and supervisor restarts', t => {
  const f = fixture(t);
  let store = f.create();
  for (const type of ['backlog', 'state_uncommitted', 'no_checkpoint', 'origin_frequency', 'origin_idle']) {
    const row = alert(type, { checkpointId: 7 });
    assert.equal(store.reconcile({ active: [row] }).length, 1);
    assert.equal(store.claim(row), true);
    f.advance(13 * 3600000); store = f.create();
    assert.equal(store.reconcile({ active: [row] }).length, 0);
    f.advance(90 * 86400000); store = f.create();
    assert.equal(store.claim(row), false);
    assert.equal(store.reconcile({ active: [] }).length, 0);
    assert.equal(store.claim(row), false, 'absence of observations does not resolve an episode');
    store.reconcile({ resolved: [row] });
    store = f.create();
    assert.equal(store.claim(row), true, 'verified resolution permits a new episode');
  }
  assert.equal(f.diagnostics.length, 0);
});

test('scope kind and type remain independent while every timeout control stays claimed permanently', t => {
  const f = fixture(t), store = f.create();
  const rows = [alert(), alert('backlog', { scope: 'other' }), alert('backlog', { kind: 'origin' }), alert('state_uncommitted')];
  for (const row of rows) assert.equal(store.claim(row), true);
  const timeout = alert('control_timeout', { controlId: 10 });
  assert.equal(store.claim(timeout), true);
  assert.equal(store.claim(alert('control_timeout', { controlId: 9 })), true);
  store.reconcile({ resolved: [timeout] });
  f.advance(100 * 86400000);
  assert.equal(f.create().claim(timeout), false);
  assert.equal(f.create().claim(alert('control_timeout', { controlId: 11 })), true);
});

test('failed enqueue may explicitly release its claim but an unknown send outcome remains claimed', t => {
  const f = fixture(t), row = alert(), store = f.create();
  assert.equal(store.claim(row), true);
  assert.equal(f.create().claim(row), false);
  assert.equal(store.retry(row), true);
  assert.equal(f.create().claim(row), true);
  assert.equal(f.create().claim(row), false);
});

test('corrupt unreadable and unsupported episode files close notification delivery and diagnose once', async t => {
  for (const state of ['malformed', 'unsupported', 'invalid entry', 'unreadable']) {
    await t.test(state, t => {
      const f = fixture(t), file = path.join(f.root, 'episodes.json');
      if (state === 'unreadable') fs.mkdirSync(file);
      else fs.writeFileSync(file, state === 'malformed' ? '{' : JSON.stringify(state === 'unsupported'
        ? { version: 2, episodes: [] } : { version: 1, episodes: [{ alert: {}, sent: true }] }));
      const store = f.create({ file });
      assert.equal(store.available, false);
      assert.equal(store.claim(alert()), false);
      assert.equal(store.retry(alert()), false);
      assert.equal(store.reconcile({ active: [alert()] }).length, 0);
      assert.equal(f.diagnostics.length, 1);
      assert.equal(f.diagnostics[0].event, 'sync_alert_state_unavailable');
      assert.equal(fs.existsSync(file), true);
    });
  }
});

test('failed atomic publication prevents sending and leaves the existing state untouched', t => {
  const f = fixture(t), parent = path.join(f.root, 'blocked');
  const store = f.create({ file: path.join(parent, 'episodes.json') });
  assert.equal(store.available, true);
  fs.writeFileSync(parent, 'not a directory');
  assert.equal(store.claim(alert()), false);
  assert.equal(store.available, false);
  assert.equal(f.diagnostics.length, 1);
  assert.equal(fs.readFileSync(parent, 'utf8'), 'not a directory');
});

test('atomic episode files keep metadata only and publish with private permissions', t => {
  const f = fixture(t), store = f.create();
  assert.equal(store.claim(alert('no_checkpoint', { checkpointId: 7, content: 'private body', token: 'private token' })), true);
  const text = fs.readFileSync(store.file, 'utf8');
  assert.equal(text.includes('private'), false);
  assert.equal(fs.statSync(store.file).mode & 0o777, 0o600);
  assert.equal(fs.readdirSync(path.dirname(store.file)).filter(name => name.endsWith('.tmp')).length, 0);
  assert.equal(f.create().entries()[0].checkpointId, 7);
});


test('Origin repair episodes preserve typed cursor baselines across restart without nested content', t => {
  const f = fixture(t), store = f.create();
  const row = alert('repair_failed', { kind: 'origin', cursors: [
    { scope: 'chat:one', syncedId: 12, checkpointId: 7, content: 'private nested content' },
  ] });
  assert.equal(store.claim(row), true);
  const restored = f.create().entries()[0];
  assert.deepEqual(restored.cursors, [{ scope: 'chat:one', syncedId: 12, checkpointId: 7 }]);
  assert.equal(fs.readFileSync(store.file, 'utf8').includes('private nested content'), false);
  assert.equal(f.create().claim(row), false);
  const bad = JSON.parse(fs.readFileSync(store.file, 'utf8'));
  bad.episodes[0].alert.cursors = [{ scope: 'chat:one', syncedId: '12', checkpointId: 7 }];
  fs.writeFileSync(store.file, JSON.stringify(bad));
  assert.equal(f.create().available, false);
  assert.equal(f.diagnostics.length, 1);
});
