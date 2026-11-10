import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from '../../skills/comm-bridge/scripts/sqlite-driver.js';
import { guardDatabase } from '../../skills/comm-bridge/scripts/sqlite-schema.js';
import * as schedulerSchema from '../../skills/scheduler/scripts/schema.js';
import * as c4Schema from '../../skills/comm-bridge/scripts/c4-schema.js';
import { queryComponentSessionGroup } from '../../skills/comm-bridge/scripts/c4-component-session-group.js';
import { sendViaC4 } from '../../skills/scheduler/scripts/runtime.js';

const cli = fileURLToPath(new URL('../../skills/scheduler/scripts/cli.js', import.meta.url));
const receiver = fileURLToPath(new URL('../../skills/comm-bridge/scripts/c4-receive.js', import.meta.url));
const script = fileURLToPath(new URL('../fixtures/scheduler-group-query.js', import.meta.url));

// Real CLI/query/receiver fixture. No PM2, tmux, runtime or external sender is
// launched; the absent AM socket is private and C4's fallback is local only.
export function schedulerQueryFixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sq-')));
  const home = path.join(root, 'home'), zylos = path.join(root, 'instance');
  const tmp = path.join(root, 'tmp'), pm2 = path.join(root, 'pm2');
  const skills = path.join(zylos, '.claude/skills');
  for (const directory of [home, tmp, pm2, path.join(zylos, '.zylos'), path.join(zylos, 'scheduler'),
    path.join(zylos, 'comm-bridge'), path.join(zylos, 'activity-monitor'), skills]) fs.mkdirSync(directory, { recursive: true });
  for (const component of ['telegram', 'dashboard', 'lark']) {
    const scripts = path.join(skills, component, 'scripts');
    fs.mkdirSync(scripts, { recursive: true });
    // Status-notice transport terminates locally; it never contacts a platform.
    fs.writeFileSync(path.join(scripts, 'send.js'), 'process.exit(0);\n');
  }
  fs.writeFileSync(path.join(zylos, '.env'), 'TZ=UTC\n');
  fs.writeFileSync(path.join(zylos, '.zylos/config.json'), JSON.stringify({ runtime: 'claude', session_mode: 'multi' }));
  const env = { ...process.env, HOME: home, ZYLOS_DIR: zylos, PM2_HOME: pm2, TMPDIR: tmp, TMUX_TMPDIR: tmp, TZ: 'UTC',
    ZYLOS_PACKAGE_ROOT: fileURLToPath(new URL('../../', import.meta.url)),
    PATH: path.dirname(process.execPath) + path.delimiter + process.env.PATH };
  for (const key of ['TMUX', 'TMUX_PANE', 'ZYLOS_SESSION_GROUP', 'ZYLOS_RUN_ID', 'CLAUDE_SESSION_ID', 'CODEX_SESSION_ID']) delete env[key];
  const database = path.join(zylos, 'scheduler/scheduler.db'), messages = path.join(zylos, 'comm-bridge/c4.db');
  const amSocket = path.join(zylos, 'activity-monitor/am.sock');
  for (const target of [env.HOME, env.ZYLOS_DIR, env.PM2_HOME, env.TMPDIR, env.TMUX_TMPDIR, database, messages, amSocket]) assert.ok(target.startsWith(root + path.sep));
  assert.ok(Buffer.byteLength(amSocket) < 100);
  console.log('Scheduler query isolation:', JSON.stringify({ HOME: home, ZYLOS_DIR: zylos, PM2_HOME: pm2,
    TMPDIR: tmp, TMUX_TMPDIR: tmp, ZYLOS_PACKAGE_ROOT: env.ZYLOS_PACKAGE_ROOT, node: process.execPath, database, messages, amSocket, tmux: 'not launched', pm2: 'not launched' }));
  const db = new Database(database); guardDatabase(db, schedulerSchema); db.pragma('journal_mode=WAL');
  const c4 = new Database(messages); guardDatabase(c4, c4Schema); c4.pragma('journal_mode=WAL');
  t.after(() => { c4.close(); db.close(); fs.rmSync(root, { recursive: true, force: true }); assert.equal(fs.existsSync(root), false); });
  const calls = path.join(root, 'query-calls.jsonl');
  const install = (answers = {}, component = 'telegram', fallback = { output: '' }) => {
    const directory = path.join(skills, component);
    fs.writeFileSync(path.join(directory, 'package.json'), '{"type":"module"}');
    fs.copyFileSync(script, path.join(directory, 'scripts/session-group.js'));
    fs.writeFileSync(path.join(directory, 'query.json'), JSON.stringify({ answers, calls, default: fallback }));
  };
  const queries = () => fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const run = args => spawnSync(process.execPath, [cli, ...args, '--json'], { env, encoding: 'utf8', timeout: 15000, maxBuffer: 65536 });
  const cliData = args => { const result = run(args); assert.equal(result.status, 0, result.stderr || result.stdout); return JSON.parse(result.stdout).data; };
  const add = (extra = []) => cliData(['add', 'private query task', '--in', '1 hour', ...extra]).task;
  const read = id => db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
  const history = id => db.prepare('SELECT * FROM task_history WHERE task_id=? ORDER BY id').all(id);
  const legacy = (extra = {}) => {
    const task = add(); const changes = { reply_channel: 'telegram', reply_endpoint: 'chat-old', ...extra };
    db.prepare(`UPDATE tasks SET ${Object.keys(changes).map(key => key + '=?').join(',')} WHERE id=?`).run(...Object.values(changes), task.id);
    return read(task.id);
  };
  const query = target => queryComponentSessionGroup(target, { skillsDir: skills, env });
  const send = (message, options) => sendViaC4(message, options, { receivePath: receiver,
    execute: (command, args, settings) => execFileSync(command, args, { ...settings, env }) });
  const deps = { query, getRecentConversations: () => [], getConversationsByRange: () => [], sendViaC4: send };
  return { root, env, db, c4, skills, install, queries, run, cliData, add, read, history, legacy, query, send, deps };
}
