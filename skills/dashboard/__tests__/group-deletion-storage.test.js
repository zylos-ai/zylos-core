import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from '../../comm-bridge/scripts/sqlite-driver.js';
import { guardDatabase } from '../../comm-bridge/scripts/sqlite-schema.js';
import * as c4Schema from '../../comm-bridge/scripts/c4-schema.js';
import { createStore } from '../../comm-bridge/scripts/c4-v2-store.js';
import { Store } from '../src/lib/store.js';
import { createGroupDeletionStorage } from '../src/lib/group-deletion-storage.js';
import { ChatConversations } from '../src/lib/chat/conversations.js';
import { ChatAttachments } from '../src/lib/chat/attachments.js';
import { UsageTranscripts } from '../src/lib/collectors/usage-transcripts.js';
import { ChatSender } from '../src/lib/chat/send.js';
import { handleChatConversations } from '../src/lib/chat/write-routes.js';
import { handleChatAttachments } from '../src/lib/chat/attachment-routes.js';
import { CoreLogImporter } from '../src/lib/core-log-importer.js';
import { receive } from '../../comm-bridge/scripts/c4-receive.js';
import { SKILLS_DIR } from '../../comm-bridge/scripts/c4-config.js';
import { isDataError } from '../../comm-bridge/scripts/c4-session-group.js';
import { buildAnnotatedContent } from '../../comm-bridge/scripts/attachment-annotations.js';
import { createGroupDeletion } from '../../../cli/lib/group-delete.js';
import { runGroupDeletionCli } from '../../../cli/lib/group-delete-cli.js';
import { Readable } from 'node:stream';

// Files/SQLite only. Run for deletion participants, final usage imports, or
// source ownership changes. No services, PM2, tmux, network or model/API calls.
// Official runner isolates HOME/ZYLOS_DIR/PM2_HOME and short TMPDIR before
// imports; every fixture owns its DBs/files and closes them on failure too.
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'delete-storage-')));
  const home = path.join(root, 'home'), zylos = path.join(home, 'zylos'), tmpdir = path.join(root, 'tmp');
  fs.mkdirSync(zylos, { recursive: true }); fs.mkdirSync(tmpdir);
  const c4Db = new Database(path.join(root, 'c4.db')); guardDatabase(c4Db, c4Schema);
  c4Db.prepare('INSERT INTO channel_namespaces(namespace,component_name) VALUES (?,?)').run('dashboard', 'dashboard');
  const store = new Store(path.join(zylos, 'components/dashboard/dashboard.db'));
  const participant = createGroupDeletionStorage({ zylosDir: zylos, homeDir: home, tmpdir, c4Db, store, uid: '123' });
  const conversations = new ChatConversations({ store });
  t.after(() => { participant.close(); store.close(); c4Db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const message = (group, status = 'delivered', content = 'old', direction = 'in') => Number(c4Db.prepare(`INSERT INTO conversations(direction,channel,endpoint_id,session_group,content,status)
    VALUES (?,'dashboard',?,?,?,?)`).run(direction, group.slice(group.indexOf(':') + 1), group, content, status).lastInsertRowid);
  const register = id => store.db.prepare("INSERT INTO chat_conversations(local_id,namespace,state,created_at,updated_at) VALUES (?,'dashboard','active',1,1)").run(id);
  const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };
  const transcript = (group, sid, runtime = 'claude', text = '') => {
    const file = runtime === 'claude' ? path.join(home, '.claude/projects/project', `${sid}.jsonl`)
      : path.join(home, '.codex/sessions', `rollout-${sid}.jsonl`);
    write(file, text);
    store.insertUsageTranscript({ transcript_path: file, runtime, session_group: group, session_id: sid, run_id: `run-${sid}` }, new Date().toISOString());
    return file;
  };
  return { root, home, zylos, tmpdir, c4Db, store, participant, conversations, message, register, write, transcript };
}
const groupId = group => `g:${Buffer.from(group).toString('hex').toUpperCase()}`;
const boundary = (core, group) => {
  const targetKey = JSON.stringify(['group', group]);
  return core.getDeletionPreviewBoundary(targetKey);
};
async function confirmation(service, target, operationId) {
  const { cutoffId } = await service.preview(target);
  return { confirmed: true, actor: 'owner', operationId, cutoffId };
}
function stoppedService(t, f, onStage = () => {}) {
  const coreStore = createStore(f.c4Db, { readConfig: () => ({ state: 'ok', config: { session_mode: 'multi' } }) });
  const service = createGroupDeletion({ zylosDir: f.zylos, homeDir: f.home, database: f.c4Db,
    store: coreStore, participant: f.participant, waitMs: 1000, onStage,
    requestStop: async request => {
      const audit = coreStore.beginGroupDeletion(request.sessionGroup, request);
      coreStore.recordRunEnd(request.sessionGroup, { runId: audit.operationId, reason: 'delete' });
      return { kind: 'accepted', sent: true };
    },
  });
  t.after(() => service.close());
  return { service, coreStore };
}

test('deleting a bound group preserves a same-local-id registration owned by another namespace', t => {
  const f = fixture(t), group = 'dashboard:same-local';
  f.message(group);
  f.store.db.prepare(`INSERT INTO chat_conversations(local_id,namespace,state,created_at,updated_at,first_content)
    VALUES ('same-local','olddash','active',1,2,'other namespace first content')`).run();
  const media = f.write(path.join(f.zylos, 'components/dashboard/media/other-namespace.txt'), 'other namespace bytes');
  f.store.db.prepare(`INSERT INTO chat_attachments(id,local_id,namespace,storage_name,name,size,mime,kind,source,created_at,c4_watermark,scanned_c4_id,next_check_at)
    VALUES ('other-namespace','same-local','olddash','other-namespace.txt','other-namespace.txt',21,'text/plain','file','user',1,0,0,1)`).run();
  const registration = f.store.db.prepare("SELECT * FROM chat_conversations WHERE local_id='same-local'").get();
  const attachment = f.store.db.prepare("SELECT * FROM chat_attachments WHERE id='other-namespace'").get();
  f.participant.cleanup({ sessionGroup: group });
  assert.deepEqual(f.store.db.prepare("SELECT * FROM chat_conversations WHERE local_id='same-local'").get(), registration);
  assert.deepEqual(f.store.db.prepare("SELECT * FROM chat_attachments WHERE id='other-namespace'").get(), attachment);
  assert.equal(fs.readFileSync(media, 'utf8'), 'other namespace bytes');
});

test('a null-namespace draft uses its bound attachment namespace and refuses an unknown binding', t => {
  const f = fixture(t), draft = f.conversations.create();
  assert.equal(f.store.db.prepare('SELECT namespace FROM chat_conversations WHERE local_id=?').get(draft.localId).namespace, null);
  const foreignMessage = f.message(`olddash:${draft.localId}`, 'delivered', 'retained foreign message');
  const foreign = f.write(path.join(f.zylos, 'components/dashboard/media/foreign-draft.txt'), 'foreign draft bytes');
  const owned = f.write(path.join(f.zylos, 'components/dashboard/media/owned-draft.txt'), 'owned draft bytes');
  const insert = f.store.db.prepare(`INSERT INTO chat_attachments(id,local_id,namespace,storage_name,name,size,mime,kind,source,created_at,c4_watermark,scanned_c4_id,next_check_at)
    VALUES (?, ?, ?, ?, ?, 1,'text/plain','file','user',1,0,0,1)`);
  insert.run('foreign-draft', draft.localId, 'olddash', 'foreign-draft.txt', 'foreign-draft.txt');
  insert.run('owned-draft', draft.localId, 'dashboard', 'owned-draft.txt', 'owned-draft.txt');
  f.store.db.prepare('INSERT INTO chat_attachment_messages(attachment_id,c4_id) VALUES (?,?)').run('foreign-draft', foreignMessage);
  const foreignRow = f.store.db.prepare("SELECT * FROM chat_attachments WHERE id='foreign-draft'").get();
  const foreignLink = f.store.db.prepare("SELECT * FROM chat_attachment_messages WHERE attachment_id='foreign-draft'").get();
  const message = f.c4Db.prepare('SELECT * FROM conversations WHERE id=?').get(foreignMessage);
  const target = f.participant.resolveTarget({ draftLocalId: draft.localId });
  assert.equal(target.namespace, 'dashboard'); assert.equal(target.draft, true);
  assert.equal(f.participant.preview(target).attachments, 0);
  assert.equal(f.participant.cleanup(target).attachments, 0);
  assert.equal(fs.readFileSync(owned, 'utf8'), 'owned draft bytes');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM chat_conversations WHERE local_id=?').get(draft.localId).n, 0);
  assert.deepEqual(f.store.db.prepare("SELECT * FROM chat_attachments WHERE id='foreign-draft'").get(), foreignRow);
  assert.deepEqual(f.store.db.prepare("SELECT * FROM chat_attachment_messages WHERE attachment_id='foreign-draft'").get(), foreignLink);
  assert.deepEqual(f.c4Db.prepare('SELECT * FROM conversations WHERE id=?').get(foreignMessage), message);
  assert.equal(fs.readFileSync(foreign, 'utf8'), 'foreign draft bytes');
  const unknown = f.conversations.create();
  f.c4Db.prepare("DELETE FROM channel_namespaces WHERE component_name='dashboard'").run();
  assert.throws(() => f.participant.resolveTarget({ draftLocalId: unknown.localId }), { code: 'group_delete_core_unavailable' });
  assert.ok(f.conversations.get(unknown.localId));
  assert.equal(fs.readFileSync(foreign, 'utf8'), 'foreign draft bytes');
});

