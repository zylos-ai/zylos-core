import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as source from '../dashboard-source.js';
import { formatConversation } from '../router/format.js';
import { formatConversationsForAgent, getDb, close } from '../c4-db.js';
import { fixture } from './c4-v2-test-helpers.js';
import { buildAnnotatedContent, splitContentAndAttachments } from '../attachment-annotations.js';
import { CONTENT_PREFIX } from '../c4-content-schema.js';
import { DB_PATH } from '../c4-config.js';
import { SKILLS_DIR } from '../c4-config.js';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const home = fs.realpathSync(process.env.HOME), deployment = fs.realpathSync(process.env.ZYLOS_DIR);
assert.notEqual(home, fs.realpathSync(os.userInfo().homedir));
assert.ok(deployment.startsWith(home + path.sep));
for (const key of ['PM2_HOME', 'TMPDIR']) assert.ok(path.resolve(process.env[key]).startsWith(path.dirname(home) + path.sep));
assert.ok(DB_PATH.startsWith(deployment + path.sep));
console.log('Quote Core isolation:', JSON.stringify({ HOME: home, ZYLOS_DIR: deployment,
  PM2_HOME: process.env.PM2_HOME, TMPDIR: process.env.TMPDIR, database: DB_PATH, runtime: 'not launched' }));

const current = { id: 50, direction: 'in', channel: 'dashboard', endpoint_id: 'dialog',
  session_group: 'dashboard:dialog', content: '[quote c4_id=10]\nNew <words> & "quotes"' };
const original = { ...current, id: 10, direction: 'out', content: 'Original <words> & "quotes"' };
const options = lookupQuote => ({ row: current, lookupQuote });

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
  const normalize = text => text.replaceAll(SKILLS_DIR, '$SKILLS').replaceAll(scripts, '$CORE_SCRIPTS');
  const outputs = rows.map(row => ({
    live: normalize(formatConversation(row, { ownerName: () => 'Owner', lookupQuote })),
    replay: normalize(formatConversationsForAgent([row], { spill: false, ownerName: () => 'Owner', lookupQuote })),
  }));
  assert.equal(reads, 0);
  for (const row of rows.filter(row => row.channel === 'dashboard' && row.direction === 'in')) {
    source.resolveDashboardQuote?.(row, { prepare() { reads++; throw new Error('Unexpected database read'); } });
  }
  assert.equal(reads, 0);
  const digest = createHash('sha256').update(JSON.stringify(outputs)).digest('hex');
  // Captured from the untouched base with the same rows and path normalization.
  assert.equal(digest, '56c70f67f7c50d7ca9b1f1a80c948ba1a8e27eb54fd2b63d979d473bcb301b09');
  console.log('Channel formatting comparison:', JSON.stringify({ rows: rows.length, outputs: outputs.length * 2,
    referenceReads: reads, sha256: digest }));
});

test('Dashboard quote is escaped between provenance and current text with the original sender', () => {
  for (const [extra, sender, text] of [
    [{}, 'AI', original.content],
    [{ direction: 'in' }, 'A&B', original.content],
    [{ channel: 'internal', direction: 'in', endpoint_id: 'peer:session',
      content: '[internal] peer:session said: Internal text' }, 'peer:session', 'Internal text'],
    [{ channel: 'internal', endpoint_id: 'peer:out' }, 'AI', original.content],
  ]) {
    const row = { ...original, ...extra };
    const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    const output = source.dashboardSource(current.content, 'A&B', options(() => row));
    assert.equal(output, `[Dashboard]\n<replying-to>\n[${escape(sender)}]: ${escape(text)}\n</replying-to>\n\n<current-message>\nA&amp;B said: New &lt;words&gt; &amp; "quotes"\n</current-message>`);
  }
});

test('Dashboard quote resolves only earlier same-group rows and otherwise keeps the literal marker', t => {
  const f = fixture(t);
  f.db.prepare(`INSERT INTO conversations(id,direction,channel,endpoint_id,session_group,content)
    VALUES(10,'out','dashboard','dialog','dashboard:dialog','Original')`).run();
  const lookupQuote = row => source.resolveDashboardQuote(row, f.db);
  assert.ok(source.dashboardSource(current.content, 'Owner', options(lookupQuote)).includes('[AI]: Original'));
  for (const row of [
    { ...current, id: 10 }, { ...current, id: 9 },
    { ...current, session_group: 'dashboard:other' },
    { ...current, content: '[quote c4_id=999]\nNew' },
    { ...current, content: '[quote c4_id=0]\nNew' },
    { ...current, content: '[quote c4_id=9007199254740992]\nNew' },
    { ...current, content: 'Before\n[quote c4_id=10]\nNew' },
    { ...current, content: '[quote c4_id=10] trailing\nNew' },
  ]) {
    const output = source.dashboardSource(row.content, 'Owner', { row, lookupQuote });
    assert.equal(output.includes('<replying-to>'), false);
    assert.ok(output.includes(row.content.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')));
  }
  f.db.prepare('DELETE FROM conversations WHERE id=10').run();
  assert.ok(source.dashboardSource(current.content, 'Owner', options(lookupQuote)).includes(current.content.replaceAll('<', '&lt;').replaceAll('>', '&gt;').replace(' & ', ' &amp; ')));
});

test('Dashboard quoted text strips nested markers and attachment paths and truncates Unicode before escaping', () => {
  const oldFile = { kind: 'file', path: '/private/old.txt', name: 'old.txt', size: 1 };
  const newFile = { kind: 'file', path: '/private/new.txt', name: 'new.txt', size: 2 };
  const old = { ...original, content: buildAnnotatedContent('[quote c4_id=3]\nOld & text', [oldFile]) };
  const content = buildAnnotatedContent(current.content, [newFile]);
  const output = source.dashboardSource(content, 'Owner', options(() => old));
  assert.ok(output.includes('[AI]: Old &amp; text\n（附件：old.txt）'));
  assert.equal(output.includes('/private/old.txt'), false);
  assert.equal(output.includes('[quote c4_id='), false);
  assert.ok(output.indexOf('[attachment:file') > output.indexOf('</current-message>'));
  const attachments = splitContentAndAttachments(output).attachments;
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0].name, 'new.txt');
  const long = source.dashboardSource(current.content, 'Owner', options(() => ({ ...original, content: '😀'.repeat(4001) })));
  assert.ok(long.includes('😀'.repeat(4000) + '……（已截断，全文见 c4_id=10）'));
  assert.equal(Array.from(long).filter(char => char === '😀').length, 4000);
  const exact = source.dashboardSource(current.content, 'Owner', options(() => ({ ...original, content: '😀'.repeat(4000) })));
  assert.ok(exact.includes('[AI]: ' + '😀'.repeat(4000) + '\n</replying-to>'));
  assert.equal(exact.includes('已截断'), false);
  const envelope = { version: 1, kind: 'message', messageId: 'quote', fallbackText: 'Human text',
    blocks: [{ id: 'text', type: 'markdown', schemaVersion: 1, data: { text: 'Human text' } }] };
  const structured = source.dashboardSource(current.content, 'Owner', options(() => ({ ...original, content: CONTENT_PREFIX + JSON.stringify(envelope) })));
  assert.ok(structured.includes('[AI]: Human text\n</replying-to>'));
});

