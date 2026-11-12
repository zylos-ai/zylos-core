import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from '../../../comm-bridge/scripts/sqlite-driver.js';
import * as c4Schema from '../../../comm-bridge/scripts/c4-schema.js';
import { migrateDatabase } from '../../../comm-bridge/scripts/sqlite-schema.js';
import { createStore } from '../../../comm-bridge/scripts/c4-v2-store.js';
import { PRE_RECLAIM_CHECK_PROMPT } from '../reclaim-prompts.js';

const schedulerCli = fileURLToPath(new URL('../../../scheduler/scripts/cli.js', import.meta.url));
const COMMAND = /run node "([^"]+)" add "<[^"]+>" --in "<delay>" --json in this session/;

test('check prompt asks to verify waiting work, leave a wake-up and handoff, or acknowledge directly', () => {
  for (const phrase of ['idle and will be reclaimed', 'Before acknowledging this control',
    'actual current state', 'CI', 'waiting for from others', 'pending handoffs', 'waiting on an external event',
    'one-time scheduled task', 'wakes this session group', 'ok:true', 'write the session handoff', 'acknowledge directly']) {
    assert.ok(PRE_RECLAIM_CHECK_PROMPT.includes(phrase), phrase);
  }
  assert.doesNotMatch(PRE_RECLAIM_CHECK_PROMPT, /--reply-(channel|endpoint|session-group) /);
  const [, cli] = PRE_RECLAIM_CHECK_PROMPT.match(COMMAND) ?? [];
  assert.equal(cli, schedulerCli);
  assert.ok(fs.statSync(cli).isFile());
});

// Boundary: the prompt's own scheduler command against the real scheduler CLI and a private
// ZYLOS_DIR/HOME (no service, tmux or live database). Run when the check prompt or the
// scheduler's add/session-group binding changes; other changes may skip it.
test('scheduler command written in the check prompt saves the task to the session group it runs in', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reclaim-check-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.claude/skills/telegram'), { recursive: true });
  fs.mkdirSync(path.join(root, 'comm-bridge'));
  const c4 = new Database(path.join(root, 'comm-bridge/c4.db'));
  t.after(() => c4.close());
  migrateDatabase(c4, c4Schema, { allowNew: true });
  createStore(() => c4, { validateComponent: () => true }).registerChannelNamespace('telegram', 'tg');
  const [, cli] = PRE_RECLAIM_CHECK_PROMPT.match(COMMAND);
  const read = () => {
    const db = new Database(path.join(root, 'scheduler/scheduler.db'));
    try { return db.prepare('SELECT * FROM tasks ORDER BY rowid').all(); } finally { db.close(); }
  };
  for (const [group, expected] of [['tg:g-1', ['telegram', 'g-1']], ['origin', [null, null]]]) {
    const env = { PATH: process.env.PATH, HOME: root, ZYLOS_DIR: root, TMPDIR: root, TZ: 'UTC', ZYLOS_SESSION_GROUP: group };
    const result = spawnSync(process.execPath, [cli, 'add', 'Check PR CI and pending replies', '--in', '30 minutes', '--json'],
      { env, encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).ok, true);
    const task = read().at(-1);
    assert.deepEqual([task.session_component, task.session_group_name], expected);
    assert.equal(task.reply_channel, null);
    assert.equal(task.type, 'one-time');
  }
  assert.ok(fs.existsSync(path.join(root, 'scheduler/scheduler.db')));
});
