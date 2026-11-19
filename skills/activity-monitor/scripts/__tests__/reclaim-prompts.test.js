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

const skillsDir = fileURLToPath(new URL('../../../', import.meta.url));
const checks = fs.readFileSync(new URL('../../references/session-checks.md', import.meta.url), 'utf8');
const normalized = checks.replace(/\s+/g, ' ');
const section = heading => {
  const from = normalized.indexOf(`## ${heading}`);
  const to = normalized.indexOf(' ## ', from + 3);
  assert.ok(from >= 0, `Missing section ${heading}`);
  return normalized.slice(from, to < 0 ? undefined : to);
};
// Installed commands in the reference resolve to this checkout's skills.
const installed = command => command.replace('~/zylos/.claude/skills/', skillsDir);
const ADD = /Otherwise run `node (\S+) add "<self-contained check>" --in "<delay>" --json` in this session/;
const LIST = /First run `node (\S+) list --json`/;
const PROMPTS = {
  'idle reclaim check': [PRE_RECLAIM_CHECK_PROMPT, 'This session group has been idle and will be reclaimed.'],
  'upgrade restart check': [UPGRADE_RESTART_CHECK_PROMPT, 'This session group will be restarted for an upgrade.'],
  'configuration restart check': [CONFIG_RECLAIM_PROMPT, 'The launch configuration changed and this session group will be restarted with it.'],
};

test('each check control states its reason and names its check in the activity-monitor reference', () => {
  for (const [check, [prompt, reason]] of Object.entries(PROMPTS)) {
    assert.equal(prompt, `${reason} Read references/session-checks.md in the activity-monitor skill and run its ${check} now.`);
    assert.ok(normalized.toLowerCase().includes(`**${check}**`), `${check} is described in the reference`);
    assert.doesNotMatch(prompt, /defer-reclaim|scheduler|handoff|send messages/, `${check} rules stay in the reference`);
  }
  assert.match(normalized, /In single-session mode it is the only session group and `\$ZYLOS_SESSION_GROUP` is unset\./);
});

test('every check prohibits messages and requires a current-record handoff without completed items', () => {
  assert.ok(normalized.includes('Run the named check now, following the steps below in order. During this check, do not send messages to anyone.'));
  assert.equal(section('2. Handoff'), '## 2. Handoff Otherwise write the session handoff: list open business items as they stand now, '
    + 'checking each against its current record and leaving out any that have finished. Replies, reviews or decisions you are waiting for '
    + 'from people or other sessions need nothing more: an incoming reply wakes this group again.');
  assert.doesNotMatch(normalized, /more than a day|tell the person responsible|handle each such item/);
});

test('only the idle reclaim check offers deferral; restart checks name interrupted work in the handoff', () => {
  const running = section('1. Running work');
  const [idle, restart] = running.split('- **Upgrade and configuration restart checks:**');
  assert.ok(idle.includes('**Idle reclaim check:** Only one thing can hold the reclaim: work this session itself started that is still running '
    + 'and whose result it is waiting for — a background command, a Monitor watcher, a background subagent or workflow. A Memory Sync is not '
    + 'such work: the supervisor already waits for it before reclaiming, so do not defer for it. If there is such work, run '
    + '`node ~/zylos/.claude/skills/activity-monitor/scripts/supervisor-request.js defer-reclaim --reason "<what is still running>"`, '
    + 'confirm it reports ok:true, then acknowledge this control.'));
  assert.equal(restart.trim(), 'If work this session itself started is still running (a background command, a Monitor watcher, a background '
    + 'subagent or workflow), it will be interrupted by this restart: name it in the session handoff so the next session can rerun or check it.');
  assert.equal(normalized.match(/defer-reclaim/g).length, 1);
  assert.ok(fs.statSync(installed('~/zylos/.claude/skills/activity-monitor/scripts/supervisor-request.js')).isFile());
  const finish = section('4. Finish');
  assert.ok(finish.includes('**Idle reclaim and upgrade restart checks:** Then acknowledge.'));
  assert.ok(finish.includes('**Configuration restart check:** Then submit ready_for_config_reclaim through the supervisor. '
    + 'After acceptance, finish this control and the current turn.'));
});

test('wake-ups are limited to own tasks waiting on systems that do not message the group', () => {
  const wake = section('3. Wake-ups');
  assert.ok(wake.includes('only for a step of your own ongoing task'));
  assert.ok(wake.includes('whose result will not arrive as a message to this group'));
  assert.ok(wake.includes('Do not create scheduled tasks for anything else.'));
  assert.ok(wake.includes('if a pending task of this group already covers it, do not create another'));
  assert.ok(wake.search(LIST) >= 0 && wake.search(LIST) < wake.search(ADD));
  assert.equal(wake.match(LIST)[1], '~/zylos/.claude/skills/scheduler/scripts/cli.js');
  assert.equal(wake.match(ADD)[1], '~/zylos/.claude/skills/scheduler/scripts/cli.js');
  assert.ok(wake.includes('without any --reply option, and confirm it reports ok:true.'));
});

// Boundary: the reference's own scheduler commands against the real scheduler CLI and a private
// ZYLOS_DIR/HOME/TMPDIR (no service, tmux or live database). Run when the check reference or the
// scheduler's add/list/session-group binding changes; other changes may skip it.
test('scheduler commands written in the check reference save and list the task under the session group they run in', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reclaim-check-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.claude/skills/telegram'), { recursive: true });
  fs.mkdirSync(path.join(root, 'comm-bridge'));
  const c4 = new Database(path.join(root, 'comm-bridge/c4.db'));
  t.after(() => c4.close());
  migrateDatabase(c4, c4Schema, { allowNew: true });
  createStore(() => c4, { validateComponent: () => true }).registerChannelNamespace('telegram', 'tg');
  const addCli = installed(normalized.match(ADD)[1]);
  const listCli = installed(normalized.match(LIST)[1]);
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
