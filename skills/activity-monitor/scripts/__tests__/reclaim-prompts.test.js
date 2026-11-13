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
import { CONFIG_RECLAIM_PROMPT, PRE_RECLAIM_CHECK_PROMPT, SINGLE_UPGRADE_RESTART_CHECK_PROMPT, UPGRADE_RESTART_CHECK_PROMPT } from '../reclaim-prompts.js';

const schedulerCli = fileURLToPath(new URL('../../../scheduler/scripts/cli.js', import.meta.url));
const requestCli = fileURLToPath(new URL('../supervisor-request.js', import.meta.url));
const ADD = /Otherwise run `node "([^"]+)" add "<self-contained check>" --in "<delay>" --json` in this session/;
const LIST = /First run `node "([^"]+)" list --json`/;
const PROMPTS = { idle: PRE_RECLAIM_CHECK_PROMPT, upgrade: UPGRADE_RESTART_CHECK_PROMPT,
  config: CONFIG_RECLAIM_PROMPT, singleUpgrade: SINGLE_UPGRADE_RESTART_CHECK_PROMPT };

// Exact approved reclaim wording; installed CLI paths are the only substitutions.
const approvedIdle = `This session group has been idle and will be reclaimed. During this check, do not send messages to anyone.

1. Only one thing can hold the reclaim: work this session itself started that is still running and whose result it is waiting for — a background command, a Monitor watcher, a background subagent or workflow. If there is such work, run \`node "${requestCli}" defer-reclaim --reason "<what is still running>"\`, confirm it reports ok:true, then acknowledge this control.
2. Otherwise write the session handoff: list open business items as they stand now, checking each against its current record and leaving out any that have finished. Replies, reviews or decisions you are waiting for from people or other sessions need nothing more: an incoming reply wakes this group again.
3. Create a wake-up only for a step of your own ongoing task that waits on an external system whose result will not arrive as a message to this group (for example CI on a PR you opened, or a deployment rolling out). First run \`node "${schedulerCli}" list --json\`; if a pending task of this group already covers it, do not create another. Otherwise run \`node "${schedulerCli}" add "<self-contained check>" --in "<delay>" --json\` in this session without any --reply option, and confirm it reports ok:true. Do not create scheduled tasks for anything else.

Then acknowledge.`;

test('idle reclaim and capacity eviction use the approved narrow check', () => {
  assert.equal(PRE_RECLAIM_CHECK_PROMPT, approvedIdle);
  assert.ok(fs.statSync(requestCli).isFile());
});

test('restart checks describe interrupted background work without offering deferral', () => {
  for (const [name, prompt] of Object.entries(PROMPTS).filter(([name]) => name !== 'idle')) {
    assert.ok(prompt.includes('it will be interrupted by this restart: name it in the session handoff so the next session can rerun or check it.'), name);
    assert.doesNotMatch(prompt, /defer-reclaim|Only one thing can hold the reclaim/, name);
    assert.equal(prompt.slice(prompt.indexOf('2. '), prompt.indexOf('\n\nThen')),
      approvedIdle.slice(approvedIdle.indexOf('2. '), approvedIdle.indexOf('\n\nThen')), name);
  }
  assert.ok(UPGRADE_RESTART_CHECK_PROMPT.startsWith('This session group will be restarted for an upgrade.'));
  assert.ok(SINGLE_UPGRADE_RESTART_CHECK_PROMPT.startsWith('This session will be restarted for an upgrade.'));
  assert.ok(SINGLE_UPGRADE_RESTART_CHECK_PROMPT.includes('$ZYLOS_SESSION_GROUP is unset.'));
  assert.ok(CONFIG_RECLAIM_PROMPT.startsWith('The launch configuration changed and this session group will be restarted with it.'));
  assert.ok(CONFIG_RECLAIM_PROMPT.endsWith('Then submit ready_for_config_reclaim through the supervisor. After acceptance, finish this control and the current turn.'));
});

test('all checks prohibit messages and require current-record handoff without completed items', () => {
  for (const [name, prompt] of Object.entries(PROMPTS)) {
    for (const phrase of ['During this check, do not send messages to anyone.', 'checking each against its current record',
      'leaving out any that have finished', 'an incoming reply wakes this group again']) {
      assert.ok(prompt.includes(phrase), `${name}: ${phrase}`);
    }
    assert.doesNotMatch(prompt, /more than a day|tell the person responsible|handle each such item/);
  }
});

test('wake-ups are limited to own tasks waiting on systems that do not message the group', () => {
  for (const [name, prompt] of Object.entries(PROMPTS)) {
    assert.ok(prompt.includes('only for a step of your own ongoing task'), name);
    assert.ok(prompt.includes('whose result will not arrive as a message to this group'), name);
    assert.ok(prompt.includes('Do not create scheduled tasks for anything else.'), name);
    assert.ok(prompt.includes('if a pending task of this group already covers it, do not create another'), name);
    assert.ok(prompt.search(LIST) < prompt.search(ADD), name);
    assert.equal(prompt.match(LIST)?.[1], schedulerCli, name);
    assert.equal(prompt.match(ADD)?.[1], schedulerCli, name);
    assert.ok(prompt.includes('without any --reply option, and confirm it reports ok:true.'), name);
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
  assert.deepEqual([SINGLE_UPGRADE_RESTART_CHECK_PROMPT.match(ADD)[1], SINGLE_UPGRADE_RESTART_CHECK_PROMPT.match(LIST)[1]], [addCli, listCli]);
  const run = (cli, args, group) => {
    const env = { PATH: process.env.PATH, HOME: root, ZYLOS_DIR: root, TMPDIR: root, PM2_HOME: path.join(root, '.pm2'), TZ: 'UTC',
      ...(group === undefined ? {} : { ZYLOS_SESSION_GROUP: group }) };
    for (const key of ['HOME', 'ZYLOS_DIR', 'TMPDIR', 'PM2_HOME']) {
      assert.ok(env[key] === root || env[key].startsWith(root + path.sep), `${key} is private: ${env[key]}`);
    }
    if (args[0] === 'add') console.log(JSON.stringify({ cli, args, HOME: env.HOME, ZYLOS_DIR: env.ZYLOS_DIR, PM2_HOME: env.PM2_HOME, TMPDIR: env.TMPDIR, tmux: 'unused', database: path.join(root, 'scheduler/scheduler.db') }));
    const result = spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  // undefined: the single session, which has no ZYLOS_SESSION_GROUP; its task, like Origin's, has no group.
  const cases = [['tg:g-1', ['telegram', 'g-1']], ['tg:g:2', ['telegram', 'g:2']], ['origin', [null, null]], [undefined, [null, null]]];
  const created = [];
  for (const [group, expected] of cases) {
    const answer = run(addCli, ['add', `Check PR CI for ${group ?? 'single'}`, '--in', '30 minutes', '--json'], group);
    assert.equal(answer.ok, true);
    const [task] = run(listCli, ['list', '--json'], group).filter(row => row.prompt === `Check PR CI for ${group ?? 'single'}`);
    assert.deepEqual([task.session_component, task.session_group_name], expected);
    assert.equal(task.status, 'pending'); assert.equal(task.type, 'one-time'); assert.equal(task.reply_channel, null);
    created.push(task.id);
  }
  assert.equal(new Set(created).size, cases.length);
  assert.equal(run(listCli, ['list', '--json'], 'origin').length, cases.length);
  assert.ok(fs.existsSync(path.join(root, 'scheduler/scheduler.db')));
});
