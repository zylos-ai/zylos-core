import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import Database from '../../skills/comm-bridge/scripts/sqlite-driver.js';
import { guardDatabase } from '../../skills/comm-bridge/scripts/sqlite-schema.js';
import * as schema from '../../skills/comm-bridge/scripts/c4-schema.js';
import { createStore } from '../../skills/comm-bridge/scripts/c4-v2-store.js';
import { tmuxNameForGroup } from '../../cli/lib/session-group-paths.js';

const exec = promisify(execFile);
const repo = fileURLToPath(new URL('../../', import.meta.url));
const fixture = name => fileURLToPath(new URL(`../fixtures/dispatcher-singleton/${name}.js`, import.meta.url));
export async function waitFor(predicate, label, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await delay(30);
  }
  throw new Error(`Timed out: ${label}`);
}

export async function singletonFixture(t, { mode = 'single', ps = false } = {}) {
  assert.equal(process.platform, 'linux', 'The /proc cleanup contract requires Linux');
  // Deliberately bypass a possibly long runner TMPDIR: Unix socket paths have
  // a small fixed limit. This directory is always private and fixture-owned.
  const root = fs.mkdtempSync('/tmp/zds-');
  let cleanupRegistered = false;
  t.after(() => { if (!cleanupRegistered) fs.rmSync(root, { recursive: true, force: true }); });
  const dirs = Object.fromEntries(['home', 'instance', 'pm2', 'tmp', 'bin'].map(key => [key, path.join(root, key)]));
  for (const directory of Object.values(dirs)) fs.mkdirSync(directory);
  const env = { HOME: dirs.home, ZYLOS_DIR: dirs.instance, PM2_HOME: dirs.pm2,
    TMPDIR: dirs.tmp, TMUX_TMPDIR: dirs.tmp, PATH: dirs.bin, TZ: 'UTC', LANG: 'C.UTF-8',
    ZYLOS_PACKAGE_ROOT: repo, SINGLETON_FIXTURE_MARKER: root,
    SINGLETON_TMUX_SOCKET: path.join(dirs.tmp, 's'), SINGLETON_VERSION_FILE: path.join(root, 'version'), C4_PERIODIC_ENTER_ENABLED: '0' };
  // Never inherit live credentials, runtime/group identity, TMUX or PM2 state.
  const pm2 = [path.join(repo, 'node_modules/pm2/bin/pm2'),
    '/home/evanow/.nvm/versions/node/v24.22.1/lib/node_modules/pm2/bin/pm2'].find(file => fs.existsSync(file));
  assert.ok(pm2, 'Provision PM2 7.0.4 before running this opt-in integration');
  const packageFile = path.resolve(pm2, '../../package.json');
  assert.equal(JSON.parse(fs.readFileSync(packageFile)).version, '7.0.4');
  const tmuxBinary = process.env.TEST_TMUX_BIN || '/home/evanow/zylos/bin/tmux';
  for (const [name, target] of Object.entries({ node: process.execPath, pm2, sh: '/bin/sh', bash: '/bin/bash',
    sleep: '/bin/sleep', env: '/usr/bin/env', ...(ps ? { ps: '/usr/bin/ps' } : {}) })) fs.symlinkSync(target, path.join(dirs.bin, name));
  // Production clients that do not take explicit connection options are also
  // confined to this socket. Shell quotes protect spaces in a custom binary.
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  fs.writeFileSync(path.join(dirs.bin, 'tmux'), `#!/bin/sh\nexec ${quote(tmuxBinary)} -S ${quote(env.SINGLETON_TMUX_SOCKET)} "$@"\n`, { mode: 0o755 });
  const processes = () => fs.readdirSync('/proc').filter(name => /^\d+$/.test(name)).flatMap(name => {
    try {
      const variables = fs.readFileSync(`/proc/${name}/environ`).toString().split('\0');
      return variables.includes(`SINGLETON_FIXTURE_MARKER=${root}`) ? [{ pid: Number(name),
        worker: variables.includes('SINGLETON_WORKER=1'), cmd: fs.readFileSync(`/proc/${name}/cmdline`).toString().replaceAll('\0', ' ') }] : [];
    } catch { return []; }
  });
  let database;
  t.after(async () => {
    database?.close();
    // Do not trust PM2's process list: no-procps restart survivors can be
    // invisible there. Include daemon, terminals, stopped children and orphans.
    for (let round = 0; round < 4; round++) {
      for (const { pid } of processes()) { try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
      await delay(60);
      if (!processes().length) break;
    }
    assert.equal(processes().length, 0, `Fixture processes leaked under ${root}: ${JSON.stringify(processes()).slice(0, 2000)}`);
    if (t.passed) fs.rmSync(root, { recursive: true, force: true });
    else console.error(`Dispatcher fixture evidence retained: ${root}`);
  });
  cleanupRegistered = true;
  const command = (binary, args) => exec(binary, args, { env, cwd: dirs.home, timeout: 20_000, maxBuffer: 256 * 1024 });
  const pm = async (...args) => (await command(process.execPath, [pm2, ...args])).stdout;
  const tmux = async (...args) => (await command(path.join(dirs.bin, 'tmux'), args)).stdout.trim();
  const readback = JSON.parse((await command(process.execPath, ['-e',
    'console.log(JSON.stringify(Object.fromEntries(["HOME","ZYLOS_DIR","PM2_HOME","TMPDIR","TMUX_TMPDIR","PATH"].map(k=>[k,process.env[k]]))))'])).stdout);
  for (const [key, value] of Object.entries(readback)) {
    assert.equal(value, env[key]);
    assert.ok(fs.realpathSync(value).startsWith(`${fs.realpathSync(root)}/`));
  }
  assert.equal(fs.existsSync(path.join(dirs.bin, 'ps')), ps);
  assert.equal(fs.existsSync(path.join(dirs.bin, 'pgrep')), false);
  console.log('Dispatcher isolation readback before start:', JSON.stringify({ root, ...readback, socket: env.SINGLETON_TMUX_SOCKET, mode, ps, pm2: '7.0.4' }));
  fs.mkdirSync(path.join(dirs.instance, '.zylos'));
  fs.writeFileSync(path.join(dirs.instance, '.zylos/config.json'), JSON.stringify({ runtime: 'codex', session_mode: mode, session_pool_size: 4 }));
  fs.mkdirSync(path.join(dirs.instance, 'comm-bridge'));
  database = new Database(path.join(dirs.instance, 'comm-bridge/c4.db'));
  guardDatabase(database, schema); database.pragma('journal_mode=WAL'); database.pragma('busy_timeout=5000');
  const store = createStore(database, { validateComponent: () => true, validateModel: () => true,
    readConfig: () => ({ state: 'ok', config: { runtime: 'codex', session_mode: mode } }) });
  const receipts = [];
  async function terminal(group) {
    const directory = path.join(dirs.instance, 'activity-monitor/session-groups', group);
    fs.mkdirSync(directory, { recursive: true });
    const runId = `fixture-${group}`;
    fs.writeFileSync(path.join(directory, 'current-session.json'), JSON.stringify({ runId, sessionId: runId, ts: 1, startupControlIds: [] }));
    const receipt = path.join(root, `raw-${receipts.length}`); receipts.push(receipt);
    await tmux('-f', '/dev/null', 'new-session', '-d', '-s', tmuxNameForGroup(group),
      '-e', `ZYLOS_RUN_ID=${runId}`, '-e', `ZYLOS_SESSION_GROUP=${group}`,
      '-e', 'ZYLOS_MODEL_CONFIG={"runtime":"codex","mode":"default"}',
      '-e', `SINGLETON_TERMINAL_RECEIPT=${receipt}`, process.execPath, fixture('terminal'));
    const observed = await tmux('display-message', '-p', '-t', `=${tmuxNameForGroup(group)}`, '#{socket_path}');
    assert.equal(observed, env.SINGLETON_TMUX_SOCKET);
  }
  await terminal('origin');
  // Create the address mapping before the worker starts so no supervisor/model
  // launch is needed; multi mode exercises a genuine non-origin router lane.
  const enqueue = token => store.insertConversation('in', 'telegram', 'fixture', token, mode === 'multi' ? { groupName: 'fixture' } : {});
  if (mode === 'multi') { enqueue('fixture-initial'); await terminal('telegram:fixture'); }
  const events = () => {
    try {
      const filename = path.join(dirs.instance, 'owners.jsonl');
      assert.ok(fs.statSync(filename).size < 256 * 1024, 'Owner event fixture exceeded bounded output');
      return fs.readFileSync(filename, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  };
  const liveOwners = () => {
    const live = new Set(processes().map(row => row.pid));
    const active = new Map();
    for (const row of events()) {
      if (row.type === 'create' && live.has(row.pid)) active.set(row.pid, row);
      if (row.type === 'stop') active.delete(row.pid);
    }
    return [...active.values()];
  };
  let overlap;
  const assertOneOwner = () => {
    assert.equal(overlap, undefined, JSON.stringify(overlap));
    const owners = liveOwners();
    assert.ok(owners.length <= 1, `Concurrent factory owners: ${JSON.stringify(owners)}`);
  };
  const monitor = setInterval(() => {
    const owners = liveOwners();
    if (owners.length > 1) { overlap = owners; clearInterval(monitor); }
  }, 25);
  t.after(() => { clearInterval(monitor); assert.equal(overlap, undefined, JSON.stringify(overlap)); });
  let usesPm2 = false;
  const config = (version, { autorestart = true, admissionBarrier = false } = {}) => {
    usesPm2 = true;
    fs.writeFileSync(env.SINGLETON_VERSION_FILE, version);
    const filename = path.join(root, `ecosystem-${version}.config.cjs`);
    fs.writeFileSync(filename, `module.exports=${JSON.stringify({ apps: [{ name: 'c4-dispatcher', script: fixture('entry'),
      cwd: dirs.home, autorestart, restart_delay: 200, min_uptime: 1000, max_restarts: 10, kill_timeout: 1600, treekill: true, env: { ...env, SINGLETON_WORKER: '1',
        ...(admissionBarrier ? { SINGLETON_ADMISSION_BARRIER: path.join(root, 'admit') } : {}) } }] })}`);
    return filename;
  };
  async function owner(version) {
    return waitFor(() => { assertOneOwner(); const rows = liveOwners(); return rows.length === 1 && (!version || rows[0].version === version) ? rows[0] : false; }, 'exactly one admitted dispatcher owner');
  }
  async function managedOwner(version) {
    let observed;
    try { return await waitFor(async () => {
      assertOneOwner();
      const rows = JSON.parse(await pm('jlist'));
      const tracked = rows.find(row => row.name === 'c4-dispatcher');
      const owners = liveOwners(), workers = processes().filter(row => row.worker);
      const pidDirectory = path.join(dirs.pm2, 'pids');
      observed = { tracked: tracked?.pid, owners, workers, pids: fs.existsSync(pidDirectory) ? fs.readdirSync(pidDirectory).map(name => [name, fs.readFileSync(path.join(pidDirectory, name), 'utf8')]) : [] };
      return owners.length === 1 && owners[0].pid === tracked?.pid && workers.length === 1 && (!version || owners[0].version === version) ? owners[0] : false;
    }, 'one PM2 tracked owner and no orphaned workers'); }
    catch (error) { console.error('Admission failure readback:', JSON.stringify(observed).slice(0, 4000)); throw error; }
  }
  const count = token => receipts.reduce((sum, file) => {
    if (!fs.existsSync(file)) return sum;
    assert.ok(fs.statSync(file).size < 256 * 1024, 'Terminal fixture exceeded bounded output');
    return sum + fs.readFileSync(file, 'utf8').split(token).length - 1;
  }, 0);
  async function delivered(row, token) {
    await waitFor(() => { assertOneOwner(); return database.prepare('SELECT status FROM conversations WHERE id=?').get(row.id)?.status === 'delivered'; }, `message ${token} settlement`, 20_000);
    await waitFor(() => count(token) > 0, `message ${token} terminal receipt`);
    assert.equal(count(token), 1, `Message ${token} was pasted more than once`);
    const pasted = events().filter(event => event.type === 'pasted' && event.conversationId === row.id);
    assert.equal(pasted.length, 1, `Exactly one PID/version paste receipt for ${token}`);
  }
  async function lockHeld() {
    const lock = new Database(path.join(dirs.instance, 'comm-bridge/dispatcher-lock.db'));
    try { lock.pragma('busy_timeout=0'); assert.throws(() => lock.exec('BEGIN EXCLUSIVE'), /locked|busy/i); }
    finally { lock.close(); }
  }
  const standalone = version => {
    const child = spawn(process.execPath, [fixture(version)], { env: { ...env, SINGLETON_WORKER: '1' }, cwd: dirs.home, stdio: 'ignore' });
    child.on('error', () => {}); return child;
  };
  return { root, env, database, store, enqueue, pm, config, owner, managedOwner, events, processes, count, delivered, lockHeld, standalone,
    async settle() {
      const before = usesPm2 ? JSON.parse(await pm('jlist')).find(row => row.name === 'c4-dispatcher') : undefined;
      await delay(1200); assertOneOwner();
      if (before) {
        const after = JSON.parse(await pm('jlist')).find(row => row.name === 'c4-dispatcher');
        assert.equal(after?.pid, before.pid, 'Managed PID must remain stable after handoff');
        assert.equal(after?.pm2_env.restart_time, before.pm2_env.restart_time, 'No background PM2 restart cycle');
      }
    } };
}
