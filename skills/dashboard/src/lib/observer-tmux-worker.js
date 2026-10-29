import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readObserverGeometry } from './observer-size-monitor.js';
import { ObserverUpstream } from './observer-upstream.js';
import { command, delay, digest, failure, identity, privateEnvironment, processSnapshot, targetArgs, innerAttachArgs,
  outerArgs, zellijArgs, validateState, writeAtomic, privatePath, exists, validRole } from './observer-tmux-state.js';

async function until(check, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  do {
    try { const value = await check(); if (value) return value; } catch (error) { last = error; }
    await delay(50);
  } while (Date.now() < deadline);
  throw failure('startup_incomplete', `Observer launch did not settle: ${last?.message || 'acknowledgement missing'}`);
}

// Pinned Zellij 0.45.1 may panic if discovery connects before its first real
// client initializes the session. Observe its private log without touching IPC.
// The marker runs in the same serial handler that assigns session_data, before
// any later ConnStatus/RemoveClient can be handled. It also covers exited panes.
async function initializedSession(state) {
  const directories = [path.join(state.root, 'tmp')];
  directories.push(path.join(directories[0], `zellij-${process.getuid()}`));
  directories.push(path.join(directories[1], 'zellij-log'));
  try {
    for (const directory of directories) await privatePath(directory);
    const file = path.join(directories[2], 'zellij.log');
    await privatePath(file, 'file');
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      const limit = 128 * 1024;
      if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) ||
          stat.nlink !== 1 || stat.size > limit) throw failure('unsafe_runtime_state', 'Unsafe Observer startup log');
      const buffer = Buffer.alloc(limit + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > limit) throw failure('unsafe_runtime_state', 'Observer startup log exceeds bound');
      const text = buffer.subarray(0, bytesRead).toString('utf8').replace(/\x1b\[[0-9;]*m/g, '');
      return text.split('\n').some((line) => /^INFO\s+\|zellij_server\s*\| \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} \[main\s*\] zellij-server\/src\/lib\.rs:1044: FirstClientConnected: session initialized, spawning tabs \r?$/.test(line));
    } finally { await handle.close(); }
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function startPrivateServer(state, env) {
  // The shell cannot exec tmux until its PID/start identity is durable. exec
  // preserves that identity, closing the spawn-to-record interruption window
  // even on platforms where tmux rewrites its process title.
  const gate = 'permit=$1; cancelled=$2; shift 2; while [ ! -f "$permit" ]; do [ ! -e "$cancelled" ] || exit 0; sleep 0.05; done; [ ! -e "$cancelled" ] || exit 0; exec "$@"';
  const child = spawn('/bin/sh', ['-c', gate, 'observer-tmux-server',
    path.join(state.root, 'starting', 'server-permit.json'), path.join(state.root, 'recovery.json'),
    state.tmuxPath, '-D', '-S', state.outerSocket, '-f', state.tmuxConfig], {
    stdio: 'ignore', env,
  });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
  return child.pid;
}

