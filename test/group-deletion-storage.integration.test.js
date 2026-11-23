import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createGroupDeletionFixture } from './helpers/group-deletion-fixture.js';
import { Store } from '../skills/dashboard/src/lib/store.js';
import { buildAnnotatedContent } from '../skills/comm-bridge/scripts/attachment-annotations.js';
const repo = fileURLToPath(new URL('../', import.meta.url));
function write(file, content) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); return file; }
function count(db, table, column, value) { return db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${column}=?`).get(value).n; }
async function setup(t, channel) {
  const localId = 'storage-cycle', group = `${channel}:${localId}`;
  const f = await createGroupDeletionFixture(t, { group });
  // Keep all private fixture commands on this official runner's Node runtime.
  f.env.PATH = path.dirname(process.execPath) + path.delimiter + f.env.PATH;
  const skills = path.join(f.root, '.claude/skills'); fs.mkdirSync(skills, { recursive: true });
  for (const name of ['dashboard', 'comm-bridge']) fs.symlinkSync(path.join(repo, 'skills', name), path.join(skills, name), 'dir');
  // The external transport boundary is an isolated local receipt sink. Core's
  // send command and its authoritative outbound insert remain production code.
  write(path.join(skills, channel, 'package.json'), '{"type":"module"}');
  write(path.join(skills, channel, 'SKILL.md'), '---\nname: telegram\ntype: communication\n---\n');
  write(path.join(skills, channel, 'scripts/session-group.js'), `process.stdout.write(${JSON.stringify(localId)});\n`);
  write(path.join(skills, channel, 'scripts/send.js'), 'import fs from "node:fs";import path from "node:path";fs.appendFileSync(path.join(process.env.ZYLOS_DIR,"external-replies.jsonl"),JSON.stringify(process.argv.slice(2))+"\\n");\n');
  f.store.registerChannelNamespace(channel, channel);
  const dashboard = new Store(f.sandbox.paths.dashboardDb); f.sandbox.addCleanup(() => dashboard.close());
  const receiveReal = async args => {
    const child = f.sandbox.startChild(process.execPath, [path.join(repo, 'skills/comm-bridge/scripts/c4-receive.js'), ...args, '--json'],
      { env: f.env, timeoutMs: 15_000 });
    child.stdin.end(); const result = await child.completion;
    assert.equal(result.code, 0, result.stdout + result.stderr);
    return JSON.parse(result.stdout.trim());
  };
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
  return { ...f, localId, group, dashboard, receiveReal, sendReply, delivered };
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

// Covers external-channel real Core receive/send + same native deletion/usage
// and recreation path. Transport is a private local receipt sink; no Telegram
// account/network is contacted. Run for Core/storage/lifecycle deletion changes;
// skip frontend-only changes. The fixture checks isolated HOME, ZYLOS_DIR,
// PM2_HOME, short TMPDIR, private tmux socket and test databases before launch,
// and reaps owned processes and paths during teardown.
test('external conversation deletes group storage and receives replies after recreation', { timeout: 90_000 }, async t => {
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
