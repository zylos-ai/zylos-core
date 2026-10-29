import { OBSERVER_SIZE_LIMITS, validObserverSize } from '../../public/js/observer-size.js';
import { readObserverGeometry } from './observer-size-monitor.js';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { command, delay, digest, exists, failure, finalName, fixedLayout, identity, mkdirPrivate, outerArgs,
  privateEnvironment, privatePath, processSnapshot, readJson, readReceipt, removePrivateTree,
  socketParent, syncDirectory, targetArgs, validateState, writeAtomic, zellijArgs, tmuxConfigText, validRole } from './observer-tmux-state.js';

const workerPath = fileURLToPath(new URL('./observer-tmux-worker.js', import.meta.url));
const defaultConfig = fileURLToPath(new URL('../../assets/observer/zellij-config.kdl', import.meta.url));
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function socketClosed(socketPath) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath);
    client.setTimeout(1000, () => { client.destroy(); reject(new Error('Socket observation timed out')); });
    client.once('connect', () => { client.destroy(); resolve(false); });
    client.once('error', (error) => {
      client.destroy();
      if (['ENOENT', 'ECONNREFUSED'].includes(error.code)) resolve(true); else reject(error);
    });
  });
}
async function socketsUnder(root, budget = { count: 0 }) {
  if (!await exists(root)) return [];
  const stat = await fs.promises.lstat(root);
  if (++budget.count > 4096 || stat.isSymbolicLink() || stat.uid !== process.getuid()) throw failure('unsafe_runtime_state', 'Invalid socket tree');
  if (stat.isSocket()) return [root];
  if (!stat.isDirectory()) return [];
  const sockets = [];
  for (const name of await fs.promises.readdir(root)) sockets.push(...await socketsUnder(path.join(root, name), budget));
  return sockets;
}

export class TmuxObserverContainment extends EventEmitter {
  constructor({ dataDir, tmuxPath = 'tmux', tmuxSocket = null, zellijConfig = defaultConfig,
    platform = process.platform, arch = process.arch, exec = command, spawnImpl = spawn,
    startupTimeoutMs = 20000, cleanupTimeoutMs = 20000, phase = async () => {}, choosePort = freePort, observe = identity, snapshot = processSnapshot, signal = (pid, name) => process.kill(pid, name) } = {}) {
    super();
    // dataDir is a trusted deployment input; resolve OS aliases once, then reject
    // any symlink below this canonical boundary when validating managed state.
    this.dataDir = fs.realpathSync(dataDir);
    this.runtimeRoot = path.join(this.dataDir, 'observer', 'runtime', 'generations');
    Object.assign(this, { tmuxPath, tmuxSocket, zellijConfig, platform, arch, exec, spawn: spawnImpl,
      startupTimeoutMs, cleanupTimeoutMs, phase, choosePort, observe, snapshot, signal });
    this.active = null;
    this.owned = new Set();
    this._stopping = null;
    this._healthTimer = null;
    this._checking = false;
    this._resizePending = Promise.resolve();
  }

  async verifyHelpers() {
    if (!((this.platform === 'darwin' && this.arch === 'arm64') ||
        (this.platform === 'linux' && ['x64', 'arm64'].includes(this.arch)))) throw failure('unsupported_platform', 'Unsupported Observer platform');
    // Historical method name retained for coordinator compatibility; no helper
    // bundle is loaded by the tmux adapter.
    return { tmux: this.tmuxPath };
  }

  async _targetAvailable(preflight, target) {
    try {
      await this.exec(this.tmuxPath, targetArgs(preflight, 'has-session', '-t', `=${target}`));
    } catch (error) {
      if (error.code !== 1 || error.killed || error.signal) throw error;
      // A successful independent listing proves a missing session. An absent
      // socket is corroborated by a socket connection, never exit status alone.
      try {
        const sessions = await this.exec(this.tmuxPath, targetArgs(preflight, 'list-sessions', '-F', '#{session_name}'));
        if (!sessions.stdout.split('\n').includes(target)) throw failure('target_unavailable', 'Agent tmux session is unavailable');
      } catch (probeError) {
        if (probeError.code === 'target_unavailable') throw probeError;
        const stderr = String(probeError.stderr || '').trim();
        const match = /^(?:error connecting to (.+) \((?:No such file or directory|Connection refused)\)|no server running on (.+))$/.exec(stderr);
        const socket = preflight.tmuxSocket || match?.[1] || match?.[2];
        if (probeError.code === 1 && match && socket && path.isAbsolute(socket) && await socketClosed(socket)) {
          throw failure('target_unavailable', 'Agent tmux server is unavailable');
        }
        throw error;
      }
      throw error;
    }
  }

