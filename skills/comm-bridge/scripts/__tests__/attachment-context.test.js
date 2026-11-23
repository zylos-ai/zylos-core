import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { projectC4Content } from '../c4-content-projection.js';
import { dashboardSource } from '../dashboard-source.js';
import { replyVia } from '../c4-query-format.js';
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

test('plain attachment annotations survive projection and general agent history formatters byte for byte', () => {
  assert.equal(projectC4Content(content, { c4Id: row.id }), content);
  for (const [output, expected] of [[formatters.formatConversations([row]), content],
    [formatters.formatConversationsForAgent([row], { spill: false, ownerName: () => 'the owner' }), dashboardSource(content, 'the owner')]]) {
    assert.ok(output.includes(expected));
    assert.ok(output.includes(buildAttachmentAnnotation(file)));
    assert.ok(output.includes(buildAttachmentAnnotation(image)));
  }
  assert.equal(row.content, content);
  assert.equal(databaseOpens, 0);
});

test('public fetch text and JSON retain attachment paths while preserving reply routing', () => {
  rows = [row];
  const text = fetchCli(['--begin', String(row.id), '--end', String(row.id)]);
  assert.ok(text.includes(content));
  assert.ok(text.includes(replyVia(row, sendPath)));
  assert.equal(text.includes('[Dashboard]'), false);
  const json = JSON.parse(fetchCli(['--begin', String(row.id), '--end', String(row.id), '--json']));
  assert.equal(json.ok, true);
  assert.equal(json.data.rows.length, 1);
  assert.equal(json.data.rows[0].content, content);
  assert.equal(databaseOpens, 0);
});
