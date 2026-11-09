import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import Database from '../../../comm-bridge/scripts/sqlite-driver.js';
import { guardDatabase } from '../../../comm-bridge/scripts/sqlite-schema.js';
import * as c4Schema from '../../../comm-bridge/scripts/c4-schema.js';
import { createStore } from '../../../comm-bridge/scripts/c4-v2-store.js';
import { Store } from '../../src/lib/store.js';

const dashboard = fileURLToPath(new URL('../../', import.meta.url));
const core = path.resolve(dashboard, '../..');
const observer = new URL('./channel-delivery-observer.js', import.meta.url).href;

// Installed product scripts + two private databases; no service/runtime/socket.
// Run for channel/hook dependency changes; unrelated UI changes may skip.
// All launches are synchronous with deadlines and cleanup belongs to this case.
export function setupChannelFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-channel-'));
  let c4Db, dashboardStore;
  t.after(() => { if (dashboardStore?.db.open) dashboardStore.close(); c4Db?.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const home = path.join(root, 'h'), zylos = path.join(root, 'instance');
  const skills = path.join(zylos, '.claude/skills'), tmp = path.join(root, 'tmp'), bin = path.join(root, 'bin');
  const dataDir = path.join(zylos, 'components/dashboard');
  const c4Path = path.join(zylos, 'comm-bridge/c4.db'), dashboardPath = path.join(dataDir, 'dashboard.db');
  for (const directory of [home, skills, tmp, bin, dataDir, path.dirname(c4Path), path.join(zylos, '.zylos')]) fs.mkdirSync(directory, { recursive: true });
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  fs.writeFileSync(path.join(zylos, '.zylos/config.json'), JSON.stringify({ runtime: 'codex', session_mode: 'multi' }));
  const env = { ...process.env, HOME: home, ZYLOS_DIR: zylos, PM2_HOME: path.join(root, 'pm2'), TMPDIR: tmp,
    TMUX_TMPDIR: tmp, PATH: bin, ZYLOS_PACKAGE_ROOT: core, ZYLOS_SESSION_GROUP: 'origin', ZYLOS_DATA_DIR: dataDir,
    CHANNEL_SEND_LOG: path.join(root, 'sends'), CHANNEL_HTTP_LOG: path.join(root, 'http'),
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --import=${observer}` };
  for (const key of Object.keys(env)) if (key === 'TMUX' || /TOKEN|SECRET|PASSWORD|API_KEY/.test(key)
    || ['ZYLOS_RUN_ID', 'CLAUDE_SESSION_ID', 'CODEX_SESSION_ID'].includes(key)) delete env[key];
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR', 'ZYLOS_DATA_DIR']) assert.ok(env[key].startsWith(root + path.sep), key);
  assert.notEqual(zylos, path.join(home, 'zylos'));
  for (const filename of [c4Path, dashboardPath]) assert.ok(filename.startsWith(root + path.sep));
  assert.deepEqual(fs.readdirSync(bin), ['node']);
  console.log('Chat isolation:', JSON.stringify({ ...Object.fromEntries(['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR', 'ZYLOS_DATA_DIR', 'PATH'].map(key => [key, env[key]])), c4Path, dashboardPath, tmux: 'not spawned' }));
  for (const name of ['comm-bridge', 'dashboard']) {
    const source = path.join(core, 'skills', name), dest = path.join(skills, name);
    fs.mkdirSync(dest);
    for (const file of ['package.json', 'SKILL.md']) fs.copyFileSync(path.join(source, file), path.join(dest, file));
    fs.cpSync(path.join(source, 'scripts'), path.join(dest, 'scripts'), { recursive: true, filter: file => !file.split(path.sep).includes('__tests__') });
    fs.symlinkSync(fs.realpathSync(path.join(source, 'node_modules')), path.join(dest, 'node_modules'));
    if (name === 'comm-bridge') fs.copyFileSync(path.join(source, 'init-db.sql'), path.join(dest, 'init-db.sql'));
    else fs.cpSync(path.join(source, 'src/lib'), path.join(dest, 'src/lib'), { recursive: true });
  }
  c4Db = new Database(c4Path); guardDatabase(c4Db, c4Schema);
  dashboardStore = new Store(dashboardPath);
  const c4Store = createStore(c4Db, { validateComponent: () => true, readConfig: () => ({ state: 'ok', config: { runtime: 'codex', session_mode: 'multi' } }) });
  const invoke = (script, args, input, overrides = {}) => spawnSync(process.execPath, [script, ...args], { env: { ...env, ...overrides }, cwd: root, input,
    encoding: 'utf8', timeout: 5000, maxBuffer: 262144 });
  const send = content => invoke(path.join(skills, 'comm-bridge/scripts/c4-send.js'), ['dashboard', 'conversation_a', '--session-group', 'conversation_a'], content);
  const receive = packet => invoke(path.join(skills, 'dashboard/scripts/send.js'), [], typeof packet === 'string' ? packet : JSON.stringify(packet));
  const hook = input => invoke(path.join(skills, 'dashboard/scripts/send-hook.js'), [], typeof input === 'string' ? input : JSON.stringify(input));
  const insert = (content, options = {}) => c4Store.insertConversation(options.direction || 'out', options.channel || 'dashboard', options.endpoint || 'conversation_a', content,
    { status: options.direction === 'in' ? 'pending' : 'delivered', groupName: options.group || 'conversation_a' });
  const count = (table, db = c4Db) => db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
  return { root, env, skills, c4Path, dashboardPath, dataDir, c4Db, db: c4Db, c4Store, dashboardStore, dashboardDb: dashboardStore.db,
    send, receive, hook, invoke, insert, count };
}

export const deliveryPacket = row => ({ version: 1, c4_id: row.id, channel: row.channel, endpoint_id: row.endpoint_id,
  session_group: row.session_group, content: row.content });
