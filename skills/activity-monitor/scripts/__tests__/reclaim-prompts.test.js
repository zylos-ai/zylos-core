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
const ADD = /run node "([^"]+)" add "<[^"]+>" --in "<delay>" --json in this session/;
const LIST = /run node "([^"]+)" list --json and check this session group's tasks with status "pending"/;

test('check prompt asks to verify waiting work, leave a wake-up and handoff, or acknowledge directly', () => {
  for (const phrase of ['idle and will be reclaimed', 'Before acknowledging this control',
    'actual current state', 'CI', 'waiting for from others', 'pending handoffs', 'waiting on an external event',
    'one-time scheduled task', 'wakes this session group', 'ok:true', 'write the session handoff', 'acknowledge directly']) {
    assert.ok(PRE_RECLAIM_CHECK_PROMPT.includes(phrase), phrase);
  }
  assert.doesNotMatch(PRE_RECLAIM_CHECK_PROMPT, /--reply-(channel|endpoint|session-group) /);
  const [, cli] = PRE_RECLAIM_CHECK_PROMPT.match(ADD) ?? [];
  assert.equal(cli, schedulerCli);
  assert.ok(fs.statSync(cli).isFile());
});

test('check prompt reuses a pending task of this group instead of creating another', () => {
  const [, cli] = PRE_RECLAIM_CHECK_PROMPT.match(LIST) ?? [];
  assert.equal(cli, schedulerCli);
  for (const phrase of ['session_group_name is everything after the first colon of $ZYLOS_SESSION_GROUP',
    'empty when it has no colon, as for Origin', 'if one already covers the same check, do not create another']) {
    assert.ok(PRE_RECLAIM_CHECK_PROMPT.includes(phrase), phrase);
  }
  assert.ok(PRE_RECLAIM_CHECK_PROMPT.search(LIST) < PRE_RECLAIM_CHECK_PROMPT.search(ADD), 'list comes before add');
});

test('check prompt stops renewing wake-ups for work stalled over a day and hands it to its owner', () => {
  const stop = PRE_RECLAIM_CHECK_PROMPT.indexOf('already been waiting for more than a day without progress');
  assert.ok(stop >= 0);
  for (const phrase of ['do not schedule another wake-up for it', 'state this in the session handoff',
    'tell the person responsible for it']) {
    assert.ok(PRE_RECLAIM_CHECK_PROMPT.indexOf(phrase) > stop, phrase);
  }
  assert.ok(stop < PRE_RECLAIM_CHECK_PROMPT.search(ADD), 'the stop rule applies before a new task is created');
});

// Boundary: the prompt's own scheduler commands against the real scheduler CLI and a private
// ZYLOS_DIR/HOME/TMPDIR (no service, tmux or live database). Run when the check prompt or the
// scheduler's add/list/session-group binding changes; other changes may skip it.
test('scheduler commands written in the check prompt save and list the task under the session group they run in', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reclaim-check-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.claude/skills/telegram'), { recursive: true });
  fs.mkdirSync(path.join(root, 'comm-bridge'));
  const c4 = new Database(path.join(root, 'comm-bridge/c4.db'));
  t.after(() => c4.close());
  migrateDatabase(c4, c4Schema, { allowNew: true });
  createStore(() => c4, { validateComponent: () => true }).registerChannelNamespace('telegram', 'tg');
  const [, addCli] = PRE_RECLAIM_CHECK_PROMPT.match(ADD);
  const [, listCli] = PRE_RECLAIM_CHECK_PROMPT.match(LIST);
  const run = (cli, args, group) => {
    const env = { PATH: process.env.PATH, HOME: root, ZYLOS_DIR: root, TMPDIR: root, TZ: 'UTC', ZYLOS_SESSION_GROUP: group };
    const result = spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const cases = [['tg:g-1', ['telegram', 'g-1']], ['tg:g:2', ['telegram', 'g:2']], ['origin', [null, null]]];
  const created = [];
  for (const [group, expected] of cases) {
    const answer = run(addCli, ['add', `Check PR CI for ${group}`, '--in', '30 minutes', '--json'], group);
    assert.equal(answer.ok, true);
    const [task] = run(listCli, ['list', '--json'], group).filter(row => row.prompt === `Check PR CI for ${group}`);
    assert.deepEqual([task.session_component, task.session_group_name], expected);
    assert.equal(task.status, 'pending'); assert.equal(task.type, 'one-time'); assert.equal(task.reply_channel, null);
    created.push(task.id);
  }
  assert.equal(new Set(created).size, cases.length);
  assert.equal(run(listCli, ['list', '--json'], 'origin').length, cases.length);
  assert.ok(fs.existsSync(path.join(root, 'scheduler/scheduler.db')));
});
