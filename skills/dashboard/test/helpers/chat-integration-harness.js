import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

export function chatEnabled(env = process.env, { runtime = false } = {}) {
  return env.ZYLOS_CHAT_INTEGRATION === '1' && (!runtime || env.ZYLOS_CHAT_RUNTIME === '1');
}

const starts = { roots: 0, db: 0, http: 0, runtime: 0 };
export const chatResourceCounts = () => ({ ...starts });

const within = (root, filename) => typeof filename === 'string' && path.isAbsolute(filename)
  && filename.startsWith(`${root}${path.sep}`);

// This helper creates no directories, connections or children until both gates
// needed by the requested case have been checked. No live config is inherited.
export function createChatSandbox(t, { runtime = false, gateEnv = process.env, existingRoot } = {}) {
  if (!chatEnabled(gateEnv, { runtime })) return null;
  let root, parentTmp;
  if (existingRoot) {
    root = fs.realpathSync(existingRoot);
    assert.equal(root, path.resolve(existingRoot), 'Reused root must be canonical');
    assert.match(path.basename(root), /^c-[A-Za-z0-9]{6}$/);
    parentTmp = path.dirname(root);
    assert.equal(gateEnv.ZYLOS_CHAT_SANDBOX_PARENT, parentTmp, 'Child must inherit its parent allocation boundary');
    for (const [key, leaf] of [['HOME', 'home'], ['ZYLOS_DIR', 'instance'], ['PM2_HOME', 'pm2'], ['TMPDIR', 'tmp'], ['CODEX_HOME', 'home/.codex']]) {
      assert.equal(gateEnv[key], path.join(root, leaf), 'Child must reuse its parent-proven case');
      assert.equal(fs.realpathSync(gateEnv[key]), gateEnv[key], 'Reused paths must remain canonical');
    }
  } else {
    assert.ok(gateEnv.TMPDIR && path.isAbsolute(gateEnv.TMPDIR), 'An explicit runner TMPDIR is required');
    parentTmp = fs.realpathSync(gateEnv.TMPDIR);
    const prefix = path.join(parentTmp, 'c-');
    assert.ok(Buffer.byteLength(prefix + 'XXXXXX/tmux.sock') < 100, 'Runner TMPDIR must allow a short private socket');
    root = fs.realpathSync(fs.mkdtempSync(prefix));
    starts.roots++;
  }
  const paths = {
    home: path.join(root, 'home'), zylos: path.join(root, 'instance'),
    pm2: path.join(root, 'pm2'), tmp: path.join(root, 'tmp'), socket: path.join(root, 'tmux.sock'), parentTmp,
  };
  paths.c4Db = path.join(paths.zylos, 'comm-bridge/c4.db');
  paths.dashboardDb = path.join(paths.zylos, 'components/dashboard/dashboard.db');
  for (const directory of [paths.home, paths.zylos, paths.pm2, paths.tmp,
    path.dirname(paths.c4Db), path.dirname(paths.dashboardDb),
    path.join(paths.home, '.codex'), path.join(paths.home, '.claude')]) fs.mkdirSync(directory, { recursive: true });
  const env = {
    PATH: gateEnv.PATH || '/usr/bin:/bin', HOME: paths.home, ZYLOS_DIR: paths.zylos,
    PM2_HOME: paths.pm2, TMPDIR: paths.tmp, TMUX_TMPDIR: paths.tmp,
    CODEX_HOME: path.join(paths.home, '.codex'),
    ZYLOS_CHAT_SANDBOX_PARENT: parentTmp,
    ZYLOS_CHAT_INTEGRATION: '1', ...(runtime ? { ZYLOS_CHAT_RUNTIME: '1' } : {}),
    ...(gateEnv.NODE_OPTIONS ? { NODE_OPTIONS: gateEnv.NODE_OPTIONS } : {}),
    LANG: 'en_US.UTF-8',
  };
  // Network routing is an execution requirement of the dedicated test account;
  // preserve only proxy settings, never its credentials or general configuration.
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
    'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']) {
    if (typeof gateEnv[key] === 'string') env[key] = gateEnv[key];
  }
  const counts = { db: 0, http: 0, runtime: 0 };
  const children = new Set(), allChildren = new Set(), servers = new Set(), databases = new Set(), cleanups = [];
  let closed = false, closing;

  function assertIsolation({ env: checkedEnv = env, socket = paths.socket,
    databases: checkedDbs = [paths.c4Db, paths.dashboardDb] } = {}) {
    assert.ok(!closed, 'Chat sandbox is closed');
    for (const [key, expected] of [['HOME', paths.home], ['ZYLOS_DIR', paths.zylos], ['PM2_HOME', paths.pm2], ['TMPDIR', paths.tmp], ['CODEX_HOME', path.join(paths.home, '.codex')]]) {
      assert.equal(checkedEnv[key], expected, `${key} must name this case's private directory`);
      assert.equal(fs.realpathSync(checkedEnv[key]), expected, `${key} may not redirect through a symlink`);
    }
    assert.equal(checkedEnv.TMUX_TMPDIR, paths.tmp, 'tmux temporary directory must be private');
    assert.equal(checkedEnv.CLAUDE_CONFIG_DIR, undefined, 'Claude must use the private HOME default config');
    assert.equal(checkedEnv.ZYLOS_CHAT_SANDBOX_PARENT, parentTmp, 'Parent allocation boundary must be preserved');
    assert.equal(typeof socket, 'string', 'An explicit private tmux socket is required');
    assert.equal(socket, paths.socket, 'An explicit private tmux socket is required');
    assert.ok(Buffer.byteLength(socket) < 100, 'Private socket path must be short');
    assert.ok(Array.isArray(checkedDbs) && checkedDbs.includes(paths.c4Db) && checkedDbs.includes(paths.dashboardDb),
      'Both test database paths must be proven');
    for (const filename of checkedDbs) {
      assert.ok(within(paths.zylos, filename), 'Database must belong to this case');
      assert.ok(within(root, fs.realpathSync(path.dirname(filename))), 'Database parent must remain private');
      if (fs.existsSync(filename)) assert.equal(fs.realpathSync(filename), filename, 'Database may not redirect through a symlink');
    }
    return { root, HOME: checkedEnv.HOME, ZYLOS_DIR: checkedEnv.ZYLOS_DIR, PM2_HOME: checkedEnv.PM2_HOME,
      TMPDIR: checkedEnv.TMPDIR, TMUX_TMPDIR: checkedEnv.TMUX_TMPDIR, CODEX_HOME: checkedEnv.CODEX_HOME,
      socket, databases: [...checkedDbs] };
  }

  function openDatabase(filename, factory, proof) {
    assertIsolation(proof);
    assert.ok(within(paths.zylos, filename), 'Database must belong to this case');
    assert.equal(fs.realpathSync(path.dirname(filename)), path.dirname(filename), 'Database parent must be canonical');
    if (fs.existsSync(filename)) assert.equal(fs.realpathSync(filename), filename, 'Database may not redirect through a symlink');
    counts.db++; starts.db++;
    const db = factory(filename);
    databases.add(db);
    return db;
  }

  async function startHttp(server, proof) {
    assertIsolation(proof);
    server ??= http.createServer();
    servers.add(server);
    counts.http++; starts.http++;
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return `http://127.0.0.1:${server.address().port}`;
  }

  function startChild(command, args, options = {}) {
    const childEnv = { ...env, ...options.env };
    // A supplied proof may narrow socket/DB evidence, but cannot substitute a
    // different environment for the bytes actually passed to spawn.
    assertIsolation({ ...options.proof, env: childEnv });
    assert.ok(!Object.hasOwn(options, 'cwd') || options.cwd === paths.zylos, 'Child working directory must name this case instance');
    counts.runtime++; starts.runtime++;
    const child = spawn(command, args, { ...options, cwd: paths.zylos, env: childEnv,
      detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    children.add(child); allChildren.add(child);
    const deadline = setTimeout(() => killChild(child), options.timeoutMs || 30_000);
    deadline.unref();
    let stdout = '', stderr = '', size = 0;
    const limit = options.maxOutputBytes || 262144;
    const collect = key => data => {
      size += data.length;
      if (size > limit) { child.outputExceeded = true; killChild(child); return; }
      if (key === 'stdout') stdout += data.toString(); else stderr += data.toString();
    };
    child.stdout.on('data', collect('stdout'));
    child.stderr.on('data', collect('stderr'));
    child.completion = new Promise(resolve => {
      child.once('error', error => { child.launchError = error; });
      child.once('close', (code, signal) => { clearTimeout(deadline); children.delete(child); resolve({ code, signal, stdout, stderr,
        error: child.launchError, outputExceeded: child.outputExceeded === true }); });
    });
    return child;
  }

  function killChild(child) {
    if (!child.pid) return;
    if (process.platform === 'win32' && (child.exitCode !== null || child.signalCode !== null)) return;
    try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }

  async function close() {
    if (closing) return closing;
    closing = (async () => {
      let firstError;
      const attempt = async operation => {
        try { await operation(); } catch (error) { firstError ??= error; }
      };
      // Stop producers before closing database files and removing their roots.
      try {
        for (const child of allChildren) await attempt(() => killChild(child));
        await attempt(async () => {
          let timer;
          try {
            await Promise.race([
              Promise.all([...allChildren].map(child => child.completion)),
              new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Chat child cleanup timed out')), 10_000); }),
            ]);
          } finally { clearTimeout(timer); }
        });
        for (const server of servers) await attempt(async () => {
          server.closeAllConnections?.();
          if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        });
        for (const cleanup of [...cleanups].reverse()) await attempt(cleanup);
      } finally {
        for (const db of databases) await attempt(() => { if (db.open !== false) db.close(); });
        try { if (!existingRoot) await attempt(() => fs.rmSync(root, { recursive: true, force: true })); }
        finally { closed = true; }
      }
      if (firstError) throw firstError;
    })();
    return closing;
  }

  async function runCase(fn, { timeoutMs = 30_000 } = {}) {
    assertIsolation();
    const controller = new AbortController();
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(() => fn({ signal: controller.signal })),
        new Promise((_, reject) => { timer = setTimeout(() => {
          controller.abort(); reject(new Error('Chat case timed out'));
        }, timeoutMs); }),
      ]);
    } finally { clearTimeout(timer); controller.abort(); await close(); }
  }

  const sandbox = { root, paths, env, counts, children, servers, assertIsolation, openDatabase, startHttp, startChild,
    runCase, close, addCleanup: cleanup => cleanups.push(cleanup) };
  console.log('Chat case isolation:', JSON.stringify(assertIsolation()));
  t?.after?.(close);
  return sandbox;
}
