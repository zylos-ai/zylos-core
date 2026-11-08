import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTENT_PREFIX, parseC4Content } from '../c4-content-schema.js';
import { projectC4Content } from '../c4-content-projection.js';

// Boundary: public suppression writer -> persisted Core row -> parser/model
// projection, including View framing. Run for writer wording/framing/projection
// changes; unrelated runtime/UI changes may skip. Only private fixture paths;
// no process, model, PM2, tmux, network or background loop starts.
test('persisted suppression notices preserve text, structured blocks and views when read back', async t => {
  const root = fs.realpathSync(fs.mkdtempSync('/tmp/c4suffix-'));
  const env = { HOME: path.join(root, 'h'), ZYLOS_DIR: path.join(root, 'z'),
    PM2_HOME: path.join(root, 'p'), TMPDIR: path.join(root, 't'), TMUX_TMPDIR: path.join(root, 't'),
    ZYLOS_PACKAGE_ROOT: fileURLToPath(new URL('../../../../', import.meta.url)) };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  let api;
  t.after(() => {
    try { api?.close(); }
    finally {
      fs.rmSync(root, { recursive: true, force: true });
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR']) {
    fs.mkdirSync(env[key], { recursive: true });
    assert.ok(fs.realpathSync(env[key]).startsWith(root + path.sep));
  }
  assert.ok(!root.startsWith(fs.realpathSync(os.userInfo().homedir) + path.sep));
  Object.assign(process.env, env);
  const config = path.join(env.ZYLOS_DIR, '.zylos/config.json');
  fs.mkdirSync(path.dirname(config), { recursive: true });
  fs.writeFileSync(config, JSON.stringify({ runtime: 'claude', session_mode: 'multi' }));
  const dbPath = path.join(env.ZYLOS_DIR, 'comm-bridge/c4.db');
  assert.ok(dbPath.startsWith(root + path.sep));
  console.log(JSON.stringify({ root, ...env, dbPath, tmux: 'not spawned' }));
  api = await import('../c4-db.js');
  const db = api.getDb();
  assert.equal(db.name, dbPath);
  const block = { id: 'body', type: 'markdown', schemaVersion: 1, data: { text: 'Original 中文' }, fallbackText: 'Original 中文' };
  const envelope = { version: 1, kind: 'message', messageId: 'suppressed_message', fallbackText: 'Original 中文', blocks: [block] };
  const view = { schemaVersion: 1, root: 'stack', nodes: [
    { id: 'stack', type: 'stack', children: ['body_ref'] }, { id: 'body_ref', type: 'block', blockId: 'body' },
  ] };
  const samples = ['Plain text 中文', CONTENT_PREFIX + JSON.stringify(envelope),
    CONTENT_PREFIX + JSON.stringify({ ...envelope, metadata: { view } })];
  for (const original of samples) {
    const before = parseC4Content(original);
    assert.ok(['text', 'envelope'].includes(before.kind));
    assert.equal(before.viewError, undefined);
    const id = db.prepare(`INSERT INTO conversations(direction,channel,endpoint_id,session_group,content,status)
      VALUES('in','fixture','room','fixture:room',?,'failed')`).run(original).lastInsertRowid;
    assert.equal(api.markStatusNoticeSuppressed(id, { sessionGroup: 'fixture:room', channel: 'fixture',
      endpointId: 'room', health: 'unavailable', reason: 'waiting for recovery' }), true);
    const saved = db.prepare('SELECT content,delivery_action FROM conversations WHERE id=?').get(id);
    assert.equal(saved.delivery_action, 'suppressed');
    assert.equal(saved.content.slice(0, original.length), original);
    const suffix = saved.content.slice(original.length);
    assert.ok(suffix.startsWith('\n\n[C4] '));
    const parsed = parseC4Content(saved.content);
    assert.equal(parsed.kind, before.kind);
    if (before.kind === 'text') {
      // Plain text deliberately retains the notice in its existing projection.
      assert.equal(parsed.text, original + suffix);
      assert.equal(projectC4Content(saved.content, { c4Id: id }), original + suffix);
    } else {
      assert.equal(parsed.suffix, suffix, 'the real writer suffix is recognized by the real parser');
      assert.deepEqual(parsed.envelope, before.envelope);
      assert.deepEqual(parsed.view, before.view);
      assert.equal(parsed.viewError, undefined);
      assert.equal(projectC4Content(saved.content, { c4Id: id }), projectC4Content(original, { c4Id: id }));
    }
  }
});
