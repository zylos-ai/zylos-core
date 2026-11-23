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

import { ChatSender } from '../src/lib/chat/send.js';

import { receive } from '../../comm-bridge/scripts/c4-receive.js';
import { SKILLS_DIR } from '../../comm-bridge/scripts/c4-config.js';
import { isDataError } from '../../comm-bridge/scripts/c4-session-group.js';
import { buildAnnotatedContent } from '../../comm-bridge/scripts/attachment-annotations.js';
import { createGroupDeletion } from '../../../cli/lib/group-delete.js';

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

test('deleting a Claude task output link never removes its unmapped external target', async t => {
  const f = fixture(t), group = 'dashboard:external-output', sid = 'parent-with-external-output';
  f.register('external-output'); f.message(group); f.transcript(group, sid);
  const outside = f.write(path.join(f.home, '.claude/projects/other-project/foreign-session.jsonl'), 'external transcript bytes\n');
  const temporary = path.join(f.tmpdir, 'claude-123/project', sid);
  const link = path.join(temporary, 'tasks/external.output');
  fs.mkdirSync(path.dirname(link), { recursive: true }); fs.symlinkSync(outside, link);
  const { service } = stoppedService(t, f);
  let preview;
  await assert.doesNotReject(async () => { preview = await service.preview(group); });
  assert.equal(preview.files, 2, 'The target is not included through the link');
  const result = await service.delete(group, await confirmation(service, group, 'delete-external-output'));
  assert.equal(result.pending, false); assert.equal(result.counts.files, 2);
  assert.throws(() => fs.lstatSync(link), { code: 'ENOENT' });
  assert.equal(fs.existsSync(temporary), false);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'external transcript bytes\n');
});

// Files/private SQLite only, under the existing isolated fixture. The access
// fault exercises the real participant and shared preflight before its first
// unlink; no product source or module is replaced or re-evaluated.
