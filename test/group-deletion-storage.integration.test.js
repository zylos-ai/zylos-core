import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { createGroupDeletionFixture } from './helpers/group-deletion-fixture.js';
import { Store } from '../skills/dashboard/src/lib/store.js';
import { ChatConversations } from '../skills/dashboard/src/lib/chat/conversations.js';
import { ChatAttachments } from '../skills/dashboard/src/lib/chat/attachments.js';
import { ChatSender } from '../skills/dashboard/src/lib/chat/send.js';
import { createGroupDeletionBridge } from '../skills/dashboard/src/lib/workbench/group-deletion.js';
import { groupDeletionCliPath } from '../cli/lib/group-delete.js';
import { isDataError } from '../skills/comm-bridge/scripts/c4-session-group.js';
import { CONTENT_PREFIX } from '../skills/comm-bridge/scripts/c4-content-schema.js';
import { buildAnnotatedContent } from '../skills/comm-bridge/scripts/attachment-annotations.js';
const enabled = process.env.ZYLOS_GROUP_DELETION_INTEGRATION === '1';
const repo = fileURLToPath(new URL('../', import.meta.url));
const canonical = group => `g:${Buffer.from(group).toString('hex').toUpperCase()}`;
function write(file, content) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); return file; }
function count(db, table, column, value) { return db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${column}=?`).get(value).n; }
function attachmentMessage(id, name) {
  return CONTENT_PREFIX + JSON.stringify({ version: 1, kind: 'message', messageId: randomUUID(), fallbackText: name,
    blocks: [{ id: 'file', type: 'x-zylos.file', schemaVersion: 1, fallbackText: name, data: { attachmentId: id, nameSnapshot: name } }] });
}
async function setup(t, channel) {
  const localId = 'storage-cycle', group = `${channel}:${localId}`;
  const f = await createGroupDeletionFixture(t, { group });
  // Core's channel launcher intentionally resolves "node" from PATH. Keep its
  // SQLite ABI identical to this official-runner process in the private case.
  f.env.PATH = path.dirname(process.execPath) + path.delimiter + f.env.PATH;
  const skills = path.join(f.root, '.claude/skills'); fs.mkdirSync(skills, { recursive: true });
  for (const name of ['dashboard', 'comm-bridge']) fs.symlinkSync(path.join(repo, 'skills', name), path.join(skills, name), 'dir');
  // The external transport boundary is an isolated local receipt sink. Core's
  // send command and its authoritative outbound insert remain production code.
  if (channel !== 'dashboard') {
    write(path.join(skills, channel, 'package.json'), '{"type":"module"}');
    write(path.join(skills, channel, 'SKILL.md'), '---\nname: telegram\ntype: communication\n---\n');
    write(path.join(skills, channel, 'scripts/send.js'), 'import fs from "node:fs";import path from "node:path";fs.appendFileSync(path.join(process.env.ZYLOS_DIR,"external-replies.jsonl"),JSON.stringify(process.argv.slice(2))+"\\n");\n');
  }
  f.store.registerChannelNamespace(channel, channel);
  const dashboard = new Store(f.sandbox.paths.dashboardDb); f.sandbox.addCleanup(() => dashboard.close());
  const conversations = new ChatConversations({ store: dashboard, idGenerator: () => localId });
  const reader = { _open: () => f.database };
  const attachments = new ChatAttachments({ store: dashboard, c4Reader: reader, zylosDir: f.root });
  f.sandbox.addCleanup(() => attachments.close());
  const receiveReal = async args => {
    const child = f.sandbox.startChild(process.execPath, [path.join(repo, 'skills/comm-bridge/scripts/c4-receive.js'), ...args, '--json'],
      { env: f.env, timeoutMs: 15_000 });
    child.stdin.end(); const result = await child.completion;
    assert.equal(result.code, 0, result.stdout + result.stderr);
    return JSON.parse(result.stdout.trim());
  };
  const sender = new ChatSender({ conversations, c4Reader: reader, attachments, zylosDir: f.root,
    loadCore: async () => ({ receive: receiveReal, ensureChannelNamespace: f.store.ensureChannelNamespace,
      getChannelNamespace: f.store.getChannelNamespace, isDataError }) });
  const sendReply = async content => {
    const identity = await f.scenes.observeGroup(group);
    const child = f.sandbox.startChild(process.execPath, [path.join(repo, 'skills/comm-bridge/scripts/c4-send.js'), channel, localId, '--session-group', localId],
      { env: { ...f.env, ZYLOS_SESSION_GROUP: group, ZYLOS_RUN_ID: identity.runId }, timeoutMs: 15_000 });
    child.stdin.end(content); const result = await child.completion;
    assert.equal(result.code, 0, result.stdout + result.stderr);
    return f.database.prepare("SELECT * FROM conversations WHERE session_group=? AND direction='out' ORDER BY id DESC LIMIT 1").get(group);
  };
  const delivered = async id => {
    try { await f.waitFor(() => {
      const row = f.database.prepare('SELECT status,delivery_action FROM conversations WHERE id=?').get(id);
      assert.ok(!row || ['pending', 'running', 'delivered'].includes(row.status), JSON.stringify(row));
      return row?.status === 'delivered';
    }, 'Input must be delivered by the real dispatcher', 20_000); }
    catch (error) {
      console.log('Storage delivery state:', JSON.stringify({ id,
        rows: f.database.prepare('SELECT id,status,session_group,delivery_action FROM conversations ORDER BY id LIMIT 12').all(),
        fences: f.store.listDrainFences(), slots: f.database.prepare('SELECT * FROM slot_occupancy LIMIT 12').all(),
        process: await f.scenes.observeGroup(group) }));
      throw error;
    }
  };
  const bridge = createGroupDeletionBridge({ zylosDir: f.root, env: f.env,
    loadCoreModule: async () => ({ groupDeletionCliPath }),
    execute: async (binary, args, options) => {
      // Preserve the real bridge's arguments, CLI and installed participant;
      // the sandbox adapter only binds the child to test timeout/cleanup.
      const child = f.sandbox.startChild(binary, args, { env: options.env, timeoutMs: options.timeout });
      child.stdin.end(); const result = await child.completion;
      if (result.code !== 0) throw Object.assign(new Error('Core CLI failed'), result);
      return result;
    } });
  return { ...f, localId, group, channel, skills, dashboard, conversations, attachments, sender, receiveReal, sendReply, delivered, bridge };
}
function seedOwnedData(f, identity) {
  const { group, root, homeDir, dashboard, database } = f;
  const sid = identity.sessionId;
  const launch = f.store.resolveSessionLaunchConfig({ sessionGroup: group, sessionMode: 'multi' });
  assert.deepEqual(launch, identity.launchConfig);
  // Seed both deletion targets without changing the running terminal's config:
  // its runtime stays Claude; the model override belongs to inactive Codex.
  database.prepare('INSERT INTO group_runtime_overrides(session_group,runtime) VALUES (?,?)').run(group, 'claude');
  database.prepare('INSERT INTO group_model_overrides(session_group,runtime,model,effort) VALUES (?,?,?,?)').run(group, 'codex', 'fixture-model', 'high');
  assert.deepEqual(f.store.resolveSessionLaunchConfig({ sessionGroup: group, sessionMode: 'multi' }), launch);
  for (const table of ['group_runtime_overrides', 'group_model_overrides']) assert.equal(count(database, table, 'session_group', group), 1, table);

  const transcript = write(path.join(homeDir, '.claude/projects/private', `${sid}.jsonl`), JSON.stringify({ type: 'assistant', uuid: 'usage-event', requestId: 'usage-request', sessionId: sid,
    timestamp: new Date().toISOString(), message: { id: 'usage-response', role: 'assistant', model: 'claude-sonnet-4', usage: { input_tokens: 900, output_tokens: 100 }, content: [] } }) + '\n');
  dashboard.insertUsageTranscript({ transcript_path: transcript, runtime: 'claude', session_group: group, session_id: sid, run_id: identity.runId }, new Date().toISOString());
  const envFile = write(path.join(homeDir, '.claude/session-env', sid, 'private-state'), 'private runtime state');
  const memory = write(path.join(root, 'memory/session-groups', group, 'state.md'), 'private group memory');
  const spill = write(path.join(f.env.TMPDIR, `zylos-shard-spill-${process.getuid()}`, sid, 'private.txt'), 'private shard');
  const historyContent = JSON.stringify({ sessionId: sid, display: 'shared history retained' }) + '\n' + JSON.stringify({ sessionId: 'other-session', display: 'other history' }) + '\n';
  const history = write(path.join(homeDir, '.claude/history.jsonl'), historyContent);
  const keep = write(path.join(root, 'memory/state.md'), 'main memory retained');
  const backup = write(path.join(root, '.backup/keep.txt'), 'backup retained');
  const other = write(path.join(root, 'memory/session-groups/telegram:other/state.md'), 'other group retained');
  dashboard.writeGroupDisplayName(group, 'old custom name', 'human');
  dashboard.insertEvent({ id: randomUUID(), ingest_id: randomUUID(), timestamp: new Date().toISOString(), session_group: group, run_id: identity.runId,
    session_id: sid, event_type: 'tool_use', category: 'tool', summary: 'private tool summary' });
  const events = write(path.join(root, 'activity-monitor/session-groups', group, 'events.jsonl'), JSON.stringify({ v: 1, ts: Date.now(), event: 'stop', session_group: group, run_id: identity.runId, session_id: sid, runtime: 'claude' }) + '\n');
  const stat = fs.statSync(events);
  dashboard.db.prepare('INSERT INTO core_log_cursors(stream,file_dev,file_ino,generation,file_name) VALUES(?,?,?,1,?)')
    .run(`events:${group}`, stat.dev, stat.ino, events);
  const head = database.prepare('SELECT head_id FROM group_heads WHERE session_group=?').get(group).head_id;
  f.store.createCheckpoint(group, head, 'private checkpoint');
  database.prepare('INSERT INTO origin_sync_cursors(session_group,synced_id,checkpoint_id,updated_at) VALUES(?,?,0,1)').run(group, head);
  const control = f.store.insertControl('old finished control', { sessionGroup: group, appendAckSuffix: false });
  database.prepare("UPDATE control_queue SET status='done' WHERE id=?").run(control.id);
  return { transcript, envFile, memory, spill, history, historyContent, keep, backup, other, sid };
}
function assertDeleted(f, files, operationId) {
  for (const table of ['conversations', 'checkpoints', 'origin_sync_cursors', 'group_heads', 'run_endings', 'control_queue', 'group_runtime_overrides', 'group_model_overrides', 'slot_occupancy']) {
    assert.equal(count(f.database, table, 'session_group', f.group), 0, table);
  }
  for (const table of ['runtime_events', 'group_display_names', 'chat_questions', 'chat_answers']) assert.equal(count(f.dashboard.db, table, 'session_group', f.group), 0, table);
  assert.equal(count(f.dashboard.db, 'core_log_cursors', 'stream', `events:${f.group}`), 0);
  assert.equal(count(f.dashboard.db, 'chat_conversations', 'local_id', f.localId), 0);
  assert.equal(count(f.dashboard.db, 'chat_attachments', 'local_id', f.localId), 0);
  for (const file of [files.transcript, files.envFile, files.memory, files.spill]) assert.equal(fs.existsSync(file), false, file);
  assert.equal(fs.existsSync(path.join(f.root, 'activity-monitor/session-groups', f.group)), false);
  for (const file of [files.keep, files.backup, files.other]) assert.equal(fs.existsSync(file), true, file);
  assert.equal(fs.readFileSync(files.history, 'utf8'), files.historyContent, 'Shared native history is retained byte-for-byte');
  assert.equal(f.dashboard.getUsageTranscript(files.transcript).status, 'finished');
  assert.ok(count(f.dashboard.db, 'metric_points', 'session_group', f.group) > 0);
  assert.ok(f.dashboard.aggregateCost({ sessionId: files.sid }) > 0);
  const audit = f.store.getGroupDeletionAudit(operationId);
  assert.equal(audit.status, 'done'); assert.equal(audit.counts.messages, 4);
  assert.equal(f.store.getDrainFence(f.group), null); assert.equal(f.runtimePresent(f.group), false);
}

// Covers real draft/attachment storage + native receive and dispatcher delivery,
// Core CLI/AM stop + final usage import and physical cleanup + new-run replies.
// Run when Core deletion, Dashboard participant, sender or attachment ownership
// changes; unrelated UI can skip. HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR/private
// tmux/SQLite are asserted by the fixture before resources start. No model API.
test('Dashboard conversation deletes owned storage and recreates with an attachment-first reply', { skip: !enabled, timeout: 90_000 }, async t => {
  const f = await setup(t, 'dashboard');
  await f.sandbox.runCase(async () => {
    const draft = f.conversations.create(); assert.equal(draft.state, 'draft');
    const upload = await f.attachments.prepareUser(f.localId, { name: 'input.txt', mime: 'text/plain', principal: 'owner', stream: Readable.from(['private input attachment']) });
    f.startDispatcher();
    const first = await f.sender.send(draft.id, { content: 'first input', attachments: [upload.id] }, { principal: 'owner' });
    assert.equal(first.stored, true); await f.delivered(first.messageId);
    const uploadedFile = f.attachments.resolve(f.localId, upload.id);
    assert.equal(count(f.dashboard.db, 'chat_attachment_messages', 'attachment_id', upload.id), 1);
    await f.sendReply('first reply');
    const second = await f.sender.send(first.conversationId, { content: 'second input ' + 'x'.repeat(1800) });
    await f.delivered(second.messageId); await f.sendReply('second reply');
    const old = await f.scenes.observeGroup(f.group); assert.equal(old.processRunning, true);
    const files = seedOwnedData(f, old), operationId = randomUUID();
    const spillDir = path.join(f.root, 'comm-bridge/attachments', `conv-${second.messageId}`); assert.equal(fs.existsSync(spillDir), true);
    const preview = await f.bridge({ sessionGroup: f.group }, { preview: true, actor: 'dashboard:owner' });
    assert.equal(preview.ok, true); assert.equal(preview.attachments, 1);
    let deleted;
    await f.waitFor(async () => {
      deleted = await f.bridge({ sessionGroup: f.group }, { actor: 'dashboard:owner', operationId,
        cutoffId: preview.cutoffId });
      assert.equal(deleted.ok, true, JSON.stringify(deleted)); return deleted.pending === false;
    }, 'Real Dashboard bridge CLI must finish deleting', 20_000);
    assert.equal(deleted.retainedMessages, 0); assert.equal(deleted.groupDataRetained, false);
    assertDeleted(f, files, operationId); assert.equal(fs.existsSync(uploadedFile), false); assert.equal(fs.existsSync(spillDir), false);
    assert.equal(count(f.dashboard.db, 'chat_attachment_messages', 'attachment_id', upload.id), 0);
    assert.equal(f.store.getGroupDeletionAudit(operationId).counts.attachments, 1);
    const cost = f.dashboard.aggregateCost({ sessionId: files.sid });
    const recreated = await f.receiveReal(['--channel', 'dashboard', '--endpoint', f.localId, '--session-group', f.localId, '--content', 'recreated scheduled input']);
    assert.equal(recreated.action, 'queued', JSON.stringify(recreated));
    await f.delivered(recreated.id);
    assert.equal(f.conversations.findByGroup(f.group), null, 'Core receive alone does not fabricate Dashboard records');
    const replySource = write(path.join(f.root, 'workspace/reply.txt'), 'attachment-first reply');
    const attachment = await f.attachments.register(f.localId, { kind: 'file', path: replySource });
    assert.equal(attachment.ok, true); assert.equal(f.conversations.findByGroup(f.group).state, 'active');
    const reply = await f.sendReply(attachmentMessage(attachment.attachmentId, attachment.name));
    assert.equal(count(f.dashboard.db, 'chat_attachment_messages', 'attachment_id', attachment.attachmentId), 1);
    assert.equal(f.attachments.download(f.localId, attachment.attachmentId).path, f.attachments.resolve(f.localId, attachment.attachmentId));
    const followup = await f.sender.send(canonical(f.group), { content: 'normal reply from owner' }); await f.delivered(followup.messageId);
    const next = await f.scenes.observeGroup(f.group); assert.notEqual(next.runId, old.runId);
    assert.equal(f.dashboard.aggregateCost({ sessionId: files.sid }), cost); assert.equal(reply.session_group, f.group);
    console.log('Dashboard storage cycle:', JSON.stringify({ operationId, oldRun: old.runId, newRun: next.runId, attachmentLinked: true, retainedCost: cost }));
  }, { timeoutMs: 80_000 });
});

// Covers external-channel real Core receive/send + same native deletion/usage
// and recreation path. Transport is a private local receipt sink; no Telegram
// account/network is contacted. Run for Core/storage/lifecycle deletion changes;
// frontend-only changes can skip under the same isolation/cleanup contract.
test('external conversation deletes group storage and receives replies after recreation', { skip: !enabled, timeout: 90_000 }, async t => {
  const f = await setup(t, 'telegram');
  await f.sandbox.runCase(async () => {
    f.startDispatcher();
    const attachment = write(path.join(f.root, 'workspace/external-input.txt'), 'external input attachment');
    const first = await f.receiveReal(['--channel', 'telegram', '--endpoint', f.localId, '--session-group', f.localId,
      '--content', buildAnnotatedContent('external first input ' + 'x'.repeat(1800), [{ path: attachment, name: 'external-input.txt', kind: 'file', size: 25 }])]);
    await f.delivered(first.id); await f.sendReply('external first reply');
    const second = await f.receiveReal(['--channel', 'telegram', '--endpoint', f.localId, '--session-group', f.localId, '--content', 'external second input']);
    await f.delivered(second.id); await f.sendReply('external second reply');
    const old = await f.scenes.observeGroup(f.group), files = seedOwnedData(f, old), operationId = randomUUID();
    const spillDir = path.join(f.root, 'comm-bridge/attachments', `conv-${first.id}`); assert.equal(fs.existsSync(spillDir), true);
    const deleted = await f.startDeleteChild({ operationId }).completion;
    assert.equal(deleted.code, 0, deleted.stdout + deleted.stderr); assert.equal(JSON.parse(deleted.stdout.trim()).pending, false);
    assert.equal(JSON.parse(deleted.stdout.trim()).retainedMessages, 0);
    assert.equal(JSON.parse(deleted.stdout.trim()).groupDataRetained, false);
    assertDeleted(f, files, operationId); assert.equal(fs.existsSync(spillDir), false);
    assert.equal(fs.existsSync(attachment), true, 'External original source is outside group-owned C4 storage');
    const cost = f.dashboard.aggregateCost({ sessionId: files.sid });
    const nextInput = await f.receiveReal(['--channel', 'telegram', '--endpoint', f.localId, '--session-group', f.localId, '--content', 'external recreated input']);
    await f.delivered(nextInput.id); const reply = await f.sendReply('external recreated reply');
    const next = await f.scenes.observeGroup(f.group); assert.notEqual(next.runId, old.runId); assert.equal(reply.session_group, f.group);
    assert.equal(f.dashboard.aggregateCost({ sessionId: files.sid }), cost);
    assert.equal(fs.readFileSync(path.join(f.root, 'external-replies.jsonl'), 'utf8').trim().split('\n').length, 3);
    console.log('External storage cycle:', JSON.stringify({ operationId, oldRun: old.runId, newRun: next.runId, retainedCost: cost }));
  }, { timeoutMs: 80_000 });
});
