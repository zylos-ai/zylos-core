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
import { CoreLogImporter } from '../src/lib/core-log-importer.js';
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
  f.message(group);
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
  assert.equal(f.conversations.findByGroup(group).firstContent, null);
  sender.loadCore = async () => ({ getChannelNamespace: coreStore.getChannelNamespace,
    ensureChannelNamespace: coreStore.ensureChannelNamespace, isDataError,
    receive: args => receive(args, { db: coreStore, queryRoute: async () => ({ decision: 'pending', runtime: 'claude' }),
      appendEntryEvent: async () => true, reserveStatusNotice: () => ({ suppressed: true }), diagnostic() {} }) });
  const reply = await sender.send(groupId(group), { content: 'reply after recreation' });
  assert.equal(reply.stored, true, JSON.stringify(reply)); assert.equal(reply.draft, false);
  assert.equal(f.c4Db.prepare('SELECT content FROM conversations WHERE id=?').get(reply.messageId).content, 'reply after recreation');

  f.c4Db.prepare("INSERT INTO channel_namespaces(namespace,component_name) VALUES ('telegram','telegram')").run();
  f.message('telegram:foreign', 'pending');
  await assert.rejects(sender.resolve(groupId('telegram:foreign')), { code: 'chat_conversation_forbidden' });
  f.message('dashboard:locked', 'pending');
  coreStore.beginGroupDeletion('dashboard:locked', { operationId: 'delete-one', actor: 'owner', preview: {} });
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
  c4.beginDraftDeletion(draft.localId, { operationId: 'draft-delete', actor: 'owner', preview: {} });
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
  coreStore.beginGroupDeletion('dashboard:locked-attachment', { operationId: 'locked-attachment-delete', actor: 'owner', preview: {} });
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
  c4.beginGroupDeletion(group, { operationId: 'upload-delete', actor: 'owner', preview: {} });
  f.c4Db.transaction(() => f.participant.cleanup({ sessionGroup: group })).immediate();
  c4.finalizeGroupDeletion(group, { operationId: 'upload-delete' });
  f.message(group, 'pending');
  f.conversations.registerExistingGroup(group, { _open: () => f.c4Db });
  resume(); await assert.rejects(uploading, { code: 'chat_conversation_deleted' });
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM chat_attachments').get().n, 0);
  assert.equal(fs.readdirSync(owner.mediaDir).length, 0);
  assert.equal(f.conversations.findByGroup(group).state, 'active');
});

test('preview counts exact owned files once and excludes attachments kept for pending input', t => {
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
  f.message(group, 'pending', buildAnnotatedContent('queued', [{ path: path.join(media, 'keep.txt'), name: 'keep.txt', kind: 'file', size: 1 }]));
  f.participant.finalizeTranscripts({ sessionGroup: group, processExited: true });
  const preview = f.participant.preview({ sessionGroup: group });
  assert.equal(preview.attachments, 1);
  assert.equal(preview.files, 6);
  const actual = f.c4Db.transaction(() => f.participant.cleanup({ sessionGroup: group })).immediate();
  assert.equal(actual.attachments, preview.attachments);
  assert.equal(actual.files, preview.files);
  assert.equal(f.participant.preview({ sessionGroup: group }).files, 0);
});

test('a newly queued attachment is preserved and never counted as deleted from an earlier preview', async t => {
  const f = fixture(t), group = 'dashboard:late-input'; f.register('late-input'); f.message(group);
  const attachments = new ChatAttachments({ store: f.store, c4Reader: { _open: () => f.c4Db }, zylosDir: f.zylos });
  t.after(() => attachments.close());
  const upload = await attachments.prepareUser('late-input', { name: 'pending.txt', mime: 'text/plain',
    principal: 'owner', stream: Readable.from(['retained bytes']) });
  const media = attachments.resolve('late-input', upload.id);
  const coreStore = createStore(f.c4Db, { readConfig: () => ({ state: 'ok', config: { session_mode: 'multi' } }) });
  let queued;
  const service = createGroupDeletion({ zylosDir: f.zylos, homeDir: f.home, database: f.c4Db,
    store: coreStore, participant: f.participant, waitMs: 0,
    requestStop: async request => {
      const audit = coreStore.beginGroupDeletion(group, { operationId: request.operationId, actor: request.actor, preview: request.preview });
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
  const result = await service.delete(group, { confirmed: true, actor: 'owner', operationId: 'late-input-deletion' });
  assert.equal(result.pending, false);
  assert.equal(result.counts.attachments, 0);
  assert.equal(result.counts.files, 0);
  assert.equal(result.countsEstimated, false);
  assert.equal(coreStore.getGroupDeletionAudit(result.operationId).preview.attachments, 1);
  assert.equal(f.c4Db.prepare('SELECT status FROM conversations WHERE id=?').get(queued).status, 'pending');
  assert.equal(fs.existsSync(media), true);
});