test('runtime cleanup preserves sid-only directories used by a different group mapping', t => {
  const f = fixture(t), group = 'telegram:shared-runtime', sid = 'shared-runtime-session';
  const own = f.transcript(group, sid, 'claude', '{}\n');
  const other = f.write(path.join(f.home, '.claude/projects/origin-project', `${sid}.jsonl`), 'origin transcript bytes\n');
  f.store.insertUsageTranscript({ transcript_path: other, runtime: 'claude', session_group: 'origin', session_id: sid, run_id: 'origin-run' }, new Date().toISOString());
  f.participant.finalizeTranscripts({ sessionGroup: group, processExited: true });
  const sharedEnv = f.write(path.join(f.home, '.claude/session-env', sid, 'state'), 'shared environment bytes');
  const sharedSpill = f.write(path.join(f.tmpdir, 'zylos-shard-spill-123', sid, 'context'), 'shared spill bytes');
  const otherMapping = f.store.getUsageTranscript(other);
  f.participant.cleanup({ sessionGroup: group });
  assert.equal(fs.existsSync(own), false);
  assert.equal(fs.readFileSync(other, 'utf8'), 'origin transcript bytes\n');
  assert.equal(fs.readFileSync(sharedEnv, 'utf8'), 'shared environment bytes');
  assert.equal(fs.readFileSync(sharedSpill, 'utf8'), 'shared spill bytes');
  assert.deepEqual(f.store.getUsageTranscript(other), otherMapping);
});

test('runtime cleanup preserves sid-only directories referenced by a mapping with unknown group ownership', t => {
  const f = fixture(t), group = 'telegram:shared-unknown', sid = 'shared-unknown-session';
  const own = f.transcript(group, sid, 'claude', '{}\n');
  const unknown = f.transcript(null, sid, 'codex', 'unattributed rollout bytes\n');
  f.participant.finalizeTranscripts({ sessionGroup: group, processExited: true });
  const sharedEnv = f.write(path.join(f.home, '.claude/session-env', sid, 'state'), 'unknown owner environment bytes');
  const sharedSpill = f.write(path.join(f.tmpdir, 'zylos-shard-spill-123', sid, 'context'), 'unknown owner spill bytes');
  const mapping = f.store.getUsageTranscript(unknown);
  assert.equal(mapping.session_group, null);
  f.participant.cleanup({ sessionGroup: group });
  assert.equal(fs.existsSync(own), false);
  assert.equal(fs.readFileSync(unknown, 'utf8'), 'unattributed rollout bytes\n');
  assert.equal(fs.readFileSync(sharedEnv, 'utf8'), 'unknown owner environment bytes');
  assert.equal(fs.readFileSync(sharedSpill, 'utf8'), 'unknown owner spill bytes');
  assert.deepEqual(f.store.getUsageTranscript(unknown), mapping);
});

test('a confirmed cutoff preserves later messages and ambiguous group data while removing only proven old links', async t => {
  const f = fixture(t), group = 'dashboard:cutoff-storage'; f.register('cutoff-storage');
  const old = [f.message(group), f.message(group), f.message(group)];
  const other = f.message('olddash:cutoff-storage', 'delivered', 'foreign conversation');
  const raw = f.transcript(group, 'cutoff-session', 'claude', 'not-yet-imported runtime bytes\n');
  f.store.writeGroupDisplayName(group, 'retained conversation name', 'human');
  f.store.insertEvent({ id: 'cutoff-event', ingest_id: 'cutoff-ingest', timestamp: new Date().toISOString(),
    session_group: group, event_type: 'tool_use', category: 'tool', summary: 'retained activity' });
  f.store.db.prepare('INSERT INTO core_log_cursors(stream,file_dev,file_ino,generation,file_name) VALUES (?,1,1,1,?)')
    .run(`events:${group}`, 'retained-log');
  const media = new Map();
  for (const id of ['old-only', 'shared', 'new-only', 'unlinked', 'foreign-linked']) {
    media.set(id, f.write(path.join(f.zylos, 'components/dashboard/media', `${id}.txt`), `${id} bytes`));
    f.store.db.prepare(`INSERT INTO chat_attachments(id,local_id,namespace,storage_name,name,size,mime,kind,source,created_at,c4_watermark,scanned_c4_id,next_check_at)
      VALUES (?,'cutoff-storage','dashboard',?,?,1,'text/plain','file','user',1,0,0,1)`).run(id, `${id}.txt`, `${id}.txt`);
  }
  const link = (id, message) => f.store.db.prepare('INSERT INTO chat_attachment_messages(attachment_id,c4_id) VALUES (?,?)').run(id, message);
  for (const id of ['old-only', 'shared', 'foreign-linked']) link(id, old[0]);
  link('foreign-linked', other);
  const { service, coreStore } = stoppedService(t, f);
  const options = await confirmation(service, group, 'bounded-storage-delete');
  assert.equal(options.cutoffId, old[2]);
  const later = f.message(group, 'delivered', buildAnnotatedContent('later message', [
    { path: media.get('shared'), name: 'shared.txt', kind: 'file', size: 1 },
  ]));
  link('new-only', later);
  const question = id => f.store.db.prepare(`INSERT INTO chat_questions(c4_id,session_group,message_id,interrupt_id,question_summary,constraints)
    VALUES (?,?,?,?,'question','{}')`).run(String(id), group, `message-${id}`, `interrupt-${id}`);
  for (const id of [...old, later]) question(id);
  for (const [index, delivery] of [old[0], later, null].entries()) {
    const answerId = `cutoff-answer-${index}`;
    f.store.db.prepare(`INSERT INTO chat_answers(answer_id,question_c4_id,session_group,endpoint_id,content,action,created_at)
      VALUES (?,?,?,'cutoff-storage','answer','answer',1)`).run(answerId, String(old[index]), group);
    f.store.db.prepare("INSERT INTO chat_answer_deliveries(answer_id,state,c4_id,updated_at) VALUES (?,'delivered',?,1)").run(answerId, delivery);
  }
  const retainedRows = new Map();
  for (const table of ['chat_conversations', 'group_display_names', 'runtime_events', 'core_log_cursors', 'usage_transcripts']) {
    retainedRows.set(table, f.store.db.prepare(`SELECT * FROM ${table}`).all());
  }
  const laterRow = f.c4Db.prepare('SELECT * FROM conversations WHERE id=?').get(later);
  const otherRow = f.c4Db.prepare('SELECT * FROM conversations WHERE id=?').get(other);
  const keptAttachments = new Map(['shared', 'new-only', 'unlinked', 'foreign-linked'].map(id => [id,
    f.store.db.prepare('SELECT * FROM chat_attachments WHERE id=?').get(id)]));
  const keptQuestions = [old[1], old[2], later].map(id => f.store.db.prepare('SELECT * FROM chat_questions WHERE c4_id=?').get(String(id)));
  const keptAnswers = f.store.db.prepare("SELECT * FROM chat_answers WHERE answer_id<>'cutoff-answer-0' ORDER BY answer_id").all();
  const keptDeliveries = f.store.db.prepare("SELECT * FROM chat_answer_deliveries WHERE answer_id<>'cutoff-answer-0' ORDER BY answer_id").all();
  const result = await service.delete(group, options);
  assert.equal(result.pending, false); assert.equal(result.counts.messages, 3);
  assert.equal(result.counts.attachments, 1); assert.equal(result.counts.files, 1);
  assert.equal(fs.existsSync(media.get('old-only')), false);
  for (const [id, row] of keptAttachments) {
    assert.deepEqual(f.store.db.prepare('SELECT * FROM chat_attachments WHERE id=?').get(id), row);
    assert.equal(fs.readFileSync(media.get(id), 'utf8'), `${id} bytes`);
  }
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM chat_attachment_messages WHERE attachment_id='shared' AND c4_id=?").get(later).n, 1);
  assert.deepEqual(f.c4Db.prepare('SELECT * FROM conversations WHERE id=?').get(later), laterRow);
  assert.deepEqual(f.c4Db.prepare('SELECT * FROM conversations WHERE id=?').get(other), otherRow);
  for (const [table, rows] of retainedRows) assert.deepEqual(f.store.db.prepare(`SELECT * FROM ${table}`).all(), rows);
  assert.equal(fs.readFileSync(raw, 'utf8'), 'not-yet-imported runtime bytes\n');
  assert.deepEqual(f.store.db.prepare('SELECT * FROM chat_answers ORDER BY answer_id').all(), keptAnswers);
  assert.deepEqual(f.store.db.prepare('SELECT * FROM chat_answer_deliveries ORDER BY answer_id').all(), keptDeliveries);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM chat_questions WHERE c4_id=?').get(String(old[0])).n, 0);
  for (const question of keptQuestions) assert.deepEqual(f.store.db.prepare('SELECT * FROM chat_questions WHERE c4_id=?').get(question.c4_id), question);
  assert.equal(coreStore.getGroupDeletionAudit(options.operationId).cutoffId, old[2]);
});

