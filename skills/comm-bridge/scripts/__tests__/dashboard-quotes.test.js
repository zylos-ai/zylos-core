import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as source from '../dashboard-source.js';
import { formatConversation } from '../router/format.js';
import { formatConversationsForAgent } from '../c4-db.js';
import { buildAnnotatedContent } from '../attachment-annotations.js';
import { DB_PATH } from '../c4-config.js';
import { SKILLS_DIR } from '../c4-config.js';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const home = fs.realpathSync(process.env.HOME), deployment = fs.realpathSync(process.env.ZYLOS_DIR);
assert.notEqual(home, fs.realpathSync(os.userInfo().homedir));
assert.ok(deployment.startsWith(home + path.sep));
for (const key of ['PM2_HOME', 'TMPDIR']) assert.ok(path.resolve(process.env[key]).startsWith(path.dirname(home) + path.sep));
assert.ok(DB_PATH.startsWith(deployment + path.sep));
console.log('Quote Core isolation:', JSON.stringify({ HOME: home, ZYLOS_DIR: deployment,
  PM2_HOME: process.env.PM2_HOME, TMPDIR: process.env.TMPDIR, database: DB_PATH, runtime: 'not launched' }));

// Both formatting entrypoints only; runner-owned paths and no runtime/DB launch.
// Run for changes to Dashboard source formatting; skip unrelated frontend work.
test('Existing channel rows retain exact live and replay formatting without reference reads', () => {
  const shapes = [
    ['telegram', 'in', 'Telegram text'],
    ['telegram', 'in', '<replying-to>\n[Alice]: component quote\n</replying-to>\nNew telegram text'],
    ['lark', 'in', 'Lark text'], ['openmax', 'in', 'OpenMax text'],
    ['internal', 'in', '[internal] peer said: Internal text'],
    ['internal', 'out', 'Internal outbound'], ['scheduler', 'in', 'Scheduled text'],
    ['system', 'in', 'System text'], ['dashboard', 'out', '[quote c4_id=10]\nDashboard outbound'],
    ['dashboard', 'in', 'Dashboard plain'],
    ['dashboard', 'in', buildAnnotatedContent('Dashboard attachment', [
      { kind: 'file', path: '/private/new.txt', name: 'new.txt', size: 2 },
    ])],
  ];
  let reads = 0;
  const lookupQuote = () => { reads++; throw new Error('Unexpected reference lookup'); };
  const rows = shapes.map(([channel, direction, content], index) => ({
    id: 100 + index, channel, direction, content, endpoint_id: 'dialog',
    session_group: 'dashboard:dialog', timestamp: '2026-11-11 11:00:00',
  }));
  const scripts = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
  const normalize = (text, row) => {
    const paths = text.replaceAll(SKILLS_DIR, '$SKILLS').replaceAll(scripts, '$CORE_SCRIPTS');
    if (row.channel !== 'dashboard' || row.direction !== 'in') return paths;
    const openingTag = `<current-message c4_id="${row.id}">`;
    assert.ok(paths.includes(openingTag));
    return paths.replace(openingTag, '<current-message>');
  };
  const now = Date.parse('2026-11-11T11:00:00Z');
  const outputs = rows.map(row => ({
    live: normalize(formatConversation(row, { ownerName: () => 'Owner', lookupQuote, now }), row),
    replay: normalize(formatConversationsForAgent([row], { spill: false, ownerName: () => 'Owner', lookupQuote }), row),
  }));
  assert.equal(reads, 0);
  for (const row of rows.filter(row => row.channel === 'dashboard' && row.direction === 'in')) {
    source.resolveDashboardQuote?.(row, { prepare() { reads++; throw new Error('Unexpected database read'); } });
  }
  assert.equal(reads, 0);
  const digest = createHash('sha256').update(JSON.stringify(outputs)).digest('hex');
  // Captured from the base before Dashboard message IDs with the same rows and path normalization.
  assert.equal(digest, '56c70f67f7c50d7ca9b1f1a80c948ba1a8e27eb54fd2b63d979d473bcb301b09');
  console.log('Channel formatting comparison:', JSON.stringify({ rows: rows.length, outputs: outputs.length * 2,
    referenceReads: reads, sha256: digest }));
});
