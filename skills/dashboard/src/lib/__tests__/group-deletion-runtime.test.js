import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from '../../../../comm-bridge/scripts/sqlite-driver.js';
import { guardDatabase } from '../../../../comm-bridge/scripts/sqlite-schema.js';
import * as c4Schema from '../../../../comm-bridge/scripts/c4-schema.js';
import { Store } from '../store.js';
import { createGroupDeletionStorage } from '../group-deletion-storage.js';

// Real deletion participant, local files and private SQLite only. The official
// runner isolates HOME/ZYLOS_DIR/PM2_HOME/TMPDIR before imports. No service,
// terminal, loopback listener, background process or network request is used.
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'delete-runtime-')));
  const home = path.join(root, 'home'), zylos = path.join(home, 'zylos'), tmpdir = path.join(root, 'tmp');
  fs.mkdirSync(zylos, { recursive: true }); fs.mkdirSync(tmpdir);
  const c4Db = new Database(path.join(root, 'c4.db')); guardDatabase(c4Db, c4Schema);
  c4Db.prepare("INSERT INTO channel_namespaces(namespace,component_name) VALUES ('dashboard','dashboard')").run();
  const store = new Store(path.join(zylos, 'components/dashboard/dashboard.db'));
  const participant = createGroupDeletionStorage({ zylosDir: zylos, homeDir: home, tmpdir, c4Db, store, uid: '123' });
  t.after(() => { participant.close(); store.close(); c4Db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const message = group => c4Db.prepare(`INSERT INTO conversations(direction,channel,endpoint_id,session_group,content,status)
    VALUES ('in','dashboard',?,?,'old','delivered')`).run(group.split(':')[1], group);
  const register = id => store.db.prepare("INSERT INTO chat_conversations(local_id,namespace,state,created_at,updated_at) VALUES (?,'dashboard','active',1,1)").run(id);
  const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };
  return { root, home, zylos, tmpdir, c4Db, store, participant, message, register, write };
}

// AGY native transcripts are not collected. Generic imported events and chat
// data can still be removed after stop; no runtime files are inferred from ids.
test('AGY group deletion removes generic history without touching native runtime files', t => {
  const f = fixture(t), group = 'dashboard:agy-no-transcripts';
  f.register('agy-no-transcripts'); f.message(group);
  f.store.insertEvent({ id: 'agy-event', ingest_id: 'agy-event', runtime: 'agy',
    session_id: 'agy-session', session_group: group, timestamp: '2026-01-01T00:00:00Z',
    event_type: 'session_start', category: 'lifecycle' });
  const native = f.write(path.join(f.home, '.gemini/antigravity-cli/transcripts/agy-session.jsonl'), 'native bytes');
  const other = f.write(path.join(f.home, '.codex/sessions/rollout-agy-session.jsonl'), 'codex bytes');
  const mapping = f.store.insertUsageTranscript({ transcript_path: native, runtime: 'agy', session_group: group,
    session_id: 'agy-session' }, new Date().toISOString());
  assert.equal(mapping.changes, 0, 'native transcript ownership remains limited to supported collectors');
  assert.equal(f.participant.preview({ sessionGroup: group }).files, 0);
  assert.equal(f.participant.finalizeTranscripts({ sessionGroup: group, processExited: true }).transcripts, 0);
  const result = f.participant.cleanup({ sessionGroup: group });
  assert.equal(result.files, 0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM runtime_events WHERE session_group=?').get(group).n, 0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM chat_conversations WHERE local_id=?').get('agy-no-transcripts').n, 0);
  assert.equal(fs.readFileSync(native, 'utf8'), 'native bytes');
  assert.equal(fs.readFileSync(other, 'utf8'), 'codex bytes');
});