test('a busy Dashboard writer before file cleanup keeps a successful retry count exact', async t => {
  const f = fixture(t), draft = f.conversations.create();
  const media = f.write(path.join(f.zylos, 'components/dashboard/media/busy.txt'), 'owned');
  f.store.db.prepare(`INSERT INTO chat_attachments(id,local_id,namespace,storage_name,name,size,mime,kind,source,created_at,c4_watermark,scanned_c4_id,next_check_at)
    VALUES ('busy',?,'dashboard','busy.txt','busy.txt',5,'text/plain','file','user',1,0,0,1)`).run(draft.localId);
  const coreStore = createStore(f.c4Db, { readConfig: () => ({ state: 'ok', config: { session_mode: 'multi' } }) });
  const service = createGroupDeletion({ zylosDir: f.zylos, homeDir: f.home, database: f.c4Db,
    store: coreStore, participant: f.participant });
  t.after(() => service.close());
  const target = { draftLocalId: draft.localId };
  const options = await confirmation(service, target, 'busy-before-files');
  const competitor = new Database(path.join(f.zylos, 'components/dashboard/dashboard.db'));
  t.after(() => { if (competitor.inTransaction) competitor.exec('ROLLBACK'); competitor.close(); });
  f.store.db.pragma('busy_timeout=0');
  competitor.exec('BEGIN IMMEDIATE');
  await assert.rejects(service.delete(target, options), { code: 'DB_BUSY' });
  assert.equal(fs.existsSync(media), true);
  assert.equal(coreStore.getGroupDeletionAudit('busy-before-files').countsEstimated, false);
  assert.equal(f.c4Db.prepare('SELECT cleanup_attempts FROM group_deletion_audit').get().cleanup_attempts, 0);
  competitor.exec('ROLLBACK');
  const result = await service.delete(target, options);
  assert.equal(result.countsEstimated, false);
  assert.equal(result.counts.attachments, 0); assert.equal(result.counts.files, 0);
  assert.equal(fs.existsSync(media), true);
});

test('real storage cleanup interrupted at its first media unlink makes same-operation retry counts estimated', async t => {
  const f = fixture(t), group = 'dashboard:media-interruption'; f.register('media-interruption');
  const old = f.message(group);
  const media = f.write(path.join(f.zylos, 'components/dashboard/media/interrupted.txt'), 'owned');
  f.store.db.prepare(`INSERT INTO chat_attachments(id,local_id,namespace,storage_name,name,size,mime,kind,source,created_at,c4_watermark,scanned_c4_id,next_check_at)
    VALUES ('interrupted','media-interruption','dashboard','interrupted.txt','interrupted.txt',5,'text/plain','file','user',1,0,0,1)`).run();
  f.store.db.prepare('INSERT INTO chat_attachment_messages(attachment_id,c4_id) VALUES (?,?)').run('interrupted', old);
  const { service, coreStore } = stoppedService(t, f);
  const unlink = fs.unlinkSync;
  let interrupted = false;
  // Exercise the real participant and real unlink, then fail at the earliest
  // irreversible boundary. No product module or source is replaced/evaluated.
  const syscall = t.mock.method(fs, 'unlinkSync', file => {
    const result = unlink(file);
    if (file === media && !interrupted) {
      interrupted = true;
      throw Object.assign(new Error('I/O failure after first unlink'), { code: 'EIO' });
    }
    return result;
  });
  const target = { sessionGroup: group };
  const options = await confirmation(service, target, 'first-unlink-interruption');
  try {
    await assert.rejects(service.delete(target, options), cause =>
      cause.code === 'DB_WRITE_FAILED' && cause.cause?.code === 'EIO');
    assert.equal(interrupted, true);
    assert.equal(fs.existsSync(media), false);
    assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM chat_attachments WHERE id='interrupted'").get().n, 1);
    assert.ok(f.conversations.findByGroup(group));
    assert.equal(coreStore.getGroupDeletionAudit(options.operationId).status, 'started');
    assert.equal(f.c4Db.prepare('SELECT cleanup_attempts FROM group_deletion_audit WHERE operation_id=?').get(options.operationId).cleanup_attempts, 1);
  } finally { syscall.mock.restore(); }
  const result = await service.delete(target, options);
  assert.equal(result.pending, false);
  assert.equal(result.operationId, options.operationId);
  assert.equal(result.countsEstimated, true);
  assert.equal(result.counts.files, 0);
  assert.equal(result.counts.attachments, 1);
  assert.equal(coreStore.getGroupDeletionAudit(options.operationId).countsEstimated, true);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM chat_attachments WHERE id='interrupted'").get().n, 0);
  assert.equal(f.c4Db.prepare('SELECT COUNT(*) n FROM group_deletion_audit').get().n, 1);
});

