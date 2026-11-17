import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createTestEnvironment } from '../../../../scripts/test-environment.js';
import { systemSendEnvironment } from '../c4-system-send-env.js';
import { CONTENT_PREFIX } from '../c4-content-schema.js';
import { projectC4Content } from '../../../../cli/lib/content-projection.js';

const environment = createTestEnvironment();
const db = await import('../c4-db.js');
const root = process.env.ZYLOS_DIR;
const cli = fileURLToPath(new URL('../c4-db.js', import.meta.url));
const send = fileURLToPath(new URL('../c4-send.js', import.meta.url));
const skill = fs.readFileSync(new URL('../../SKILL.md', import.meta.url), 'utf8');
const reference = fs.readFileSync(new URL('../../references/c4-db.md', import.meta.url), 'utf8');
after(() => { db.close(); environment.cleanup(); });

function run(script, args, input) {
  const env = systemSendEnvironment(process.env, { notice: script === send });
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME']) assert.ok(env[key].startsWith(environment.root + path.sep), key);
  assert.ok(env.TMPDIR.startsWith('/tmp/'), 'official runner supplies private short TMPDIR');
  const result = spawnSync(process.execPath, [script, ...args], { env, input, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 });
  assert.equal(result.error, undefined);
  return result;
}

// Boundary: real C4 send/store/recent CLI with a test-owned channel transport;
// rerun for history filters/projection or system_notice recording changes.
// No runtime, PM2 service, network channel, or tmux server is started.
// Skip for unrelated runtime/UI changes; teardown owns the private DB/tree.
test('documented same-chat history sees real system notices and projects their content before limiting', () => {
  const component = path.join(root, '.claude', 'skills', 'test-alert', 'scripts');
  assert.ok(component.startsWith(environment.root + path.sep));
  fs.mkdirSync(component, { recursive: true });
  fs.writeFileSync(path.join(component, 'send.js'), '// Test-owned channel transport succeeds without network I/O.\n');
  const endpoint = 'owner|topic:2566|type:group';
  const alert = 'User message #91 was not delivered. Would you like me to investigate? Please reply directly to this message.';
  const sent = run(send, ['test-alert', endpoint], alert);
  assert.equal(sent.status, 0, sent.stderr);
  const stored = db.getRecentConversations(1)[0];
  assert.equal(stored.delivery_action, 'system_notice');
  assert.equal(stored.direction, 'out');
  assert.equal(stored.content, alert);
  const reply = db.insertConversation('in', 'test-alert', 'owner|msg:2840|type:group|topic:2566', '需要');
  const envelope = CONTENT_PREFIX + JSON.stringify({ version: 1, kind: 'message', messageId: 'owner_alert',
    fallbackText: 'Readable alert summary', blocks: [{ id: 'detail', type: 'markdown', schemaVersion: 1, data: { text: 'PRIVATE_RAW_BLOCK' } }] });
  assert.equal(run(send, ['test-alert', endpoint], envelope).status, 0);
  const structured = db.getRecentConversations(1)[0];
  assert.equal(structured.delivery_action, 'system_notice');
  // Newer unrelated traffic must not consume this chat's history limit.
  for (let i = 0; i < 25; i++) db.insertConversation('out', 'test-alert', 'owner|topic:other|type:group', `other ${i}`);
  fs.mkdirSync(path.join(root, '.claude', 'skills', 'other-channel'));
  db.insertConversation('out', 'other-channel', endpoint, 'another channel');
  const args = ['recent', '20', '--channel', 'test-alert', '--endpoint', 'owner|parent:1|type:group|req:2|topic:2566|msg:2841'];
  assert.match(skill, /c4-db\.js recent 20 --channel '<channel>' --endpoint '<endpoint>'/);
  assert.match(reference, /recent \[limit\] \[--channel CHANNEL --endpoint ENDPOINT\]/);
  assert.match(skill, /references\/delivery-failure-receipts\.md#investigating-an-alert/);
  const history = run(cli, args);
  assert.equal(history.status, 0, history.stderr);
  const rows = JSON.parse(history.stdout);
  assert.deepEqual(rows.map(row => row.id), [stored.id, reply.id, structured.id]);
  assert.equal(rows[0].delivery_action, 'system_notice');
  assert.equal(rows[0].content, alert);
  assert.equal(rows[1].content, '需要');
  assert.equal(rows[2].delivery_action, 'system_notice');
  assert.equal(rows[2].content, projectC4Content(envelope, { c4Id: structured.id }));
  assert.ok(rows[2].content.startsWith('Readable alert summary\n[C4 messageId=owner_alert'));
  assert.equal(history.stdout.includes('PRIVATE_RAW_BLOCK'), false);
  assert.equal(db.getConversationsByRange(structured.id, structured.id)[0].content, envelope);
  const limited = run(cli, ['recent', '1', '--channel', 'test-alert', '--endpoint', endpoint]);
  assert.equal(limited.status, 0, limited.stderr);
  assert.equal(JSON.parse(limited.stdout)[0].id, structured.id);
  const global = run(cli, ['recent', '1']);
  assert.equal(global.status, 0, global.stderr);
  assert.equal(JSON.parse(global.stdout)[0].channel, 'other-channel');
});

test('recent rejects incomplete or empty chat filters', () => {
  for (const args of [ ['--channel', 'test-alert'], ['--endpoint', 'owner'],
    ['--channel', '', '--endpoint', 'owner'], ['--channel', 'test-alert', '--endpoint', ''] ]) {
    const result = run(cli, ['recent', ...args, '--json']);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).error.code, 'INVALID_ARGS');
  }
});


