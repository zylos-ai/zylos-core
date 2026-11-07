import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { migrateDatabase, TARGET_SCHEMA_VERSION } from '../src/lib/schema.js';
import { registerQuestion } from '../src/lib/chat/questions.js';
import { recordQuestionControl } from '../src/lib/chat/question-controls.js';

const fixtures = JSON.parse(fs.readFileSync(new URL('../../../test/fixtures/c4-content-protocol.json', import.meta.url), 'utf8'));
const row = name => ({ id: name === 'single' ? 1 : 2, session_group: 'dashboard:mine', endpoint_id: 'mine',
  content: fixtures.valid.find(item => item.name === name).content });
const operations = { question: registerQuestion, control: recordQuestionControl };
const input = kind => row(kind === 'question' ? 'single' : 'stop');

// Boundary: real registration/control modules and private SQLite files only.
// Run for channel database opening/inspection changes; UI-only edits may skip.
// The official runner isolates HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR. No service,
// child, tmux, PM2 or network is started; every owned handle and file is cleaned.
function fixture(t, { create = true, parent = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-schema-'));
  const env = { HOME: path.join(root, 'home'), ZYLOS_DIR: path.join(root, 'instance') };
  const file = path.join(env.ZYLOS_DIR, 'components/dashboard/dashboard.db');
  let db;
  t.after(() => { db?.close(); fs.rmSync(root, { recursive: true, force: true }); });
  assert.ok(file.startsWith(root + path.sep));
  if (parent) fs.mkdirSync(path.dirname(file), { recursive: true });
  if (create) { db = new Database(file); migrateDatabase(db); }
  return { root, env, file, db };
}
const count = (db, table) => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)
  ? db.prepare(`SELECT count(*) FROM ${table}`).pluck().get() : 0;
const layout = db => db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all()
  .map(item => JSON.stringify(item)).join('\n');

for (const kind of ['question', 'control']) {
  for (const state of ['old', 'newer', 'invalid current']) {
    test(`${kind} registration rejects ${state} schema without migrating or writing`, t => {
      const f = fixture(t);
      if (kind === 'control') registerQuestion(row('single'), { env: f.env });
      if (state === 'old') {
        // Version 25 introduced these three tables; removing them reconstructs
        // the pre-answer layout while retaining the earlier question table.
        f.db.exec('DROP TABLE chat_answers; DROP TABLE chat_answer_deliveries; DROP TABLE chat_question_controls; DELETE FROM schema_migrations WHERE version>24');
      } else if (state === 'newer') {
        f.db.prepare('INSERT INTO schema_migrations(version) VALUES(?)').run(TARGET_SCHEMA_VERSION + 1);
      } else f.db.exec('DROP INDEX idx_chat_answers_group');
      const before = { version: f.db.prepare('SELECT MAX(version) FROM schema_migrations').pluck().get(),
        layout: layout(f.db), questions: count(f.db, 'chat_questions'), controls: count(f.db, 'chat_question_controls'),
        dataVersion: f.db.pragma('data_version', { simple: true }) };
      assert.throws(() => operations[kind](input(kind), { env: f.env }), error => {
        assert.equal(error.code, kind === 'question' ? 'QUESTION_REGISTRATION_FAILED' : 'QUESTION_CONTROL_FAILED');
        if (kind === 'question') assert.match(error.message, /existing C4 reference without resending/);
        else { assert.equal(error.storedControlFailure, true); assert.match(error.message, /complete the upgrade or restart Dashboard/); }
        return true;
      });
      assert.equal(f.db.prepare('SELECT MAX(version) FROM schema_migrations').pluck().get(), before.version);
      assert.equal(layout(f.db), before.layout);
      assert.equal(count(f.db, 'chat_questions'), before.questions);
      assert.equal(count(f.db, 'chat_question_controls'), before.controls);
      assert.equal(f.db.pragma('data_version', { simple: true }), before.dataVersion);
      if (kind === 'control') assert.equal(f.db.prepare('SELECT status FROM chat_questions').pluck().get(), 'paused');
    });
  }
  for (const parent of [false, true]) {
    test(`${kind} registration with a missing database preserves ${parent ? 'existing' : 'absent'} directories`, t => {
      const f = fixture(t, { create: false, parent });
      const before = fs.readdirSync(f.root, { recursive: true });
      assert.throws(() => operations[kind](input(kind), { env: f.env }), error => {
        assert.equal(error.code, kind === 'question' ? 'QUESTION_REGISTRATION_FAILED' : 'QUESTION_CONTROL_FAILED');
        if (kind === 'control') assert.equal(error.storedControlFailure, true);
        return true;
      });
      assert.equal(fs.existsSync(f.file), false);
      assert.deepEqual(fs.readdirSync(f.root, { recursive: true }), before);
    });
  }
}

test('current schema registers questions and controls with original idempotent behavior', t => {
  const f = fixture(t);
  const original = registerQuestion(row('single'), { env: f.env });
  assert.equal(original.status, 'paused'); assert.equal(original.c4_id, '1');
  assert.equal(registerQuestion(row('single'), { env: f.env }).c4_id, '1');
  assert.equal(count(f.db, 'chat_questions'), 1);
  recordQuestionControl(row('stop'), { env: f.env });
  recordQuestionControl(row('stop'), { env: f.env });
  assert.equal(f.db.prepare('SELECT status FROM chat_questions').pluck().get(), 'stopped');
  assert.equal(count(f.db, 'chat_question_controls'), 1);
  assert.equal(f.db.prepare('SELECT MAX(version) FROM schema_migrations').pluck().get(), TARGET_SCHEMA_VERSION);
});