test('a conversation interrupted at its first runtime unlink retains estimated retry counts and final usage', async t => {
  const f = fixture(t), group = 'dashboard:runtime-interruption';
  f.register('runtime-interruption'); const old = f.message(group);
  const text = JSON.stringify({ type: 'assistant', uuid: 'runtime-unlink-usage', requestId: 'runtime-unlink-request',
    sessionId: 'runtime-unlink-session', timestamp: new Date().toISOString(), message: {
      id: 'runtime-unlink-response', role: 'assistant', model: 'claude-sonnet-4',
      usage: { input_tokens: 100, output_tokens: 20 }, content: [{ type: 'text', text: 'private answer' }],
    } }) + '\n';
  const runtime = f.transcript(group, 'runtime-unlink-session', 'claude', text);
  f.participant.finalizeTranscripts({ sessionGroup: group, processExited: true });
  assert.equal(f.store.getUsageTranscript(runtime).status, 'finished');
  assert.equal(f.store.getUsageTranscript(runtime).byte_offset, Buffer.byteLength(text));
  const usageCount = () => f.store.db.prepare("SELECT COUNT(*) n FROM metric_points WHERE session_group=? AND metric_name='usage_event'").get(group).n;
  assert.equal(usageCount(), 1);
  const media = f.write(path.join(f.zylos, 'components/dashboard/media/after-runtime.txt'), 'owned');
  f.store.db.prepare(`INSERT INTO chat_attachments(id,local_id,namespace,storage_name,name,size,mime,kind,source,created_at,c4_watermark,scanned_c4_id,next_check_at)
    VALUES ('after-runtime','runtime-interruption','dashboard','after-runtime.txt','after-runtime.txt',5,'text/plain','file','user',1,0,0,1)`).run();
  f.store.db.prepare('INSERT INTO chat_attachment_messages(attachment_id,c4_id) VALUES (?,?)').run('after-runtime', old);
  const coreStore = createStore(f.c4Db, { readConfig: () => ({ state: 'ok', config: { session_mode: 'multi' } }) });
  let admissions = 0, completedFileStages = 0;
  const service = createGroupDeletion({ zylosDir: f.zylos, homeDir: f.home, database: f.c4Db,
    store: coreStore, participant: f.participant, waitMs: 1000,
    requestStop: async request => {
      admissions++;
      const audit = coreStore.beginGroupDeletion(group, request);
      coreStore.recordRunEnd(group, { runId: audit.operationId, reason: 'delete' });
      return { kind: 'accepted', sent: true };
    },
    onStage(stage) { if (stage === 'files_removed') completedFileStages++; },
  });
  t.after(() => service.close());
  const options = await confirmation(service, group, 'runtime-unlink-interruption');
  const unlink = fs.unlinkSync;
  const removed = [];
  // Fail after the first real runtime removal, before media cleanup can signal
  // anything. Moving the file-phase signal past runtime removal loses this proof.
  const syscall = t.mock.method(fs, 'unlinkSync', file => {
    const result = unlink(file);
    removed.push(file);
    if (file === runtime) throw Object.assign(new Error('I/O failure after runtime unlink'), { code: 'EIO' });
    return result;
  });
  try {
    await assert.rejects(service.delete(group, options), cause =>
      cause.code === 'DB_WRITE_FAILED' && cause.cause?.code === 'EIO');
    assert.equal(removed.length, 1); assert.equal(removed[0], runtime);
    assert.equal(fs.existsSync(runtime), false); assert.equal(fs.existsSync(media), true);
    assert.equal(f.c4Db.prepare('SELECT COUNT(*) n FROM conversations WHERE session_group=?').get(group).n, 1);
    assert.ok(f.conversations.findByGroup(group));
    assert.equal(coreStore.getGroupDeletionAudit(options.operationId).status, 'started');
    assert.equal(f.c4Db.prepare('SELECT cleanup_attempts FROM group_deletion_audit WHERE operation_id=?').get(options.operationId).cleanup_attempts, 1);
    assert.equal(f.store.getUsageTranscript(runtime).status, 'finished');
    assert.equal(usageCount(), 1);
  } finally { syscall.mock.restore(); }
  const result = await service.delete(group, options);
  assert.equal(result.pending, false); assert.equal(result.operationId, options.operationId);
  assert.equal(result.countsEstimated, true);
  assert.equal(result.counts.messages, 1); assert.equal(result.counts.attachments, 1); assert.equal(result.counts.files, 1);
  assert.equal(fs.existsSync(media), false);
  assert.equal(f.c4Db.prepare('SELECT COUNT(*) n FROM conversations WHERE session_group=?').get(group).n, 0);
  assert.equal(f.conversations.findByGroup(group), null);
  assert.equal(coreStore.getGroupDeletionAudit(options.operationId).status, 'done');
  assert.equal(coreStore.getGroupDeletionAudit(options.operationId).countsEstimated, true);
  assert.equal(f.store.getUsageTranscript(runtime).status, 'finished'); assert.equal(usageCount(), 1);
  assert.equal(admissions, 2); assert.equal(completedFileStages, 1);
  const acknowledged = await service.delete(group, options);
  assert.deepEqual(acknowledged, result);
  assert.equal(admissions, 2); assert.equal(completedFileStages, 1); assert.equal(usageCount(), 1);
  assert.equal(f.c4Db.prepare('SELECT COUNT(*) n FROM group_deletion_audit').get().n, 1);
});

test('participant cleanup status survives the Core coordinator transaction and CLI JSON', async t => {
  const f = fixture(t), draft = f.conversations.create();
  const coreStore = createStore(f.c4Db, { readConfig: () => ({ state: 'ok', config: { session_mode: 'multi' } }) });
  let cleanupCalls = 0;
  const service = createGroupDeletion({ zylosDir: f.zylos, homeDir: f.home, database: f.c4Db,
    store: coreStore, participant: { ...f.participant, cleanup() {
      cleanupCalls++;
      throw Object.assign(new Error('Dashboard storage unavailable'), { code: 'group_delete_dashboard_unavailable', status: 503 });
    } } });
  t.after(() => service.close());
  const snapshot = await service.preview({ draftLocalId: draft.localId });
  let output = '', errors = '';
  const exit = await runGroupDeletionCli(['--draft-local-id', draft.localId, '--yes', '--json',
    '--actor', 'owner', '--operation-id', 'participant-http-status', '--cutoff-id', String(snapshot.cutoffId)], {
    create: () => service,
    io: { stdout: { write(text) { output += text; } }, stderr: { write(text) { errors += text; } } },
  });
  assert.equal(exit, 1);
  assert.equal(cleanupCalls, 1);
  assert.equal(errors, '');
  const result = JSON.parse(output);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'group_delete_dashboard_unavailable');
  assert.equal(result.error.status, 503);
  assert.equal(coreStore.getGroupDeletionAudit('participant-http-status').status, 'started');
  assert.equal(f.c4Db.prepare('SELECT cleanup_attempts FROM group_deletion_audit WHERE operation_id=?').get('participant-http-status').cleanup_attempts, 0);
});

test('draft deletion rejects uncertain sends and switches to the real group after Core commit', t => {
  const f = fixture(t), draft = f.conversations.create();
  assert.equal(f.participant.resolveTarget({ draftLocalId: draft.localId }).draft, true);
  f.conversations.markUnknown(draft.localId, 'unacknowledged');
  assert.throws(() => f.participant.resolveTarget({ draftLocalId: draft.localId }), { code: 'group_delete_send_pending' });
  f.message(`dashboard:${draft.localId}`, 'pending');
  const resolved = f.participant.resolveTarget({ draftLocalId: draft.localId });
  assert.equal(resolved.draft, false); assert.equal(resolved.sessionGroup, `dashboard:${draft.localId}`);
});