// Same private CLI/transport boundary as above; run for endpoint identity
// matching changes and skip unrelated UI/runtime changes.
test('Feishu bare owner alerts match private replies without crossing group thread scopes', () => {
  const component = path.join(root, '.claude', 'skills', 'feishu', 'scripts');
  fs.mkdirSync(component, { recursive: true });
  fs.writeFileSync(path.join(component, 'send.js'), '// Test-owned transport; no network.\n');
  const alert = 'Owner alert: need me to investigate?';
  assert.equal(run(send, ['feishu', 'oc_owner_dm'], alert).status, 0);
  const notice = db.getRecentConversations(1)[0];
  assert.equal(notice.delivery_action, 'system_notice');
  const reply = db.insertConversation('in', 'feishu', 'oc_owner_dm|type:p2p|root:om_alert|parent:om_alert|msg:om_reply|thread:omt_reply', '需要');
  db.insertConversation('out', 'feishu', 'oc_owner_dm|type:group|root:om_other|thread:omt_other', 'other thread');
  const history = run(cli, ['recent', '20', '--channel', 'feishu', '--endpoint', reply.endpoint_id]);
  assert.equal(history.status, 0, history.stderr);
  const rows = JSON.parse(history.stdout);
  assert.deepEqual(rows.map(row => row.id), [notice.id, reply.id]);
  assert.equal(rows[0].delivery_action, 'system_notice');
  assert.equal(rows[0].content, alert);
  assert.equal(run(send, ['feishu', 'oc_owner_group'], alert).status, 0);
  const groupNotice = db.getRecentConversations(1)[0];
  const groupReply = db.insertConversation('in', 'feishu', 'oc_owner_group|type:group|root:om_alert|msg:om_reply', 'yes');
  const groupHistory = run(cli, ['recent', '20', '--channel', 'feishu', '--endpoint', groupReply.endpoint_id]);
  assert.equal(groupHistory.status, 0, groupHistory.stderr);
  assert.deepEqual(JSON.parse(groupHistory.stdout).map(row => row.id), [groupNotice.id, groupReply.id]);
  const scopedHistory = run(cli, ['recent', '20', '--channel', 'feishu', '--endpoint', 'oc_owner_group|type:group|root:om_other|thread:omt_other']);
  assert.equal(scopedHistory.status, 0, scopedHistory.stderr);
  assert.deepEqual(JSON.parse(scopedHistory.stdout), []);
});
