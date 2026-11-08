import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { projectC4Content } from '../c4-content-projection.js';
import { formatConversation } from '../router/format.js';
import { replyVia } from '../c4-query-format.js';
import { createQueryHandlers } from '../c4-v2-cli.js';
import { ATTACHMENTS_DIR, SKILLS_DIR } from '../c4-config.js';
import { buildAnnotatedContent, buildAttachmentAnnotation } from '../attachment-annotations.js';

const home = fs.realpathSync(process.env.HOME);
const root = fs.realpathSync(process.env.ZYLOS_DIR);
const runner = path.dirname(home);
assert.notEqual(home, fs.realpathSync(os.userInfo().homedir));
assert.ok(root.startsWith(home + path.sep));
for (const key of ['PM2_HOME', 'TMPDIR']) assert.ok(path.resolve(process.env[key]).startsWith(runner + path.sep));
assert.ok(ATTACHMENTS_DIR.startsWith(root + path.sep));
console.log(JSON.stringify({ HOME: home, ZYLOS_DIR: root, PM2_HOME: process.env.PM2_HOME,
  TMPDIR: process.env.TMPDIR, spillDirectory: ATTACHMENTS_DIR,
  database: 'forbidden constructor', tmuxSocket: path.join(runner, 'private-tmux.sock'),
  runtimeLaunches: 0, pm2Launches: 0 }));

// Exercise real output code while making every storage/runtime access fail.
let databaseOpens = 0;
mock.module('better-sqlite3', { defaultExport: class {
  constructor() { databaseOpens++; assert.fail('Attachment context must not open a database'); }
} });
const formatters = await import('../c4-db.js');
let rows = [];
mock.module('../c4-db.js', { namedExports: { ...formatters,
  getLatestContentCheckpoint: () => null,
  getConversationsByRange: () => rows,
} });
const { fetchCli } = await import('../c4-public-cli.js');

const file = { path: path.join(root, 'components/dashboard/media/report.pdf'),
  name: 'report.pdf', size: 37, kind: 'file' };
const image = { path: path.join(root, 'components/dashboard/media/preview.png'),
  name: 'preview.png', size: 91, kind: 'image' };
const content = buildAnnotatedContent('Read these files.', [file, image]);
const sendPath = path.join(SKILLS_DIR, 'comm-bridge/scripts/c4-send.js');
const row = Object.freeze({ id: 910001, timestamp: '2026-01-01 12:00:00', direction: 'in',
  channel: 'dashboard', endpoint_id: 'local-dialog', session_group: 'dashboard-owned:original:dialog', content });
const runId = '12345678-1234-4234-8234-123456789abc';

test('plain attachment annotations survive projection and general agent history formatters byte for byte', () => {
  assert.equal(projectC4Content(content, { c4Id: row.id }), content);
  for (const output of [formatters.formatConversations([row]),
    formatters.formatConversationsForAgent([row], { spill: false })]) {
    assert.ok(output.includes(content));
    assert.ok(output.includes(buildAttachmentAnnotation(file)));
    assert.ok(output.includes(buildAttachmentAnnotation(image)));
  }
  assert.equal(row.content, content);
  assert.equal(databaseOpens, 0);
});

test('Dashboard inbound attachment hint retains the exact original reply route and session group', t => {
  const original = replyVia(row, sendPath);
  assert.ok(original.endsWith('--session-group original:dialog'));
  const output = formatConversation(row);
  const directory = path.join(ATTACHMENTS_DIR, `conv-${row.id}`);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const spill = path.join(directory, 'message.txt');
  const complete = fs.existsSync(spill) ? fs.readFileSync(spill, 'utf8') : output;
  assert.ok(complete.includes(content));
  assert.ok(complete.includes(path.join(SKILLS_DIR, 'dashboard/SKILL.md')));
  assert.ok(complete.includes('Attachments:'));
  assert.ok(complete.endsWith(original));
  assert.equal(complete.split(original).length - 1, 1);
  assert.equal(complete.includes('--session-group local-dialog'), false);
  const external = formatConversation({ ...row, channel: 'telegram' });
  assert.equal(external.includes('Attachments:'), false);
  assert.equal(databaseOpens, 0);
});