test('a true unbound draft is removed without creating Core routing state', t => {
  const f = fixture(t), draft = f.conversations.create();
  const result = f.participant.cleanup({ draftLocalId: draft.localId });
  assert.ok(result.records > 0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM chat_conversations').get().n, 0);
  assert.equal(f.c4Db.prepare('SELECT COUNT(*) AS n FROM conversations').get().n, 0);
  assert.equal(f.c4Db.prepare('SELECT COUNT(*) AS n FROM group_heads').get().n, 0);
});

test('a stopped mapped Claude transcript imports fresh usage to EOF before raw deletion and keeps other sessions', t => {
  const f = fixture(t), group = 'dashboard:delete-me'; f.register('delete-me');
  const text = JSON.stringify({ type: 'assistant', uuid: 'usage-one', requestId: 'request-one', sessionId: 'session-one', timestamp: new Date().toISOString(),
    message: { id: 'response-one', role: 'assistant', model: 'claude-sonnet-4', usage: { input_tokens: 100, output_tokens: 20 }, content: [{ type: 'text', text: 'private answer' }] } }) + '\n';
  const file = f.transcript(group, 'session-one', 'claude', text);
  const other = f.transcript('dashboard:keep-me', 'session-other', 'claude', text.replaceAll('session-one', 'session-other'));
  const history = f.write(path.join(f.home, '.claude/history.jsonl'), [JSON.stringify({ sessionId: 'session-one', display: 'remove' }), '{malformed}', JSON.stringify({ sessionId: 'session-other', display: 'keep' })].join('\n') + '\n');
  const env = f.write(path.join(f.home, '.claude/session-env/session-one/state'), 'private');
  const spill = f.write(path.join(f.tmpdir, 'zylos-shard-spill-123/session-one/context.txt'), 'private');
  assert.throws(() => f.participant.finalizeTranscripts({ sessionGroup: group }), { code: 'group_delete_usage_pending' });
  f.participant.finalizeTranscripts({ sessionGroup: group, processExited: true });
  assert.equal(f.store.getUsageTranscript(file).status, 'finished');
  assert.equal(f.store.getUsageTranscript(file).byte_offset, Buffer.byteLength(text));
  const points = f.store.db.prepare('SELECT COUNT(*) AS n FROM metric_points WHERE session_group=?').get(group).n;
  assert.ok(points > 0); assert.ok(fs.existsSync(file));
  f.c4Db.transaction(() => f.participant.cleanup({ sessionGroup: group })).immediate();
  assert.equal(fs.existsSync(file), false); assert.equal(fs.existsSync(env), false); assert.equal(fs.existsSync(spill), false);
  assert.ok(fs.existsSync(other)); assert.equal(f.store.getUsageTranscript(file).status, 'finished');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM metric_points WHERE session_group=?').get(group).n, points);
  assert.equal(fs.readFileSync(history, 'utf8'), [JSON.stringify({ sessionId: 'session-one', display: 'remove' }), '{malformed}', JSON.stringify({ sessionId: 'session-other', display: 'keep' })].join('\n') + '\n');
  // Retry after the raw file is already gone is still a complete operation.
  f.participant.finalizeTranscripts({ sessionGroup: group, processExited: true });
  assert.equal(f.participant.cleanup({ sessionGroup: group }).files, 0);
});

test('incomplete transcript tail remains pending and its raw file is retained', t => {
  const f = fixture(t), group = 'dashboard:incomplete';
  const file = f.transcript(group, 'session-incomplete', 'claude', '{"type":"assistant"');
  assert.throws(() => f.participant.finalizeTranscripts({ sessionGroup: group, processExited: true }), { code: 'group_delete_usage_pending' });
  assert.equal(f.store.getUsageTranscript(file).status, 'active'); assert.ok(fs.existsSync(file));
  assert.throws(() => f.participant.cleanup({ sessionGroup: group }), { code: 'group_delete_usage_pending' });
});

test('pending inbound references preserve their attachment even before the reference scanner linked it', t => {
  const f = fixture(t), group = 'dashboard:attachments'; f.register('attachments');
  const media = path.join(f.zylos, 'components/dashboard/media');
  for (const id of ['old', 'pending', 'other']) {
    f.write(path.join(media, id + '.txt'), id);
    f.store.db.prepare(`INSERT INTO chat_attachments(id,local_id,namespace,storage_name,name,size,mime,kind,source,created_at,c4_watermark,scanned_c4_id,next_check_at)
      VALUES (?,?,'dashboard',?,?,1,'text/plain','file','user',1,0,0,1)`).run(id, id === 'other' ? 'other' : 'attachments', id + '.txt', id + '.txt');
  }
  const old = f.message(group);
  f.store.db.prepare('INSERT INTO chat_attachment_messages(attachment_id,c4_id) VALUES (?,?)').run('old', old);
  const pendingId = f.message(group, 'pending', buildAnnotatedContent('queued', [{ path: path.join(media, 'pending.txt'), name: 'pending.txt', kind: 'file', size: 1 }]));
  const result = f.c4Db.transaction(() => f.participant.cleanup({ sessionGroup: group })).immediate();
  assert.equal(result.attachments, 1);
  assert.equal(fs.existsSync(path.join(media, 'old.txt')), false);
  assert.equal(fs.existsSync(path.join(media, 'pending.txt')), true); assert.equal(fs.existsSync(path.join(media, 'other.txt')), true);
  assert.equal(f.store.db.prepare('SELECT c4_id FROM chat_attachment_messages WHERE attachment_id=?').get('pending').c4_id, pendingId);
});

test('a mapped path outside the runtime owner directory is rejected without removing the file', t => {
  const f = fixture(t), file = f.write(path.join(f.root, 'unrelated.jsonl'), 'private\n');
  f.store.insertUsageTranscript({ transcript_path: file, runtime: 'claude', session_group: 'dashboard:bad', session_id: 'unrelated' }, new Date().toISOString());
  assert.throws(() => f.participant.finalizeTranscripts({ sessionGroup: 'dashboard:bad', processExited: true }), { code: 'group_delete_path_unavailable' });
  assert.ok(fs.existsSync(file));
});

test('a recreated Dashboard group is registered for normal sending while foreign and deleting groups are refused', async t => {
  const f = fixture(t), group = 'dashboard:reborn'; f.message(group, 'pending');
  assert.ok(SKILLS_DIR.startsWith(process.env.ZYLOS_DIR + path.sep));
  fs.mkdirSync(path.join(SKILLS_DIR, 'dashboard'), { recursive: true });
  const coreStore = createStore(f.c4Db, { validateComponent: () => true, readConfig: () => ({ state: 'ok', config: { session_mode: 'multi', runtime: 'claude' } }) });
  const sender = new ChatSender({ conversations: f.conversations, c4Reader: { _open: () => f.c4Db }, zylosDir: f.zylos });
  assert.equal((await sender.resolve(groupId(group))).state, 'active');
  assert.equal(f.conversations.findByGroup(group), null, 'Resolving is read-only');
  sender.loadCore = async () => ({ getChannelNamespace: coreStore.getChannelNamespace,
    ensureChannelNamespace: coreStore.ensureChannelNamespace, isDataError,
    receive: args => receive(args, { db: coreStore, queryRoute: async () => ({ decision: 'pending', runtime: 'claude' }),
      appendEntryEvent: async () => true, reserveStatusNotice: () => ({ suppressed: true }), diagnostic() {} }) });
  const reply = await sender.send(groupId(group), { content: 'reply after recreation' });
  assert.equal(reply.stored, true, JSON.stringify(reply)); assert.equal(reply.draft, false);
  assert.equal(f.conversations.findByGroup(group).firstContent, null);
  assert.equal(f.c4Db.prepare('SELECT content FROM conversations WHERE id=?').get(reply.messageId).content, 'reply after recreation');

  f.c4Db.prepare("INSERT INTO channel_namespaces(namespace,component_name) VALUES ('telegram','telegram')").run();
  f.message('telegram:foreign', 'pending');
  await assert.rejects(sender.resolve(groupId('telegram:foreign')), { code: 'chat_conversation_forbidden' });
  f.message('dashboard:locked', 'pending');
  coreStore.beginGroupDeletion('dashboard:locked', { ...boundary(coreStore, 'dashboard:locked'), operationId: 'delete-one', actor: 'owner', preview: {} });
  await assert.rejects(sender.resolve(groupId('dashboard:locked')), { code: 'chat_conversation_deleting' });
  await assert.rejects(sender.resolve(groupId('dashboard:never-existed')), { code: 'chat_conversation_not_found' });
});

test('an opened old event source cannot reinsert events or cursors after deletion during asynchronous redaction', async t => {
  const f = fixture(t), group = 'dashboard:old-source';
  const file = f.write(path.join(f.zylos, 'activity-monitor/session-groups', group, 'events.jsonl'), JSON.stringify({ v: 1, ts: Date.now(), event: 'stop', session_group: group, run_id: 'old-run' }) + '\n');
  let entered, resume;
  const waiting = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { resume = resolve; });
  const importer = new CoreLogImporter({ store: f.store, zylosDir: f.zylos, redactor: { async redactValue(value) { entered(); await gate; return { value, failed: false }; } } });
  t.after(() => importer.stop());
  const pending = importer.importStream({ stream: `events:${group}`, file });
  await waiting;
  f.c4Db.transaction(() => f.participant.cleanup({ sessionGroup: group, removeGroupSources() { fs.rmSync(path.dirname(file), { recursive: true }); return 1; } })).immediate();
  resume(); await pending;
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM runtime_events WHERE session_group=?').get(group).n, 0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM core_log_cursors WHERE stream=?').get(`events:${group}`).n, 0);
});

test('fresh Codex usage is imported through EOF and only exact rollout cursors are removed', t => {
  const f = fixture(t), group = 'dashboard:codex-delete';
  const text = [
    { type: 'session_meta', timestamp: new Date().toISOString(), payload: { id: 'codex-session' } },
    { type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'token_count', info: {
      model: 'gpt-5.3-codex', last_token_usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 20 } } } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n';
  const file = f.transcript(group, 'codex-session', 'codex', text);
  const other = f.transcript('dashboard:other-codex', 'codex-other', 'codex', text);
  f.store.upsertCodexRolloutPath({ sessionId: 'codex-session', transcriptPath: file, lastEventAt: new Date().toISOString() });
  f.store.upsertCodexRolloutCursor({ transcriptPath: other, byteOffset: 0, sessionId: 'codex-other' });
  f.participant.finalizeTranscripts({ sessionGroup: group, processExited: true });
  assert.equal(f.store.getUsageTranscript(file).byte_offset, Buffer.byteLength(text));
  const points = f.store.db.prepare('SELECT COUNT(*) AS n FROM metric_points WHERE session_group=?').get(group).n; assert.ok(points > 0);
  f.participant.cleanup({ sessionGroup: group });
  assert.equal(fs.existsSync(file), false); assert.ok(fs.existsSync(other));
  assert.equal(f.store.getCodexRolloutCursor(file) == null, true);
  assert.ok(f.store.getCodexRolloutCursor(other));
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM codex_rollout_paths WHERE transcript_path=?').get(file).n, 0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM metric_points WHERE session_group=?').get(group).n, points);
  assert.equal(f.store.getUsageTranscript(file).status, 'finished');
});