  // Resolves the Agent session and the absolute socket of the server hosting it.
  async _resolveTarget(runtime) {
    const target = runtime === 'codex' ? 'codex-main' : runtime === 'claude' ? 'claude-main' : null;
    if (!target) throw failure('unsupported_runtime', 'Unsupported Observer runtime');
    const preflight = { tmuxSocket: this.tmuxSocket };
    await this._targetAvailable(preflight, target);
    let result;
    try {
      result = await this.exec(this.tmuxPath, targetArgs(preflight, 'display-message', '-p', '-t', `=${target}`, '#{socket_path}'));
    } catch (error) {
      throw await this._classifyTargetLoss(error, preflight, target);
    }
    const tmuxSocket = result.stdout.trim();
    if (!path.isAbsolute(tmuxSocket) || /[\r\n]/.test(tmuxSocket)) throw failure('unsafe_runtime_state', 'Target socket was not resolved');
    return { target, tmuxSocket };
  }

  // The only Agent mutation Observer performs, and only on explicit operator
  // request. tmux switches the window to window-size=manual as a side effect.
  async resizeAgent({ runtime, cols, rows }) {
    await this.verifyHelpers();
    const { target, tmuxSocket } = await this._resolveTarget(runtime);
    const agent = { target, tmuxPath: this.tmuxPath, tmuxSocket };
    const status = await this.exec(this.tmuxPath, targetArgs(agent, 'display-message', '-p', '-t', `=${target}:`, '#{status}'));
    const match = /^(off|on|[2-5])$/.exec(status.stdout.trim());
    if (!match) throw failure('agent_resize_failed', 'Agent status line could not be read');
    const statusLines = match[1] === 'off' ? 0 : match[1] === 'on' ? 1 : Number(match[1]);
    if (rows + statusLines > OBSERVER_SIZE_LIMITS.maxRows) {
      throw Object.assign(failure('invalid_size', 'Agent size exceeds Observer limits'),
        { maxRows: OBSERVER_SIZE_LIMITS.maxRows - statusLines });
    }
    await this.exec(this.tmuxPath, targetArgs(agent, 'resize-window', '-t', `=${target}:`, '-x', String(cols), '-y', String(rows)));
    const geometry = await readObserverGeometry(agent, this.exec);
    if (!geometry || geometry.cols !== cols || geometry.windowRows !== rows) {
      throw failure('agent_resize_failed', 'Agent window size did not match after resize');
    }
    return { cols, rows, statusLines: geometry.statusLines };
  }

