import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readOwnerName, dashboardSource } from '../dashboard-source.js';
import { formatConversation } from '../router/format.js';
import { formatConversationsForAgent } from '../c4-db.js';
import { replyVia } from '../c4-query-format.js';
import { ATTACHMENTS_DIR } from '../c4-config.js';
import { CONTENT_PREFIX } from '../c4-content-schema.js';

const row = { id: 913001, channel: 'dashboard', direction: 'in', endpoint_id: 'dialog', session_group: 'dashboard:dialog', content: 'Hello' };
test('Dashboard source uses only the established owner name in Active IDs and falls back when unavailable', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-name-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'references.md');
  assert.equal(readOwnerName(file), 'the owner');
  for (const [record, expected] of [['Howard (Telegram: private-id)', 'Howard'], ['王小明（平台：私密）','王小明'], ['(not yet established)','the owner'], ['', 'the owner'], ['unknown','unknown'], ['none','none'], ['未设置','未设置'], ['not yet established','not yet established'], ['（未建立）','the owner'], ['(note) Howard','the owner'], ['（备注）Howard','the owner']]) {
    fs.writeFileSync(file, `# References\n## Active IDs\n- Owner: ${record}\n## Other\n- Owner: Incorrect\n`);
    assert.equal(readOwnerName(file), expected);
  }
  fs.writeFileSync(file, '## Active IDs\n- Owner: \n- Platform Identities: Recorded elsewhere\n');
  assert.equal(readOwnerName(file), 'the owner');
  for (const record of ['* Owner: Incorrect', 'Owner: Incorrect', '- owner: Incorrect', '- Owner:Incorrect']) {
    fs.writeFileSync(file, '## Active IDs\n' + record + '\n');
    assert.equal(readOwnerName(file), 'the owner');
  }
  fs.writeFileSync(file, '# References\n## Other\n- Owner: Incorrect\n');
  assert.equal(readOwnerName(file), 'the owner');
});

test('Dashboard provenance is applied exactly once per delivery without changing storage or reply route', () => {
  const input = Object.freeze({ ...row }), options = { scriptPath: '/c4-send.js', ownerName: () => 'Howard' };
  const text = formatConversation(input, options);
  assert.equal(text, '[Dashboard] Howard said: Hello ' + replyVia(row, options.scriptPath));
  assert.equal(formatConversation(input, options), text);
  assert.equal(input.content, 'Hello');
  for (const [channel, direction] of [['dashboard','out'],['telegram','in'],['internal','in']]) {
    const other = { ...row, channel, direction };
    assert.equal(formatConversation(other, options), other.content + ' ' + replyVia(other, options.scriptPath));
  }
  assert.equal(dashboardSource('reply', 'the owner'), '[Dashboard] the owner said: reply');
});

test('Dashboard source follows structured projection and survives complete delivery spills', t => {
  const envelope = { version: 1, kind: 'message', messageId: 'source-answer', fallbackText: 'selected answer',
    blocks: [{ id: 'text', type: 'markdown', schemaVersion: 1, data: { text: 'selected answer' } }] };
  const projected = formatConversation({ ...row, content: CONTENT_PREFIX + JSON.stringify(envelope) }, { scriptPath: '/send.js', ownerName: () => 'the owner' });
  assert.ok(projected.startsWith('[Dashboard] the owner said: selected answer'));
  const long = { ...row, id: 913002, content: 'full body ' + 'x'.repeat(1200) };
  const directory = path.join(ATTACHMENTS_DIR, `conv-${long.id}`);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const output = formatConversation(long, { scriptPath: '/send.js', ownerName: () => 'Howard' });
  const file = path.join(directory, 'message.txt');
  assert.ok(output.includes(file));
  assert.equal(fs.readFileSync(file, 'utf8'), dashboardSource(long.content, 'Howard') + ' ' + replyVia(long, '/send.js'));
});


test('Dashboard delivery reads the owner from the default isolated memory record', t => {
  const root = fs.realpathSync(process.env.ZYLOS_DIR);
  assert.ok(root.startsWith(fs.realpathSync(process.env.HOME) + path.sep));
  assert.notEqual(fs.realpathSync(process.env.HOME), fs.realpathSync(os.userInfo().homedir));
  const directory = path.join(root, 'memory'), file = path.join(directory, 'references.md');
  fs.mkdirSync(directory, { recursive: true });
  const previous = fs.existsSync(file) ? fs.readFileSync(file) : null;
  t.after(() => previous === null ? fs.rmSync(file, { force: true }) : fs.writeFileSync(file, previous));
  fs.writeFileSync(file, '# References\n## Active IDs\n- Owner: Default Owner (Telegram: hidden-contact)\n');
  assert.equal(readOwnerName(), 'Default Owner');
  assert.equal(formatConversation(row, { scriptPath: '/send.js' }),
    '[Dashboard] Default Owner said: Hello ' + replyVia(row, '/send.js'));
  assert.ok(formatConversationsForAgent([row], { spill: false })
    .includes('[Dashboard] Default Owner said: Hello'));
});