test('transcript budget expiry preserves raw files and committed batch progress for retry', t => {
  const f = fixture(t), group = 'dashboard:budgeted-import';
  f.write(path.join(f.zylos, 'components/dashboard/config.json'), JSON.stringify({ codexRolloutMaxLinesPerCollect: 2 }));
  const text = [
    { type: 'session_meta', timestamp: new Date().toISOString(), payload: { id: 'budgeted-session' } },
    ...Array.from({ length: 3 }, (_, index) => ({ type: 'event_msg', timestamp: new Date().toISOString(),
      payload: { type: 'token_count', info: { model: 'gpt-5.3-codex',
        last_token_usage: { input_tokens: 100 + index, cached_input_tokens: 0, output_tokens: 20 } } } })),
  ].map(row => JSON.stringify(row)).join('\n') + '\n';
  const file = f.transcript(group, 'budgeted-session', 'codex', text);
  const target = { sessionGroup: group, processExited: true, deadlineAt: 20000 };
  assert.throws(() => f.participant.finalizeTranscripts({ ...target, now: () => 20000 }), { code: 'group_delete_usage_pending' });
  assert.equal(f.store.getCodexRolloutCursor(file) == null, true);
  assert.equal(fs.readFileSync(file, 'utf8'), text);
  assert.throws(() => f.participant.finalizeTranscripts({ ...target,
    now: () => (f.store.getCodexRolloutCursor(file)?.byte_offset ?? 0) > 0 ? 20000 : 0,
  }), { code: 'group_delete_usage_pending' });
  const cursor = f.store.getCodexRolloutCursor(file).byte_offset;
  assert.ok(cursor > 0 && cursor < Buffer.byteLength(text));
  assert.equal(f.store.getUsageTranscript(file).status, 'active');
  assert.equal(fs.readFileSync(file, 'utf8'), text);
  const usageCount = () => f.store.db.prepare("SELECT COUNT(*) n FROM metric_points WHERE session_group=? AND metric_name='usage_event'").get(group).n;
  assert.equal(usageCount(), 1);
  f.participant.finalizeTranscripts({ ...target, now: () => 0 });
  assert.equal(f.store.getUsageTranscript(file).status, 'finished');
  assert.equal(f.store.getUsageTranscript(file).byte_offset, Buffer.byteLength(text));
  assert.equal(f.store.getCodexRolloutCursor(file).byte_offset, Buffer.byteLength(text));
  assert.equal(usageCount(), 3);
  assert.equal(fs.readFileSync(file, 'utf8'), text);
  f.participant.cleanup({ sessionGroup: group });
  assert.equal(fs.existsSync(file), false);
  assert.equal(usageCount(), 3);
});

function twoClaudeMappings(f, group) {
  const text = sid => JSON.stringify({ type: 'assistant', uuid: `${sid}-usage`, requestId: `${sid}-request`, sessionId: sid,
    timestamp: new Date().toISOString(), message: { id: `${sid}-response`, role: 'assistant', model: 'claude-sonnet-4',
      usage: { input_tokens: 100, output_tokens: 20 }, content: [{ type: 'text', text: 'private answer' }] } }) + '\n';
  // Mappings import in transcript path order: the first session is imported first.
  const files = ['budget-first', 'budget-second'].map(sid => { const content = text(sid); return { text: content, file: f.transcript(group, sid, 'claude', content) }; });
  const usageCount = () => f.store.db.prepare("SELECT COUNT(*) n FROM metric_points WHERE session_group=? AND metric_name='usage_event'").get(group).n;
  return { files, usageCount };
}

test('an import whose budget expired before it started reads no transcript and removes nothing', t => {
  const f = fixture(t), group = 'dashboard:budget-expired-before-import';
  const { files, usageCount } = twoClaudeMappings(f, group);
  assert.throws(() => f.participant.finalizeTranscripts({ sessionGroup: group, processExited: true, deadlineAt: 20000, now: () => 20000 }),
    { code: 'group_delete_usage_pending' });
  assert.equal(usageCount(), 0);
  for (const { file, text } of files) {
    assert.equal(f.store.getUsageTranscript(file).status, 'active');
    assert.equal(f.store.getUsageTranscript(file).byte_offset, 0);
    assert.equal(fs.readFileSync(file, 'utf8'), text);
  }
});

test('an import whose budget expires after one transcript finishes leaves the next transcript for retry', t => {
  const f = fixture(t), group = 'dashboard:budget-expires-between-imports';
  const { files: [first, second], usageCount } = twoClaudeMappings(f, group);
  const now = () => f.store.getUsageTranscript(first.file).status === 'finished' ? 20000 : 0;
  assert.throws(() => f.participant.finalizeTranscripts({ sessionGroup: group, processExited: true, deadlineAt: 20000, now }),
    { code: 'group_delete_usage_pending' });
  assert.equal(f.store.getUsageTranscript(first.file).status, 'finished');
  assert.equal(f.store.getUsageTranscript(first.file).byte_offset, Buffer.byteLength(first.text));
  assert.equal(f.store.getUsageTranscript(second.file).status, 'active');
  for (const { file, text } of [first, second]) assert.equal(fs.readFileSync(file, 'utf8'), text);
  f.participant.finalizeTranscripts({ sessionGroup: group, processExited: true, deadlineAt: 20000, now: () => 0 });
  assert.equal(f.store.getUsageTranscript(second.file).status, 'finished');
  assert.equal(usageCount(), 2);
});

test('question and answer child records are removed together while pending inputs and other groups remain', t => {
  const f = fixture(t), group = 'dashboard:questions';
  const old = f.message(group), pending = f.message(group, 'pending'), other = f.message('dashboard:other', 'pending');
  const question = (id, target) => f.store.db.prepare(`INSERT INTO chat_questions(c4_id,session_group,message_id,interrupt_id,question_summary,constraints)
    VALUES (?,?,?,?,?,'{}')`).run(String(id), target, `message-${id}`, `interrupt-${id}`, 'private question');
  question(old, group); question(pending, group); question(other, 'dashboard:other');
  f.store.db.prepare(`INSERT INTO chat_answers(answer_id,question_c4_id,session_group,endpoint_id,content,action,created_at)
    VALUES ('old-answer',?,?,'questions','private answer','answer',1)`).run(String(old), group);
  f.store.db.prepare("INSERT INTO chat_answer_deliveries(answer_id,state,c4_id,updated_at) VALUES ('old-answer','delivered',?,1)").run(old);
  f.store.db.prepare(`INSERT INTO chat_question_controls(question_c4_id,operation,control_message_id,created_at) VALUES (?,'cancel','control-old',1)`).run(String(old));
  f.participant.cleanup({ sessionGroup: group });
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM chat_answers').get().n, 0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM chat_answer_deliveries').get().n, 0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM chat_question_controls').get().n, 0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM chat_questions WHERE c4_id=?').get(String(old)).n, 0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM chat_questions').get().n, 2);
});

test('an interrupted lightweight deletion can resume using its existing audit after the registration is gone', t => {
  const f = fixture(t), draft = f.conversations.create();
  const c4 = createStore(f.c4Db);
  const targetKey = JSON.stringify(['draft', 'dashboard', draft.localId]);
  c4.beginDraftDeletion(draft.localId, { ...c4.getDeletionPreviewBoundary(targetKey), targetKey, operationId: 'draft-delete', actor: 'owner', preview: {} });
  f.participant.cleanup({ draftLocalId: draft.localId });
  const resumed = f.participant.resolveTarget({ draftLocalId: draft.localId });
  assert.equal(resumed.draft, true); assert.equal(resumed.sessionGroup, null);
  assert.equal(f.participant.cleanup(resumed).records, 0);
  assert.throws(() => f.participant.resolveTarget({ draftLocalId: 'never-existed' }), { code: 'chat_conversation_not_found' });
});