  async _publish({ generation, binaryPath, runtime }) {
    await this.verifyHelpers();
    if (!['codex', 'claude'].includes(runtime)) throw failure('unsupported_runtime', 'Unsupported Observer runtime');
    if (!Number.isSafeInteger(generation) || generation < 0) throw failure('unsafe_runtime_state', 'Invalid generation');
    const { target, tmuxSocket } = await this._resolveTarget(runtime);
    binaryPath = path.resolve(binaryPath);
    const binaryStat = await fs.promises.lstat(binaryPath);
    if (!binaryStat.isFile() || binaryStat.isSymbolicLink() || !(binaryStat.mode & 0o111)) throw failure('unsafe_runtime_state', 'Invalid Observer binary');
    await mkdirPrivate(this.runtimeRoot);
    const nonce = crypto.randomBytes(16).toString('hex');
    const name = `g-${generation}-${nonce}`;
    const root = path.join(this.runtimeRoot, name);
    const staging = path.join(this.runtimeRoot, `.staging-${name}`);
    await fs.promises.mkdir(staging, { mode: 0o700 });
    await this.phase('staging-created', { root, staging });
    const state = { schema: 2, startupRecovery: 1, generation, nonce, root,
      socketRoot: path.join(await socketParent(), `zobs2-${nonce.slice(0, 16)}`),
      sessionName: `observer-${nonce.slice(0, 16)}`, port: await this.choosePort(), target,
      tmuxPath: this.tmuxPath, tmuxSocket, binaryPath,
      layoutFile: path.join(root, 'readonly-tmux.kdl'), tmuxConfig: path.join(root, 'tmux.conf'),
      configFile: path.join(root, 'zellij.kdl'), tokenFile: path.join(root, 'read-only-token'),
      parent: await this.observe(process.pid), platform: this.platform, arch: this.arch };
    state.outerSocket = path.join(state.socketRoot, 'tmux');
    const layout = fixedLayout(state);
    const files = { layoutFile: layout, tmuxConfig: tmuxConfigText, configFile: await fs.promises.readFile(this.zellijConfig) };
    state.hashes = { binary: digest(await fs.promises.readFile(binaryPath)) };
    for (const [key, content] of Object.entries(files)) {
      const handle = await fs.promises.open(path.join(staging, path.basename(state[key])), 'wx', 0o600);
      try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
      state.hashes[key] = digest(content);
      await this.phase(`staged-${key}`, state);
    }
    await writeAtomic(path.join(staging, 'state.json'), state);
    await this.phase('staged-metadata', state);
    await fs.promises.mkdir(path.join(staging, 'pending'), { mode: 0o700 });
    await syncDirectory(staging);
    await this.phase('before-publication', state);
    if (await exists(root)) throw failure('unsafe_runtime_state', 'Generation collision');
    await fs.promises.rename(staging, root);
    await syncDirectory(this.runtimeRoot);
    this.owned.add(root);
    await this.phase('published', state);
    return state;
  }

  async _launchWorker(state) {
    const fd = fs.openSync(path.join(state.root, 'startup.log'), 'a', 0o600);
    try {
      const child = this.spawn(process.execPath, [workerPath, state.root], {
        detached: true, stdio: ['ignore', fd, fd], env: { ...process.env, LC_ALL: 'C' },
      });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      child.unref();
    } finally { fs.closeSync(fd); }
  }

