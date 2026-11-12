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
import { CONFIG_RECLAIM_PROMPT, PRE_RECLAIM_CHECK_PROMPT, UPGRADE_RESTART_CHECK_PROMPT } from '../reclaim-prompts.js';

const schedulerCli = fileURLToPath(new URL('../../../scheduler/scripts/cli.js', import.meta.url));
const ADD = /run node "([^"]+)" add "<[^"]+>" --in "<delay>" --json in this session/;
const LIST = /run node "([^"]+)" list --json and check this session group's tasks with status "pending"/;
const IDLE_REASON = 'This session group has been idle and will be reclaimed.';
const UPGRADE_REASON = 'This session group will be restarted for an upgrade.';
const CONFIG_REASON = 'The launch configuration changed and this session group will be restarted with it.';
const PROMPTS = { idle: PRE_RECLAIM_CHECK_PROMPT, upgrade: UPGRADE_RESTART_CHECK_PROMPT, config: CONFIG_RECLAIM_PROMPT };
// The shared check of waiting work, as it appears in the idle reclaim text.
const sharedCheck = PRE_RECLAIM_CHECK_PROMPT.slice(PRE_RECLAIM_CHECK_PROMPT.indexOf('check the actual current state'),
  PRE_RECLAIM_CHECK_PROMPT.indexOf('Then write the session handoff.'));

test('idle reclaim and eviction check text stays word for word the same', () => {
  assert.equal(PRE_RECLAIM_CHECK_PROMPT, 'This session group has been idle and will be reclaimed. Before acknowledging this control, check the actual current state of your in-progress work (for example a PR and its CI, replies you are waiting for from others, pending handoffs). '
    + 'If any work is still waiting on an external event, handle each such item before writing the session handoff. '
    + `First run node "${schedulerCli}" list --json and check this session group's tasks with status "pending" (their session_group_name is everything after the first colon of $ZYLOS_SESSION_GROUP, and is empty when it has no colon, as for Origin); if one already covers the same check, do not create another. `
    + 'If the item has already been waiting for more than a day without progress, do not schedule another wake-up for it; state this in the session handoff and tell the person responsible for it. '
    + `Otherwise create a one-time scheduled task that wakes this session group to check it: run node "${schedulerCli}" add "<self-contained instructions for the check>" --in "<delay>" --json in this session, without any --reply option, so the task is saved to this session group, and confirm it reports ok:true. `
    + 'Then write the session handoff. If nothing is waiting on an external event, acknowledge directly.');
});

test('upgrade check states its own reason and otherwise matches the idle check', () => {
  assert.ok(UPGRADE_RESTART_CHECK_PROMPT.startsWith(`${UPGRADE_REASON} `));
  assert.doesNotMatch(UPGRADE_RESTART_CHECK_PROMPT, /idle|reclaimed|launch configuration/);
  assert.equal(UPGRADE_RESTART_CHECK_PROMPT.slice(UPGRADE_REASON.length), PRE_RECLAIM_CHECK_PROMPT.slice(IDLE_REASON.length));
});

test('configuration restart prompt carries the check before the handoff and ready_for_config_reclaim', () => {
  assert.ok(CONFIG_RECLAIM_PROMPT.startsWith(`${CONFIG_REASON} `));
  assert.doesNotMatch(CONFIG_RECLAIM_PROMPT, /idle|upgrade|acknowledg/i);
  assert.ok(sharedCheck.length > 500);
  const check = CONFIG_RECLAIM_PROMPT.indexOf(sharedCheck);
  assert.ok(check > 0, 'the same check text, not a separate copy');
  const handoff = CONFIG_RECLAIM_PROMPT.indexOf('Then complete required background work and the session handoff', check + sharedCheck.length);
  const submit = CONFIG_RECLAIM_PROMPT.indexOf('submit ready_for_config_reclaim through the supervisor', handoff);
  assert.ok(handoff > check && submit > handoff, 'check, then handoff, then readiness');
  assert.ok(CONFIG_RECLAIM_PROMPT.endsWith('After acceptance, finish this control and the current turn.'));
});

test('check prompt asks to verify waiting work, leave a wake-up and handoff, or acknowledge directly', () => {
  for (const phrase of ['idle and will be reclaimed', 'Before acknowledging this control', 'acknowledge directly']) {
    assert.ok(PRE_RECLAIM_CHECK_PROMPT.includes(phrase), phrase);
  }
  for (const [name, prompt] of Object.entries(PROMPTS)) {
    for (const phrase of ['actual current state', 'CI', 'waiting for from others', 'pending handoffs', 'waiting on an external event',
      'one-time scheduled task', 'wakes this session group', 'ok:true', 'session handoff']) {
      assert.ok(prompt.includes(phrase), `${name}: ${phrase}`);
    }
    assert.doesNotMatch(prompt, /--reply-(channel|endpoint|session-group) /);
    const [, cli] = prompt.match(ADD) ?? [];
    assert.equal(cli, schedulerCli, name);
  }
  assert.ok(fs.statSync(schedulerCli).isFile());
});

test('check prompt reuses a pending task of this group instead of creating another', () => {
  for (const [name, prompt] of Object.entries(PROMPTS)) {
    const [, cli] = prompt.match(LIST) ?? [];
    assert.equal(cli, schedulerCli, name);
    for (const phrase of ['session_group_name is everything after the first colon of $ZYLOS_SESSION_GROUP',
      'empty when it has no colon, as for Origin', 'if one already covers the same check, do not create another']) {
      assert.ok(prompt.includes(phrase), `${name}: ${phrase}`);
    }
    assert.ok(prompt.search(LIST) < prompt.search(ADD), `${name}: list comes before add`);
  }
});

test('check prompt stops renewing wake-ups for work stalled over a day and hands it to its owner', () => {
  for (const [name, prompt] of Object.entries(PROMPTS)) {
    const stop = prompt.indexOf('already been waiting for more than a day without progress');
    assert.ok(stop >= 0, name);
    for (const phrase of ['do not schedule another wake-up for it', 'state this in the session handoff',
      'tell the person responsible for it']) {
      assert.ok(prompt.indexOf(phrase) > stop, `${name}: ${phrase}`);
    }
    assert.ok(stop < prompt.search(ADD), `${name}: the stop rule applies before a new task is created`);
  }
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