test('an absent Dashboard database is optional but an existing invalid database fails closed', t => {
  const f = fixture(t), zylos = path.join(f.root, 'without-dashboard'); fs.mkdirSync(zylos);
  const absent = createGroupDeletionStorage({ zylosDir: zylos, homeDir: f.home, tmpdir: f.tmpdir, c4Db: f.c4Db });
  assert.equal(absent.preview({ sessionGroup: 'telegram:external' }).attachments, 0);
  assert.equal(absent.cleanup({ sessionGroup: 'telegram:external' }).records, 0); absent.close();
  f.write(path.join(zylos, 'components/dashboard/dashboard.db'), 'not a database');
  assert.throws(() => createGroupDeletionStorage({ zylosDir: zylos, homeDir: f.home, tmpdir: f.tmpdir, c4Db: f.c4Db }));
});


test('an attachment can be the first reply action of a recreated Dashboard group', async t => {
  const f = fixture(t), group = 'dashboard:attachment-first';
  f.message(group, 'pending');
  const owner = new ChatAttachments({ store: f.store, c4Reader: { _open: () => f.c4Db }, zylosDir: f.zylos });
  t.after(() => owner.close());
  const file = f.write(path.join(f.zylos, 'workspace/reply.txt'), 'new attachment');
  const reply = await owner.register('attachment-first', { kind: 'file', path: file });
  assert.equal(reply.ok, true);
  assert.equal(f.conversations.findByGroup(group).state, 'active');
  assert.equal(fs.readFileSync(owner.resolve('attachment-first', reply.attachmentId), 'utf8'), 'new attachment');
  assert.equal(f.c4Db.prepare('SELECT COUNT(*) AS n FROM conversations').get().n, 1);
  await assert.rejects(owner.register('never-existed', { kind: 'file', path: file }), { code: 'chat_conversation_not_found' });
  const coreStore = createStore(f.c4Db);
  f.message('dashboard:locked-attachment', 'pending');
  coreStore.beginGroupDeletion('dashboard:locked-attachment', { ...boundary(coreStore, 'dashboard:locked-attachment'), operationId: 'locked-attachment-delete', actor: 'owner', preview: {} });
  await assert.rejects(owner.register('locked-attachment', { kind: 'file', path: file }), { code: 'chat_conversation_deleting' });
  assert.equal(f.conversations.findByGroup('dashboard:locked-attachment'), null);
});

test('final usage includes every direct mapped-session subagent transcript before directory deletion', t => {
  const f = fixture(t), group = 'dashboard:child-usage';
  const main = f.transcript(group, 'parent-session');
  const child = f.write(path.join(path.dirname(main), 'parent-session/subagents/worker-special.jsonl'), JSON.stringify({
    type: 'assistant', uuid: 'child-usage', requestId: 'child-request', sessionId: 'parent-session', timestamp: new Date().toISOString(),
    message: { id: 'child-response', role: 'assistant', model: 'claude-sonnet-4', usage: { input_tokens: 500, output_tokens: 50 }, content: [] },
  }) + '\n');
  f.participant.finalizeTranscripts({ sessionGroup: group, processExited: true });
  assert.equal(f.store.getUsageTranscript(child).status, 'finished');
  assert.equal(f.store.getUsageTranscript(child).byte_offset, fs.statSync(child).size);
  const cost = f.store.aggregateCost({ sessionId: 'parent-session' });
  assert.ok(cost > 0);
  f.participant.cleanup({ sessionGroup: group });
  assert.equal(fs.existsSync(child), false);
  assert.equal(f.store.aggregateCost({ sessionId: 'parent-session' }), cost);
});

test('a collector returning after deletion cannot downgrade the final EOF mapping', async t => {
  const f = fixture(t), group = 'dashboard:inventory-race';
  const file = f.transcript(group, 'inventory-session');
  const inventory = new UsageTranscripts(f.store, { homeDir: f.home, zylosDir: f.zylos },
    { getSnapshot: async () => ({ listKnown: true, rows: [] }) });
  let entered, resume;
  const waiting = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { resume = resolve; });
  const collecting = inventory.collect('claude', async () => { entered(); await gate; return { byteOffset: 0, written: 0 }; });
  await waiting;
  f.participant.finalizeTranscripts({ sessionGroup: group, processExited: true });
  f.participant.cleanup({ sessionGroup: group });
  assert.equal(fs.existsSync(file), false);
  resume(); await collecting;
  assert.equal(f.store.getUsageTranscript(file).status, 'finished');
  assert.equal(f.store.getUsageTranscript(file).byte_offset, 0);
});


test('a collector cannot apply an old cursor to a replaced transcript name', async t => {
  const f = fixture(t), group = 'dashboard:replace-source';
  const file = f.transcript(group, 'replace-session', 'claude', 'old\n');
  const inventory = new UsageTranscripts(f.store, { homeDir: f.home, zylosDir: f.zylos },
    { getSnapshot: async () => ({ listKnown: true, rows: [] }) });
  let entered, resume;
  const waiting = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { resume = resolve; });
  const collecting = inventory.collect('claude', async () => { entered(); await gate; return { byteOffset: 4, written: 0 }; });
  await waiting;
  fs.renameSync(file, file + '.old');
  fs.writeFileSync(file, 'new, unread content\n');
  resume(); await collecting;
  assert.equal(f.store.getUsageTranscript(file).status, 'active');
  assert.equal(f.store.getUsageTranscript(file).byte_offset, 0);
});


test('a paused upload cannot publish after deletion completes and the same group is recreated', async t => {
  const f = fixture(t), group = 'dashboard:upload-race'; f.register('upload-race'); f.message(group);
  const owner = new ChatAttachments({ store: f.store, c4Reader: { _open: () => f.c4Db }, zylosDir: f.zylos });
  t.after(() => owner.close());
  let entered, resume;
  const waiting = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { resume = resolve; });
  async function* stream() { yield Buffer.from('old private bytes'); entered(); await gate; yield Buffer.from('old tail'); }
  const uploading = owner.prepareUser('upload-race', { name: 'old.txt', mime: 'text/plain', stream: stream(), principal: 'owner' });
  await waiting;
  const c4 = createStore(f.c4Db);
  c4.beginGroupDeletion(group, { ...boundary(c4, group), operationId: 'upload-delete', actor: 'owner', preview: {} });
  f.c4Db.transaction(() => f.participant.cleanup({ sessionGroup: group })).immediate();
  c4.finalizeGroupDeletion(group, { operationId: 'upload-delete' });
  f.message(group, 'pending');
  f.conversations.registerExistingGroup(group, { _open: () => f.c4Db });
  resume(); await assert.rejects(uploading, { code: 'chat_conversation_deleted' });
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM chat_attachments').get().n, 0);
  assert.equal(fs.readdirSync(owner.mediaDir).length, 0);
  assert.equal(f.conversations.findByGroup(group).state, 'active');
});

test('preview counts removable runtime files once and excludes attachments without message proof', t => {
  const f = fixture(t), group = 'dashboard:file-count'; f.register('file-count');
  const main = f.transcript(group, 'file-count-session');
  f.write(path.join(path.dirname(main), 'file-count-session/subagents/worker.jsonl'), '');
  f.write(path.join(f.home, '.claude/session-env/file-count-session/env'), 'private');
  f.write(path.join(f.tmpdir, 'claude-123/project/file-count-session/state'), 'private');
  f.write(path.join(f.tmpdir, 'zylos-shard-spill-123/file-count-session/context'), 'private');
  f.write(path.join(f.home, '.claude/history.jsonl'), JSON.stringify({ sessionId: 'file-count-session' }) + '\n');
  const media = path.join(f.zylos, 'components/dashboard/media');
  for (const id of ['remove', 'keep']) {
    f.write(path.join(media, id + '.txt'), id);
    f.store.db.prepare(`INSERT INTO chat_attachments(id,local_id,namespace,storage_name,name,size,mime,kind,source,created_at,c4_watermark,scanned_c4_id,next_check_at)
      VALUES (?,'file-count','dashboard',?,?,1,'text/plain','file','user',1,0,0,1)`).run(id, id + '.txt', id + '.txt');
  }
  const old = f.message(group);
  f.store.db.prepare('INSERT INTO chat_attachment_messages(attachment_id,c4_id) VALUES (?,?)').run('remove', old);
  f.participant.finalizeTranscripts({ sessionGroup: group, processExited: true });
  const preview = f.participant.preview({ sessionGroup: group });
  assert.equal(preview.attachments, 1);
  assert.equal(preview.files, 6);
  const actual = f.c4Db.transaction(() => f.participant.cleanup({ sessionGroup: group })).immediate();
  assert.equal(actual.attachments, preview.attachments);
  assert.equal(actual.files, preview.files);
  assert.equal(f.participant.preview({ sessionGroup: group }).files, 0);
  assert.equal(fs.readFileSync(path.join(media, 'keep.txt'), 'utf8'), 'keep');
});