test('ordinary Dashboard text includes component guidance within its paste budget without an attachment hint', t => {
  const scriptPath = '/c4-send.js';
  const empty = { ...row, id: 910010, content: '' };
  const suffix = formatConversation(empty, { scriptPath });
  assert.ok(suffix.includes('Dashboard supports charts and interactive components'));
  assert.equal(suffix.includes('Attachments:'), false);
  const maximum = 800 - suffix.length;
  assert.ok(maximum > 0);
  for (const [index, length] of [1, maximum].entries()) {
    const plain = { ...row, id: 910010 + index, content: 'x'.repeat(length) };
    const directory = path.join(ATTACHMENTS_DIR, `conv-${plain.id}`);
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const output = formatConversation(plain, { scriptPath });
    assert.equal(output, plain.content + suffix);
    assert.equal(output.includes('TRUNCATED'), false);
    assert.equal(fs.existsSync(path.join(directory, 'message.txt')), false);
  }
  assert.equal(formatConversation({ ...row, content: '[MEDIA:/tmp/source.png]' }, { scriptPath })
    .includes('Attachments:'), false);
});

// Output integration boundary: real spill writer, formatter and isolated files.
// Run for attachment annotation/projection/hint/formatter changes; unrelated UI
// may skip. No database, process, tmux or PM2 is started; runner owns all files.
test('live and startup spill files retain complete annotations beyond the preview budget', t => {
  const long = buildAnnotatedContent('Readable lead. ' + 'x'.repeat(1300), [file, image]);
  for (const [id, format] of [[910002, value => formatConversation(value)],
    [910003, value => formatters.formatConversationsForAgent([value])]]) {
    const value = { ...row, id, content: long };
    const directory = path.join(ATTACHMENTS_DIR, `conv-${id}`);
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const output = format(value);
    const spill = path.join(directory, 'message.txt');
    assert.ok(output.includes(spill));
    assert.ok(output.includes('TRUNCATED'));
    assert.equal(output.includes(buildAttachmentAnnotation(file)), false);
    const complete = fs.readFileSync(spill, 'utf8');
    assert.ok(complete.startsWith(long));
    assert.ok(complete.includes(buildAttachmentAnnotation(file)));
    assert.ok(complete.includes(buildAttachmentAnnotation(image)));
    if (id === 910002) assert.ok(complete.endsWith(replyVia(row, sendPath)));
  }
  assert.equal(databaseOpens, 0);
});

test('public fetch text and JSON retain attachment paths while preserving reply routing', () => {
  rows = [row];
  const text = fetchCli(['--begin', String(row.id), '--end', String(row.id)]);
  assert.ok(text.includes(content));
  assert.ok(text.includes(replyVia(row, sendPath)));
  const json = JSON.parse(fetchCli(['--begin', String(row.id), '--end', String(row.id), '--json']));
  assert.equal(json.ok, true);
  assert.equal(json.data.rows.length, 1);
  assert.equal(json.data.rows[0].content, content);
  assert.equal(databaseOpens, 0);
});

// Output integration boundary: actual absorbed query handlers write one private
// file. Run for absorbed attachment exports/projection changes; UI may skip.
test('absorbed full exports preserve annotations after summary truncation and keep original absorbed reply semantics', t => {
  const long = { ...row, content: buildAnnotatedContent('x'.repeat(600), [file, image]) };
  const snapshot = { transition: { run_id: runId, target_mode: 'multi' }, rows: [long] };
  const query = createQueryHandlers({ queries: { readAbsorbed: () => snapshot } });
  const page = JSON.parse(query.absorbed({ runId, json: true }));
  assert.equal(page.data.items[0].textTruncated, true);
  assert.equal(page.data.items[0].text.includes(file.path), false);
  assert.equal(page.data.items[0].reply, `c4-send.js --absorbed-reply ${runId} ${row.id}`);
  const full = JSON.parse(query.absorbed({ runId, id: row.id, json: true }));
  assert.equal(full.data.data, long.content);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'attachment-absorbed-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const destination = path.join(directory, 'body.txt');
  const receipt = JSON.parse(query.absorbed({ runId, id: row.id, out: destination, json: true }));
  assert.equal(receipt.data.path, destination);
  assert.equal(fs.readFileSync(destination, 'utf8'), long.content);
  assert.equal(databaseOpens, 0);
});