  async _waitReceipt(state, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    do {
      try { return await readReceipt(state); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await delay(50);
    } while (Date.now() < deadline);
    throw failure('startup_incomplete', `Observer ${state.generation} has not acknowledged launch settlement; inspect ${state.root}/startup.log`);
  }

  async _classifyTargetLoss(error, state, target = state.target) {
    if (error.killed || error.signal || ![1, 'startup_failed', 'startup_incomplete'].includes(error.code)) return error;
    try {
      await this._targetAvailable(state, target);
    } catch (probeError) {
      if (probeError.code === 'target_unavailable') {
        probeError.cause = error;
        return probeError;
      }
    }
    // A failed probe is not evidence of absence; preserve the original error.
    return error;
  }

  async startGeneration(options) {
    if (this.active) {
      if (this.active.generation === options.generation) return this.active;
      throw failure('generation_active', 'Observer generation already active');
    }
    // Reconcile any interrupted previous start before admitting fresh demand.
    await this.reconcilePersisted();
    const state = await this._publish(options);
    try {
      await this._launchWorker(state);
      const receipt = await this._waitReceipt(state, this.startupTimeoutMs);
      if (receipt.outcome !== 'ready') throw failure(receipt.error?.code || 'startup_failed', receipt.error?.message || 'Observer failed to start');
      this.active = { ...state, receipt };
      this._healthTimer = setInterval(() => this._checkActive().catch((error) => this._failActive(error)), 2000);
      this._healthTimer.unref();
      return this.active;
    } catch (error) {
      // Even if active was never assigned, this instance owns failed-start state.
      try { await this._cleanup(state); } catch (cleanupError) {
        error.cleanupError = cleanupError;
        throw error;
      }
      // Only a settled, fully removed failed start may become retryable.
      throw await this._classifyTargetLoss(error, state);
    }
  }

  _failActive(error) {
    if (!this.active || this.active.failed || this._stopping) return;
    this.active.failed = true;
    clearInterval(this._healthTimer);
    this._healthTimer = null;
    this.emit('failure', error, this.active);
  }

  async _checkActive() {
    if (!this.active || this._checking || this._stopping) return;
    const active = this.active;
    this._checking = true;
    try {
      const snapshot = await this.snapshot();
      for (const role of Object.values(active.receipt.roles)) {
        const current = role && await this.observe(role.pid, snapshot);
        if (!current || current.start !== role.start || current.status.startsWith('Z')) throw failure('child_exit', 'Observer role exited');
      }
      const clients = await this.exec(active.tmuxPath, targetArgs(active, 'list-clients', '-t', `=${active.target}`, '-F', '#{client_pid}|#{client_readonly}|#{session_name}'));
      const expected = `${active.receipt.roles.inner.pid}|1|${active.target}`;
      if (!clients.stdout.split('\n').includes(expected)) throw failure('child_exit', 'Observer read-only target attachment lost');
    } catch (error) { if (this.active === active) this._failActive(error); }
    finally { this._checking = false; }
  }

  resize(active, size) {
    if (!validObserverSize(size)) return Promise.reject(failure('invalid_size', 'Invalid Observer terminal size'));
    const dimensions = { ...size };
    const pending = this._resizePending.then(async () => {
      if (!active || active !== this.active || active.failed || active.resizeClosed || this._stopping) return false;
      // This generation's private socket is the only mutation target. -N cannot
      // recreate a server after recovery, and cleanup drains an issued command.
      await this.exec(active.tmuxPath, outerArgs(active, 'resize-window', '-t', 'observer:client',
        '-x', String(dimensions.cols), '-y', String(dimensions.rows)), { env: privateEnvironment(active) });
      return this.active === active && !active.failed && !active.resizeClosed && !this._stopping;
    });
    this._resizePending = pending.catch(() => {});
    return pending;
  }

  async _sameProcess(record, snapshot) {
    if (!record) return false;
    const current = await this.observe(record.pid, snapshot);
    return !!current && current.start === record.start;
  }

  async _assertOwnerGone(state) {
    if (this.owned.has(state.root)) return;
    // No historical PID signaling or reboot override. Unknown identity is an
    // error; a recycled identity is not the original producer.
    if (await this._sameProcess(state.parent, await this.snapshot())) throw failure('coordinator_active', 'Recorded Observer producer is still alive');
  }

  async _absence(state, receipt) {
    const snapshot = await this.snapshot();
    for (const role of Object.values(receipt.roles)) if (await this._sameProcess(role, snapshot) && !(await this.observe(role.pid, snapshot))?.status.startsWith('Z')) return false;
    if (snapshot.some((entry) => entry.pid !== process.pid && !entry.status.startsWith('Z') &&
        (entry.command.includes(state.root) || entry.command.includes(state.socketRoot)))) return false;
    for (const socket of await socketsUnder(state.socketRoot)) if (!await socketClosed(socket)) return false;
    // The target server may legitimately have disappeared. -N never bootstraps.
    try {
      const clients = await this.exec(state.tmuxPath, targetArgs(state, 'list-clients', '-F', '#{client_pid}'));
      if (receipt.roles.inner && clients.stdout.split(/\s+/).includes(String(receipt.roles.inner.pid))) return false;
    } catch (error) { if (!await socketClosed(state.tmuxSocket)) throw error; }
    if (receipt.sessionIssued && await exists(state.socketRoot)) {
      try {
        const sessions = await this.exec(state.binaryPath, zellijArgs(state, 'list-sessions', '--short'), { env: privateEnvironment(state) });
        if (sessions.stdout.split('\n').includes(state.sessionName)) return false;
      } catch (error) {
        // Zellij reports no sessions with exit 1. It is corroborated by exact
        // process/socket absence, not used alone as a shutdown acknowledgement.
        if (error.code !== 1) throw error;
      }
    }
    // Foreground web has no surviving listener child: known identity and private
    // scope absence prove our listener gone. A foreign port occupant is untouched.
    return true;
  }

  async _retire(state) {
    await writeAtomic(path.join(state.root, 'retirement.json'), { nonce: state.nonce, socketRemoval: true });
    if (await exists(state.socketRoot)) await removePrivateTree(state.socketRoot);
    await this.phase('socket-scope-removed', state);
    const retired = path.join(this.runtimeRoot, `.retired-${path.basename(state.root)}-${state.nonce}`);
    await fs.promises.rename(state.root, retired);
    await syncDirectory(this.runtimeRoot);
    await this.phase('retired', state);
    await removePrivateTree(retired);
    this.owned.delete(state.root);
  }

  async _signalExact(record, name) {
    if (!validRole(record) || record.pid === process.pid) throw failure('unsafe_runtime_state', 'Invalid recovery process identity');
    const current = await this.observe(record.pid);
    if (!current || current.start !== record.start || current.status.startsWith('Z')) return false;
    try { this.signal(record.pid, name); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    return true;
  }

  async _recoverStartup(state) {
    // This marker is an enduring cancellation, never a fabricated ready receipt.
    // Kill the registered issuer first; a stalled callback or command cannot
    // resume and create more resources after its exact process has disappeared.
    await writeAtomic(path.join(state.root, 'recovery.json'), { nonce: state.nonce, cancelled: true });
    const worker = await readJson(path.join(state.root, 'starting', 'claim', 'worker.json'));
    if (worker.nonce !== state.nonce || !validRole(worker.role)) throw failure('unsafe_runtime_state', 'Invalid startup worker identity');
    await this._signalExact(worker.role, 'SIGKILL');
    const deadline = Date.now() + this.cleanupTimeoutMs;
    while (await this._sameProcess(worker.role, await this.snapshot())) {
      const current = await this.observe(worker.role.pid);
      if (!current || current.status.startsWith('Z')) break;
      if (Date.now() >= deadline) throw failure('cleanup_timeout', 'Observer startup worker has not stopped');
      await delay(50);
    }
    const records = new Map();
    try {
      const server = await readJson(path.join(state.root, 'starting', 'server.json'));
      if (server.nonce !== state.nonce || !validRole(server.role)) throw failure('unsafe_runtime_state', 'Invalid private server identity');
      records.set(server.role.pid, server.role);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    // Freeze each scoped producer before collecting its descendants. Repeating
    // inventory after the stop catches children forked during the first scan.
    // Before server.json exists the child is still a gated shell whose argv
    // contains this generation; only its recorded PID can later exec tmux.
    let changed;
    do {
      changed = false;
      const inventory = await this.snapshot();
      const selected = new Set();
      for (const record of records.values()) if (await this._sameProcess(record, inventory)) selected.add(record.pid);
      for (const entry of inventory) {
        if (entry.command.includes(state.root) || entry.command.includes(state.socketRoot)) selected.add(entry.pid);
      }
      let added;
      do {
        added = false;
        for (const entry of inventory) if (selected.has(entry.ppid) && !selected.has(entry.pid)) {
          selected.add(entry.pid); added = true;
        }
      } while (added);
      for (const entry of inventory) {
        if (!selected.has(entry.pid) || entry.status.startsWith('Z')) continue;
        const record = await this.observe(entry.pid, inventory);
        if (!record || record.pid === process.pid) continue;
        if (records.get(record.pid)?.start !== record.start) changed = true;
        records.set(record.pid, record);
        await this._signalExact(record, 'SIGSTOP');
      }
      if (Date.now() >= deadline && changed) throw failure('cleanup_timeout', 'Observer startup resources did not settle');
    } while (changed);
    for (const record of records.values()) await this._signalExact(record, 'SIGKILL');
    const receipt = { roles: Object.fromEntries([...records].map(([pid, role]) => [pid, role])), sessionIssued: false };
    do {
      if (await this._absence(state, receipt)) { await this._retire(state); return; }
      await delay(50);
    } while (Date.now() < deadline);
    throw failure('cleanup_timeout', 'Observer interrupted-start resources remain');
  }

  async _cleanup(state) {
    if (this.active?.root === state.root) {
      this.active.resizeClosed = true;
      await this._resizePending;
    }
    await this._assertOwnerGone(state);
    try {
      await fs.promises.rename(path.join(state.root, 'pending'), path.join(state.root, 'cancelled'));
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (await exists(path.join(state.root, 'cancelled'))) {
      if (await exists(path.join(state.root, 'starting'))) throw failure('unsafe_runtime_state', 'Conflicting Observer permits');
      // Cancellation means no worker can have touched the socket scope.
      if (await exists(state.socketRoot)) throw failure('unsafe_runtime_state', 'Unexpected cancelled socket scope');
      await this._retire(state);
      return;
    }
    if (!await exists(path.join(state.root, 'starting'))) throw failure('unsafe_runtime_state', 'Missing Observer creation permit');
    let receipt;
    try { receipt = await this._waitReceipt(state, state.startupRecovery === 1 ? 0 : this.cleanupTimeoutMs); }
    catch (error) {
      if (error.code !== 'startup_incomplete' || state.startupRecovery !== 1) throw error;
      if (await exists(state.socketRoot)) {
        await privatePath(state.socketRoot);
        try {
          const owner = await readJson(path.join(state.socketRoot, 'owner.json'));
          if (owner.root !== state.root || owner.nonce !== state.nonce) throw failure('unsafe_runtime_state', 'Socket scope ownership mismatch');
        } catch (ownerError) { if (ownerError.code !== 'ENOENT') throw ownerError; }
      }
      return this._recoverStartup(state);
    }
    if (await exists(state.socketRoot)) {
      await privatePath(state.socketRoot);
      try {
        const owner = await readJson(path.join(state.socketRoot, 'owner.json'));
        if (owner.root !== state.root || owner.nonce !== state.nonce) throw failure('unsafe_runtime_state', 'Socket scope ownership mismatch');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const retirement = await readJson(path.join(state.root, 'retirement.json'));
        if (retirement.nonce !== state.nonce || retirement.socketRemoval !== true) throw failure('unsafe_runtime_state', 'Incomplete socket ownership');
      }
    }
    await writeAtomic(path.join(state.root, 'teardown.json'), { requested: true });
    const env = privateEnvironment(state);
    if (receipt.sessionIssued) {
      try { await this.exec(state.binaryPath, zellijArgs(state, 'kill-session', state.sessionName), { env }); }
      catch (error) {
        // Already-absent endpoints are allowed only after receipt closure. All
        // identities/endpoints still have to pass the independent absence gate.
        if (typeof error.code !== 'number') throw error;
      }
    }
    try { await this.exec(state.tmuxPath, outerArgs(state, 'kill-server'), { env }); }
    catch (error) { if (!await socketClosed(state.outerSocket)) throw error; }
    const deadline = Date.now() + this.cleanupTimeoutMs;
    do {
      if (await this._absence(state, receipt)) { await this._retire(state); return; }
      await delay(100);
    } while (Date.now() < deadline);
    throw failure('cleanup_timeout', 'Observer resources remain; retained state fences new starts and uninstall');
  }

  stopGeneration({ reason = 'stop' } = {}) {
    clearInterval(this._healthTimer);
    this._healthTimer = null;
    if (!this._stopping) this._stopping = this.reconcilePersisted().then((results) => {
      this.active = null;
      return { stopped: true, reason, count: results.length };
    }).finally(() => { this._stopping = null; });
    return this._stopping;
  }

  async reconcilePersisted() {
    if (!await exists(this.runtimeRoot)) return [];
    await privatePath(this.runtimeRoot);
    const results = [];
    for (const name of await fs.promises.readdir(this.runtimeRoot)) {
      const root = path.join(this.runtimeRoot, name);
      if (/^\.staging-g-\d+-[0-9a-f]{32}$/.test(name) || /^\.retired-g-\d+-([0-9a-f]{32})-\1$/.test(name)) {
        await removePrivateTree(root);
        results.push({ reconciled: true });
        continue;
      }
      if (!finalName.test(name)) throw failure('legacy_containment_state', 'Unrecognized/native Observer state requires old-version recovery');
      const state = await validateState(root);
      await this._cleanup(state);
      if (this.active?.root === root) this.active = null;
      results.push({ generation: state.generation, reconciled: true });
    }
    return results;
  }
}