test('a newly queued attachment is preserved and never counted as deleted from an earlier preview', async t => {
  const f = fixture(t), group = 'dashboard:late-input'; f.register('late-input'); f.message(group);
  const attachments = new ChatAttachments({ store: f.store, c4Reader: { _open: () => f.c4Db }, zylosDir: f.zylos });
  t.after(() => attachments.close());
  const upload = await attachments.prepareUser('late-input', { name: 'pending.txt', mime: 'text/plain',
    principal: 'owner', stream: Readable.from(['retained bytes']) });
  const media = attachments.resolve('late-input', upload.id);
  const before = f.message(group, 'delivered', buildAnnotatedContent('old delivered reference', [
    { path: media, name: 'pending.txt', kind: 'file', size: 14 },
  ]));
  attachments.linkRow(f.c4Db.prepare('SELECT * FROM conversations WHERE id=?').get(before));
  const coreStore = createStore(f.c4Db, { readConfig: () => ({ state: 'ok', config: { session_mode: 'multi' } }) });
  let queued;
  const service = createGroupDeletion({ zylosDir: f.zylos, homeDir: f.home, database: f.c4Db,
    store: coreStore, participant: f.participant, waitMs: 1000,
    requestStop: async request => {
      const audit = coreStore.beginGroupDeletion(group, request);
      coreStore.recordRunEnd(group, { runId: audit.operationId, reason: 'delete' });
      return { kind: 'accepted', sent: true };
    },
    onStage(stage) {
      if (stage === 'usage_imported') queued = f.message(group, 'pending', buildAnnotatedContent('late queued input', [
        { path: media, name: 'pending.txt', kind: 'file', size: 14 },
      ]));
    },
  });
  t.after(() => service.close());
  assert.equal((await service.preview(group)).attachments, 1);
  const options = await confirmation(service, group, 'late-input-deletion');
  const result = await service.delete(group, options);
  assert.equal(result.pending, false);
  assert.equal(result.counts.attachments, 0);
  assert.equal(result.counts.files, 0);
  assert.equal(result.countsEstimated, false);
  assert.equal(coreStore.getGroupDeletionAudit(result.operationId).preview.attachments, 1);
  assert.equal(f.c4Db.prepare('SELECT status FROM conversations WHERE id=?').get(queued).status, 'pending');
  assert.equal(fs.existsSync(media), true);
});


test('native cleanup removes display names, runtime events and import cursors only for its group', t => {
  const f = fixture(t), group = 'dashboard:owned-events', other = 'dashboard:retained-events';
  for (const [index, target] of [group, other].entries()) {
    f.store.writeGroupDisplayName(target, 'private name', 'human');
    f.store.insertEvent({ id: `event-${index}`, ingest_id: `ingest-${index}`, timestamp: new Date().toISOString(),
      session_group: target, event_type: 'tool_use', category: 'tool', summary: 'private activity' });
    f.store.db.prepare('INSERT INTO core_log_cursors(stream,file_dev,file_ino,generation,file_name) VALUES (?,1,?,1,?)')
      .run(`events:${target}`, index + 1, `private-${index}`);
  }
  f.participant.cleanup({ sessionGroup: group });
  for (const table of ['group_display_names', 'runtime_events']) {
    assert.equal(f.store.db.prepare(`SELECT count(*) n FROM ${table} WHERE session_group=?`).get(group).n, 0);
    assert.equal(f.store.db.prepare(`SELECT count(*) n FROM ${table} WHERE session_group=?`).get(other).n, 1);
  }
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM core_log_cursors WHERE stream=?').get(`events:${group}`).n, 0);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM core_log_cursors WHERE stream=?').get(`events:${other}`).n, 1);
});

test('a draft becoming unknown after target resolution cannot be cleaned', t => {
  const f = fixture(t), draft = f.conversations.create();
  const resolved = f.participant.resolveTarget({ draftLocalId: draft.localId });
  f.conversations.markUnknown(draft.localId, 'interrupted send');
  assert.throws(() => f.participant.cleanup(resolved), { code: 'group_delete_send_pending' });
  assert.ok(f.conversations.get(draft.localId));
});

test('a symbolic-link component inside a mapped runtime path is refused', t => {
  const f = fixture(t), group = 'dashboard:aliased-transcript';
  const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside);
  const target = f.write(path.join(outside, 'aliased-session.jsonl'), 'retained');
  const projects = path.join(f.home, '.claude/projects'); fs.mkdirSync(projects, { recursive: true });
  fs.symlinkSync(outside, path.join(projects, 'alias'));
  f.store.insertUsageTranscript({ transcript_path: path.join(projects, 'alias/aliased-session.jsonl'), runtime: 'claude',
    session_group: group, session_id: 'aliased-session' }, new Date().toISOString());
  assert.throws(() => f.participant.preview({ sessionGroup: group }), { code: 'group_delete_path_unavailable' });
  assert.equal(fs.readFileSync(target, 'utf8'), 'retained');
});

test('recreated groups are registered only by authorized send or attachment writes', async t => {
  const f = fixture(t), group = 'dashboard:authorization-first'; f.message(group, 'pending');
  const reader = { _open: () => f.c4Db };
  const sender = new ChatSender({ conversations: f.conversations, c4Reader: reader, zylosDir: f.zylos });
  const config = { chat: { allowRemote: false } };
  const auth = { enabled: true, resolveAuthContext(req) {
    req._authContext = req.headers.cookie ? { kind: 'cookie', scope: 'admin', principalId: 'owner' } : null;
    return req._authContext;
  } };
  const id = groupId(group), route = `/api/chat/conversations/${encodeURIComponent(id)}`;
  const invoke = async (handler, pathname, method, headers = {}, body = {}) => {
    const req = Readable.from(method === 'GET' ? [] : [Buffer.from(JSON.stringify(body))]);
    Object.assign(req, { method, headers });
    const res = { writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
    assert.equal(await handler(req, res, new URL(pathname, 'http://fixture'), {
      auth, config, conversations: f.conversations, sender, attachments: { config: () => ({ maxUploadBytes: 1 }) }, readMode: () => 'multi',
    }), true);
    return res;
  };
  assert.equal((await invoke(handleChatConversations, route, 'GET')).status, 403);
  assert.equal((await invoke(handleChatConversations, route, 'GET', { cookie: 'owner' })).status, 200);
  assert.equal((await invoke(handleChatConversations, route, 'PATCH', { cookie: 'owner' }, { displayName: 'new name' })).status, 403);
  assert.equal((await invoke(handleChatConversations, route, 'PATCH', { cookie: 'owner', 'sec-fetch-site': 'same-origin' }, { displayName: 'new name' })).status, 404);
  assert.equal((await invoke(handleChatAttachments, route + '/uploads/config', 'GET')).status, 403);
  assert.equal((await invoke(handleChatAttachments, route + '/uploads/config', 'GET', { cookie: 'owner', 'sec-fetch-site': 'same-origin' })).status, 200);
  assert.equal(f.conversations.findByGroup(group), null);
  sender.loadCore = async () => ({ ensureChannelNamespace: () => ({ componentName: 'dashboard', namespace: 'dashboard' }) });
  await assert.rejects(sender.send(id, { content: 'denied send' }, { authorize: () => ({ error: 'same_origin_required', status: 403 }) }), { code: 'same_origin_required' });
  assert.equal(f.conversations.findByGroup(group), null);
  await sender.prepareAttachmentConversation(await sender.resolve(id), { authorize: () => ({ error: 'same_origin_required', status: 403 }) })
    .then(() => assert.fail('Denied attachment preparation must fail'), error => assert.equal(error.code, 'same_origin_required'));
  assert.equal(f.conversations.findByGroup(group), null);
  sender.loadCore = async () => ({ ensureChannelNamespace: () => ({ componentName: 'dashboard', namespace: 'dashboard' }) });
  const authorized = await sender.prepareAttachmentConversation(await sender.resolve(id), { authorize: () => null });
  assert.equal(authorized.state, 'active'); assert.equal(f.conversations.findByGroup(group).state, 'active');
});