// Real Core DB + both production formatting entrypoints, within runner-owned
// HOME/ZYLOS_DIR/PM2_HOME/TMPDIR. No runtime, socket or model is started.
// Run when Dashboard quote delivery or startup replay changes; skip UI-only work.
test('Dashboard realtime and startup replay resolve the same database quote without changing storage', t => {
  const { db } = fixture(t);
  const inserted = db.prepare(`INSERT INTO conversations(direction,channel,endpoint_id,session_group,content)
    VALUES('out','dashboard','dialog','dashboard:dialog','Original')`).run();
  const originalId = Number(inserted.lastInsertRowid);
  const row = { ...current, id: originalId + 1, content: `[quote c4_id=${originalId}]\nNew <words> & "quotes"` };
  const lookupQuote = row => source.resolveDashboardQuote(row, db);
  const realtime = formatConversation(row, { ownerName: () => 'Owner', lookupQuote });
  const replay = formatConversationsForAgent([row], { spill: false, ownerName: () => 'Owner', lookupQuote });
  const expected = '[Dashboard]\n<replying-to>\n[AI]: Original\n</replying-to>\n\n<current-message>\nOwner said: New &lt;words&gt; &amp; "quotes"\n</current-message>';
  assert.ok(realtime.startsWith(expected));
  assert.ok(replay.includes(expected));
  assert.equal(db.prepare('SELECT content FROM conversations WHERE id=?').get(originalId).content, 'Original');
  assert.equal(row.content, `[quote c4_id=${originalId}]\nNew <words> & "quotes"`);
});

// Uses the production singleton DB under the verified runner-owned HOME and
// compares live delivery with startup's default resolver, including fallback.
// Run for quote lookup/sender/startup changes; skip unrelated frontend work.
test('Startup default quote lookup matches live delivery for both internal directions and rejects unavailable targets', t => {
  const db = getDb(), group = `dashboard:quote-${randomUUID()}`;
  assert.equal(fs.realpathSync(DB_PATH), DB_PATH);
  t.after(() => {
    try { db.prepare('DELETE FROM conversations WHERE session_group IN (?,?)').run(group, `${group}:other`); }
    finally { close(); }
  });
  const insert = db.prepare(`INSERT INTO conversations(direction,channel,endpoint_id,session_group,content)
    VALUES(?,?,?,?,?)`);
  for (const [direction, sender, content] of [
    ['in', 'peer:session', '[internal] peer:session said: Incoming internal'],
    ['out', 'AI', 'Outgoing internal'],
  ]) {
    const targetId = Number(insert.run(direction, 'internal', 'peer:session', group, content).lastInsertRowid);
    const body = `[quote c4_id=${targetId}]\nCurrent words`;
    const id = Number(insert.run('in', 'dashboard', 'dialog', group, body).lastInsertRowid);
    const row = db.prepare('SELECT * FROM conversations WHERE id=?').get(id);
    const live = () => formatConversation(row, { ownerName: () => 'Owner',
      lookupQuote: value => source.resolveDashboardQuote(value, db) });
    const replay = () => formatConversationsForAgent([row], { spill: false, ownerName: () => 'Owner' });
    const text = direction === 'in' ? 'Incoming internal' : 'Outgoing internal';
    const expected = `[Dashboard]\n<replying-to>\n[${sender}]: ${text}\n</replying-to>\n\n<current-message>\nOwner said: Current words\n</current-message>`;
    assert.ok(live().startsWith(expected));
    assert.ok(replay().includes(expected));
    db.prepare('UPDATE conversations SET session_group=? WHERE id=?').run(`${group}:other`, targetId);
    for (const output of [live(), replay()]) {
      assert.equal(output.includes('<replying-to>'), false);
      assert.ok(output.includes(body));
    }
    db.prepare('DELETE FROM conversations WHERE id=?').run(targetId);
    for (const output of [live(), replay()]) {
      assert.equal(output.includes('<replying-to>'), false);
      assert.ok(output.includes(body));
    }
    assert.equal(db.prepare('SELECT content FROM conversations WHERE id=?').get(id).content, body);
  }
});