// Dependency injection is module-local for deterministic tests, never an
// environment variable or production control endpoint.
export async function runStartupWorker(root, { exec = command, probe = (active) => new ObserverUpstream({ active }), phase = async () => {}, observe = identity, snapshot = processSnapshot, wait = until, launchServer = startPrivateServer, workerIdentity = () => identity(process.pid) } = {}) {
  const state = await validateState(root);
  try {
    if (state.startupRecovery === 1) {
      // Populate the permit before claiming it. Cancellation moves the whole
      // directory, so it either wins or sees the complete worker identity.
      await fs.mkdir(path.join(root, 'pending', 'claim'), { mode: 0o700 });
      const worker = await workerIdentity();
      if (!validRole(worker)) throw failure('process_query_failed', 'Startup worker identity unavailable');
      await writeAtomic(path.join(root, 'pending', 'claim', 'worker.json'), { nonce: state.nonce, role: worker });
    }
    await fs.rename(path.join(root, 'pending'), path.join(root, 'starting'));
  }
  catch (error) { if (['ENOENT', 'EEXIST', 'ENOTEMPTY'].includes(error.code)) return { claimed: false }; throw error; }
  // No native command, probe or timer may precede this successful claim.
  await phase('claimed', state);
  const env = privateEnvironment(state);
  const receipt = { schema: 2, generation: state.generation, nonce: state.nonce, creationClosed: true,
    outcome: 'failed', sessionIssued: false, webLaunch: 'not-issued',
    roles: { outer: null, client: null, daemon: null, inner: null, web: null } };
  let creationSettled = true;
  const checkCancelled = async () => {
    if (await exists(path.join(root, 'recovery.json'))) throw failure('startup_cancelled', 'Observer startup cancelled');
  };
  const run = async (file, args, options = {}) => {
    await checkCancelled();
    return exec(file, args, { env, ...options });
  };
  const outer = (...args) => run(state.tmuxPath, outerArgs(state, ...args));
  const zellij = (...args) => run(state.binaryPath, zellijArgs(state, ...args));
  const paneInfo = async (target) => {
    const result = await outer('display-message', '-p', '-t', target, '#{pid}|#{pane_pid}|#{pane_dead}|#{pane_dead_status}');
    const [server, pid, dead, exit] = result.stdout.trim().split('|');
    if (!/^\d+$/.test(server) || !/^\d+$/.test(pid) || !['0', '1'].includes(dead)) throw new Error('Invalid private pane identity');
    return { server: Number(server), pid: Number(pid), dead: dead === '1', exit };
  };
  const innerClient = async (daemon) => {
    const result = await run(state.tmuxPath, targetArgs(state, 'list-clients', '-t', `=${state.target}`, '-F', '#{client_pid}|#{client_readonly}|#{session_name}'));
    for (const line of result.stdout.trim().split('\n')) {
      const [pid, readonly, target] = line.split('|');
      const process = await observe(Number(pid));
      if (process?.ppid === daemon.pid && target === state.target && readonly === '1') return process;
    }
    return null;
  };
  try {
    if (digest(await fs.readFile(state.binaryPath)) !== state.hashes.binary) throw new Error('Observer binary changed');
    creationSettled = false;
    await fs.mkdir(state.socketRoot, { mode: 0o700 });
    await writeAtomic(path.join(state.socketRoot, 'owner.json'), { nonce: state.nonce, root: state.root });
    creationSettled = true;
    for (const directory of new Set(Object.entries(env).filter(([key]) => key === 'HOME' || key.startsWith('XDG_') || key.startsWith('ZELLIJ_') || ['TMP', 'TEMP'].includes(key)).map(([, value]) => value))) {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    }
    await phase('before-outer', state);
    // Detached Agent sessions may count even ignore-size clients. Never attach
    // with guessed geometry: measure before any private native process exists.
    const initialGeometry = await readObserverGeometry(state, run);
    if (!initialGeometry) throw failure('target_size_unavailable', 'Agent terminal size could not be measured safely');
    const initialSize = { cols: initialGeometry.cols, rows: initialGeometry.rows };
    const verifyTargetGeometry = async () => {
      const current = await readObserverGeometry(state, run);
      if (!current) throw failure('target_size_unavailable', 'Agent window size could not be verified after attachment');
      if (current.cols !== initialGeometry.cols || current.windowRows !== initialGeometry.windowRows) {
        // This detects a change, including concurrent operator resizes. Failed
        // receipt cleanup disconnects Observer; never resize the Agent back.
        throw failure('target_size_changed', 'Agent window size changed during Observer attachment');
      }
    };
    creationSettled = false;
    // Foreground server creation has one identifiable producer. Every later
    // mutation uses -N and therefore cannot recreate it after recovery kills it.
    if (state.startupRecovery === 1) {
      await checkCancelled();
      const serverPid = await launchServer(state, env);
      const server = await observe(serverPid);
      if (!server) throw new Error('Private tmux server disappeared');
      await writeAtomic(path.join(root, 'starting', 'server.json'), { nonce: state.nonce, role: server });
      await checkCancelled();
      await writeAtomic(path.join(root, 'starting', 'server-permit.json'), { nonce: state.nonce });
      await phase('outer-server-started', state);
      await wait(async () => {
        await outer('show-options', '-g', 'exit-empty');
        return true;
      });
    }
    await run(state.tmuxPath, [...(state.startupRecovery === 1 ? outerArgs(state) : ['-S', state.outerSocket, '-f', state.tmuxConfig]),
      'new-session', '-d', '-s', 'observer', '-n', 'client', '-x', String(initialSize.cols), '-y', String(initialSize.rows),
      '/usr/bin/env', '-u', 'TMUX', '-u', 'ZELLIJ', state.binaryPath, ...zellijArgs(state, '--new-session-with-layout', state.layoutFile, '--session', state.sessionName)], { timeout: 0 });
    receipt.sessionIssued = true;
    await phase('outer-acknowledged', state);
    const first = await wait(async () => {
      const pane = await paneInfo('observer:client');
      const outerIdentity = await observe(pane.server);
      const client = await observe(pane.pid);
      if (!outerIdentity || !client || pane.dead || !client.command.includes(state.binaryPath)) return null;
      return { outerIdentity, client };
    });
    receipt.roles.outer = first.outerIdentity;
    receipt.roles.client = first.client;
    receipt.roles.daemon = await wait(async () => {
      const inventory = await snapshot();
      const daemons = inventory.filter((entry) => !entry.status.startsWith('Z') &&
        entry.command.includes(state.binaryPath) &&
        entry.command.includes(`--server ${state.socketRoot}/`) && entry.command.includes(state.sessionName));
      if (daemons.length !== 1) return null;
      const daemon = await observe(daemons[0].pid, inventory);
      if (!daemon || daemon.status.startsWith('Z') || !await initializedSession(state)) return null;
      return daemon;
    });
    const pane = await wait(async () => {
      const result = await zellij('--session', state.sessionName, 'action', 'list-panes', '--all', '--json');
      const panes = JSON.parse(result.stdout);
      if (!Array.isArray(panes) || panes.length !== 1 || panes[0].is_plugin ||
          panes[0].terminal_command !== [state.tmuxPath, ...innerAttachArgs(state)].join(' ')) {
        throw new Error('Unexpected fixed Observer layout');
      }
      return panes[0];
    });
    const daemon = await observe(receipt.roles.daemon.pid);
    if (!daemon || daemon.start !== receipt.roles.daemon.start || daemon.status.startsWith('Z')) {
      throw failure('startup_incomplete', 'Observer daemon disappeared before settlement');
    }
    // Fixed layout has now conclusively applied its only run instruction.
    creationSettled = true;
    await phase('session-settled', state);
    if (pane.exited === true) throw new Error('Observer target attachment exited');
    receipt.roles.inner = await wait(() => innerClient(receipt.roles.daemon), 5000);
    await verifyTargetGeometry();
    const token = await zellij('web', '--create-read-only-token');
    if (!/^token_\d+:\s*[0-9a-f-]{36}(?:\s|$)/m.test(token.stdout) || token.stdout.length > 4096) throw new Error('Invalid read-only token');
    await fs.writeFile(state.tokenFile, token.stdout, { flag: 'wx', mode: 0o600 });
    await phase('before-web', state);
    creationSettled = false;
    await run(state.tmuxPath, outerArgs(state, 'new-window', '-d', '-t', 'observer', '-n', 'web',
      '/usr/bin/env', '-u', 'TMUX', '-u', 'ZELLIJ', state.binaryPath, ...zellijArgs(state, 'web', '--start', '--ip', '127.0.0.1', '--port', String(state.port))), { timeout: 0 });
    const web = await wait(async () => {
      const pane = await paneInfo('observer:web');
      if (pane.dead) return { exited: true };
      const record = await observe(pane.pid);
      return record?.command.includes(state.binaryPath) && record.command.includes('web --start') ? { record } : null;
    });
    receipt.webLaunch = web.exited ? 'exited' : 'running';
    receipt.roles.web = web.record || null;
    creationSettled = true;
    if (web.exited) throw new Error('Observer foreground web launch exited');
    await phase('web-settled', state);
    await wait(async () => {
      const viewer = probe(state);
      try { await viewer.connect({ size: initialSize, onDisplay() {}, onClose() {} }); return true; }
      finally { viewer.close(); }
    }, 10000);
    receipt.roles.inner = await innerClient(receipt.roles.daemon);
    if (!receipt.roles.inner) throw new Error('Observer read-only target client missing');
    for (const role of Object.values(receipt.roles)) {
      const current = role && await observe(role.pid);
      if (!current || current.start !== role.start || current.status.startsWith('Z')) throw new Error('Observer role exited before readiness');
    }
    await verifyTargetGeometry();
    receipt.outcome = 'ready';
  } catch (error) {
    if (!creationSettled) {
      await writeAtomic(path.join(root, 'startup-error.json'), { code: 'startup_incomplete', message: error.message });
      return { claimed: true, settled: false };
    }
    receipt.error = { code: error.code || 'startup_failed', message: error.message };
  }
  await phase('before-receipt', state);
  await checkCancelled();
  await writeAtomic(path.join(root, 'receipt.json'), receipt);
  // Absolutely no native operations may follow terminal receipt publication.
  return { claimed: true, settled: true, outcome: receipt.outcome };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runStartupWorker(path.resolve(process.argv[2] || '')).catch((error) => {
    process.stderr.write(`${error.code || 'startup_failed'}: ${error.message}\n`);
    process.exitCode = 1;
  });
}
