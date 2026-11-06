import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixture as storeFixture } from '../../../comm-bridge/scripts/__tests__/c4-v2-test-helpers.js';
import { createModeSwitchConverter } from '../mode-switch-convert.js';
import { projectC4Content } from '../../../comm-bridge/scripts/c4-content-projection.js';
import { escapeText } from '../../../comm-bridge/scripts/c4-query-format.js';

const fixtures = JSON.parse(fs.readFileSync(new URL('../../../../test/fixtures/c4-content-protocol.json', import.meta.url), 'utf8'));
const envelope = structuredClone(fixtures.valid.find(item => item.name === 'markdown').envelope);
envelope.blocks[0].data.text = 'HOST_ONLY_HIDDEN_' + 'x'.repeat(1800);
envelope.fallbackText = 'readable conversion summary';
const marked = '[C4-CONTENT]\n' + JSON.stringify(envelope);
const damaged = '[C4-CONTENT]\n{"HOST_ONLY_DAMAGED":true';

// File/SQLite integration: real transition snapshot and converter, no coordinator,
// runtime, PM2, tmux or network. Runner owns isolated HOME/ZYLOS_DIR/PM2_HOME/short
// TMPDIR; all DB/files below this case root are checked before opening/writing.
// Run for conversion/projection/material-list changes; skip unrelated rendering.
// No background work; DB and files are cleaned on assertion failure or success.
for (const source of ['single', 'multi']) test(`${source} conversion projects every generated C4 material and leaves original records unchanged`, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'projected-convert-'));
  let testDb;
  t.after(() => { if (testDb?.open) testDb.close(); fs.rmSync(root, { recursive: true, force: true }); });
  assert.ok(root.startsWith(path.resolve(process.env.TMPDIR) + path.sep));
  const file = path.join(root, 'c4.db'); assert.ok(path.resolve(file).startsWith(root + path.sep));
  const { db, store } = storeFixture(t, {}, file); testDb = db;
  const rows = [], groups = source === 'single' ? ['legacy'] : ['a', 'b'];
  function add(direction, content, group, delivered = true) {
    const result = store.insertConversation(direction, 'demo', 'room-' + group, content, { groupName: group });
    if (direction === 'in' && delivered) db.prepare("UPDATE conversations SET status='delivered' WHERE id=?").run(result.id);
    if (source === 'single' && delivered) db.prepare("UPDATE conversations SET session_group='' WHERE id=?").run(result.id);
    const record = db.prepare('SELECT * FROM conversations WHERE id=?').get(result.id); rows.push(record); return record;
  }
  for (const group of groups) {
    for (const direction of ['in', 'out']) for (const content of [marked, damaged, 'ordinary\ntext \\ stays']) add(direction, content, group);
    add('in', marked, group, false); add('in', damaged, group, false); add('in', 'pending ordinary', group, false);
  }
  const memory = path.join(root, 'memory');
  const sourceDirs = source === 'single' ? [memory] : ['origin', ...groups.map(g => 'demo:' + g)].map(group => path.join(memory, 'session-groups', group));
  for (const dir of sourceDirs) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.md'), 'existing plain working state\n');
    fs.writeFileSync(path.join(dir, 'inbox.md'), 'existing plain inbox\n');
    fs.writeFileSync(path.join(dir, 'handoff.md'), 'existing plain handoff\n');
  }
  const { runId } = store.beginModeTransition(source, source === 'single' ? 'multi' : 'single');
  store.setDrainFence('*'); store.absorbForTransition(runId);
  const transition = store.getModeTransition({ runId });
  const original = db.prepare('SELECT id,content,status FROM conversations ORDER BY id').all();
  const absorbed = store.getAbsorbedConversations(runId);
  const convert = createModeSwitchConverter({ db: store, zylosDir: root });
  const result = convert(transition);
  const handoff = fs.readFileSync(result.handoff, 'utf8');
  const listed = handoff.split('\n').filter(line => line.startsWith('- material: ')).map(line => JSON.parse(line.slice(12)));
  assert.deepEqual(listed, result.materials);
  assert.ok(listed.length > groups.length);
  const exportRows = [];
  for (const material of listed) {
    assert.ok(path.resolve(material).startsWith(root + path.sep));
    const text = fs.readFileSync(material, 'utf8');
    assert.equal(text.includes('HOST_ONLY_'), false, material);
    assert.equal(text.includes('[C4-CONTENT]'), false, material);
    if (material.endsWith('.md') && text.startsWith('{')) {
      for (const line of text.trim().split('\n')) exportRows.push(JSON.parse(line));
    }
  }
  const expected = rows.filter(row => row.status === 'delivered');
  assert.equal(exportRows.length, expected.length);
  assert.deepEqual(exportRows.map(row => row.id).sort((a, b) => a - b), expected.map(row => row.id).sort((a, b) => a - b));
  for (const row of exportRows) {
    const raw = expected.find(item => item.id === row.id);
    assert.ok(raw, 'export must reference a delivered source row');
    assert.equal(row.content, projectC4Content(raw.content, { c4Id: raw.id }));
    assert.equal(row.direction, raw.direction);
  }
  const states = [];
  for (const scope of result.scopes) {
    const state = path.join(scope === '*' ? memory : path.join(memory, 'session-groups', scope), 'state.md');
    const text = fs.readFileSync(state, 'utf8'); states.push(text);
    assert.equal(text.includes('HOST_ONLY_'), false);
    assert.equal(text.includes('[C4-CONTENT]'), false);
  }
  const allStates = states.join('\n');
  for (const row of absorbed) assert.ok(allStates.includes(escapeText(projectC4Content(row.content, { c4Id: row.id }))), `absorbed #${row.id}`);
  assert.equal(handoff.includes('HOST_ONLY_'), false);
  assert.deepEqual(db.prepare('SELECT id,content,status FROM conversations ORDER BY id').all(), original);
  assert.deepEqual(store.getAbsorbedConversations(runId), absorbed);
});
