import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TmuxObserverContainment } from '../src/lib/observer-containment-tmux.js';
import { runStartupWorker } from '../src/lib/observer-tmux-worker.js';
import { readReceipt, writeAtomic, exists, validateState, digest } from '../src/lib/observer-tmux-state.js';

const role = (pid, command = 'fixture-process', ppid = 1) => ({ pid, ppid, start: `start-${pid}`, status: 'S', command });
async function fixture(t, extra = {}) {
  const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'observer-tmux-unit-')));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const binaryPath = path.join(dataDir, 'zellij');
  await fs.writeFile(binaryPath, 'inert fixture; never executed', { mode: 0o700 });
  const calls = [];
  const adapter = new TmuxObserverContainment({ dataDir, platform: process.platform, arch: process.arch,
    exec: async (file, args) => { calls.push(args); return { stdout: args.includes('display-message') ? '/tmp/fixture-target.sock\n' : '' }; },
    observe: async (pid) => role(pid), snapshot: async () => [], choosePort: async () => 23456,
    cleanupTimeoutMs: 1, startupTimeoutMs: 1, ...extra });
  const publish = async () => {
    const state = await adapter._publish({ generation: 1, binaryPath, runtime: 'codex' });
    t.after(() => fs.rm(state.socketRoot, { recursive: true, force: true }));
    return state;
  };
  return { adapter, publish, calls, dataDir, binaryPath };
}
const failedReceipt = (s) => ({ schema: 2, generation: s.generation, nonce: s.nonce, creationClosed: true,
  outcome: 'failed', sessionIssued: false, webLaunch: 'not-issued', roles: { outer: null, client: null, daemon: null, inner: null, web: null } });

for (const phase of ['staging-created', 'staged-layoutFile', 'staged-tmuxConfig', 'staged-configFile', 'staged-metadata', 'before-publication']) {
  test(`interrupted ${phase} is inert staging recoverable without native commands`, async (t) => {
    const f = await fixture(t, { phase: async (name) => { if (name === phase) throw new Error('interruption'); } });
    await assert.rejects(f.publish(), /interruption/);
    f.calls.length = 0;
    await f.adapter.reconcilePersisted();
    assert.deepEqual(await fs.readdir(f.adapter.runtimeRoot), []);
    assert.equal(f.calls.length, 0);
  });
}

test('published pending generation cancels and a delayed worker issues zero commands', async (t) => {
  const f = await fixture(t); const state = await f.publish();
  await fs.rename(path.join(state.root, 'pending'), path.join(state.root, 'cancelled'));
  let commands = 0;
  assert.deepEqual(await runStartupWorker(state.root, { exec: async () => { commands++; } }), { claimed: false });
  assert.equal(commands, 0);
  f.calls.length = 0;
  await f.adapter.reconcilePersisted();
  assert.equal(await exists(state.root), false);
  assert.equal(f.calls.length, 0);
});

test('workers refuse staging paths before commands or claiming', async (t) => {
  const f = await fixture(t); const state = await f.publish();
  const staged = path.join(f.adapter.runtimeRoot, `.staging-${path.basename(state.root)}`);
  await fs.rename(state.root, staged);
  let commands = 0;
  await assert.rejects(runStartupWorker(staged, { exec: async () => { commands++; } }), { code: 'unsafe_runtime_state' });
  assert.equal(commands, 0);
  assert.equal(await exists(path.join(staged, 'pending')), true);
});

test('claim and cancellation compete on the actual permit; late worker cannot create', async (t) => {
  const f = await fixture(t); const state = await f.publish();
  const results = await Promise.allSettled([
    fs.rename(path.join(state.root, 'pending'), path.join(state.root, 'starting')),
    fs.rename(path.join(state.root, 'pending'), path.join(state.root, 'cancelled')),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  let commands = 0;
  assert.equal((await runStartupWorker(state.root, { exec: async () => { commands++; } })).claimed, false);
  assert.equal(commands, 0);
});

test('claimed startup without terminal receipt recovers a dead worker and allows fresh demand', async (t) => {
  const f = await fixture(t); const state = await f.publish();
  await fs.mkdir(path.join(state.root, 'pending', 'claim'));
  await writeAtomic(path.join(state.root, 'pending', 'claim', 'worker.json'), { nonce: state.nonce, role: role(109) });
  await fs.rename(path.join(state.root, 'pending'), path.join(state.root, 'starting'));
  f.adapter.observe = async () => null;
  await f.adapter.reconcilePersisted();
  assert.equal(await exists(state.root), false);
  assert.equal(await exists(f.binaryPath), true);
  const fresh = await f.publish();
  assert.notEqual(fresh.root, state.root);
});

test('ready receipt requires all roles and acknowledged running web; failed prelaunch receipt remains valid', async (t) => {
  const f = await fixture(t); const s = await f.publish(); const receipt = failedReceipt(s);
  await writeAtomic(path.join(s.root, 'receipt.json'), receipt);
  assert.equal((await readReceipt(s)).outcome, 'failed');
  for (const change of [{ outcome: 'ready' }, { webLaunch: 'running' }, { sessionIssued: true }, { creationClosed: false }]) {
    await writeAtomic(path.join(s.root, 'receipt.json'), { ...receipt, ...change });
    await assert.rejects(readReceipt(s), { code: 'unsafe_runtime_state' });
  }
});

test('immutable metadata rejects malformed hashes and parent identities', async (t) => {
  const f = await fixture(t); const s = await f.publish();
  for (const change of [{ hashes: { ...s.hashes, binary: 'bad' } }, { parent: { pid: -1, start: 'bad' } }]) {
    await writeAtomic(path.join(s.root, 'state.json'), { ...s, ...change });
    await assert.rejects(validateState(s.root), { code: 'unsafe_runtime_state' });
  }
});

// Native tmux with LC_ALL=C renders control characters in format strings as '_'.
// Expand the requested format so tests exercise the query/parser contract.
function tmuxCFormat(format, fields) {
  return format.replace(/[\x00-\x1f\x7f]/g, '_')
    .replace(/#\{([^}]+)\}/g, (_, key) => String(fields[key] ?? '')) + '\n';
}

const initializationLog = 'INFO   |zellij_server            | 2026-09-20 19:45:18.123 [main      ] zellij-server/src/lib.rs:1044: FirstClientConnected: session initialized, spawning tabs \n';

async function workerFixture(t, { log = initializationLog, held = false, webExited = false, authFailure = false, launchFailure = false, backgroundPlugin = false } = {}) {
  const f = await fixture(t); const state = await f.publish();
  t.after(() => fs.rm(state.socketRoot, { recursive: true, force: true }));
  const commands = []; const phases = [];
  const logDirectory = path.join(state.root, 'tmp', `zellij-${process.getuid()}`, 'zellij-log');
  await fs.mkdir(logDirectory, { recursive: true, mode: 0o700 });
  const logFile = path.join(logDirectory, 'zellij.log');
  if (log !== null) await fs.writeFile(logFile, log, { mode: 0o600 });
  const roles = { outer: role(110, `tmux -S ${state.outerSocket}`), client: role(111, `${state.binaryPath} --session ${state.sessionName}`),
    daemon: role(112, `${state.binaryPath} --server ${state.socketRoot}/${state.sessionName}`),
    inner: role(113, 'tmux attach-session', 112), web: role(114, `${state.binaryPath} web --start`) };
  const opts = {
    workerIdentity: async () => role(109), launchServer: async () => 110,
    observe: async (pid) => held && pid === 113 ? null : Object.values(roles).find((r) => r.pid === pid) || null,
    snapshot: async () => Object.values(roles),
    wait: async (check) => { const result = await check(); if (!result) throw new Error('unsettled fixture'); return result; },
    phase: async (name) => { phases.push(name); assert.equal(await exists(path.join(state.root, 'receipt.json')), false); },
    probe: () => ({ connect: async () => { if (authFailure) throw new Error('auth failed'); }, close() {} }),
    exec: async (file, args) => {
      assert.equal(await exists(path.join(state.root, 'starting')), true, 'native commands require claim');
      assert.equal(await exists(path.join(state.root, 'receipt.json')), false, 'no command after receipt');
      commands.push(args);
      if (args.includes('new-session') && launchFailure) throw new Error('lost acknowledgement');
      if (args.includes('display-message')) return { stdout: tmuxCFormat(args.at(-1), {
        window_width: 140, window_height: 40, status: 'on',
        pid: 110, pane_pid: args.includes('observer:web') ? 114 : 111,
        pane_dead: args.includes('observer:web') && webExited ? 1 : 0, pane_dead_status: '' }) };
      if (args.includes('list-panes')) return { stdout: JSON.stringify([...(backgroundPlugin ? [{ is_plugin: true, is_suppressed: true, plugin_url: 'zellij:link' }] : []), { is_plugin: false, exited: held,
        terminal_command: [state.tmuxPath, '-u', '-N', '-S', state.tmuxSocket, 'attach-session', '-r', '-t', '=codex-main'].join(' ') }]) };
      if (args.includes('list-clients')) return { stdout: tmuxCFormat(args.at(-1), { client_pid: 113, client_readonly: 1, session_name: 'codex-main' }) };
      if (args.includes('--create-read-only-token')) return { stdout: 'token_1: 12345678-1234-1234-1234-123456789abc\n' };
      return { stdout: '' };
    },
  };
  return { ...f, state, opts, commands, phases, roles, logFile };
}
for (const [name, options, outcome] of [['ready', {}, 'ready'], ['held target exit', { held: true }, 'failed'],
  ['foreground web exit', { webExited: true }, 'failed'], ['authentication failure', { authFailure: true }, 'failed']]) {
  test(`worker ${name} closes creation before terminal receipt`, async (t) => {
    const f = await workerFixture(t, options);
    assert.equal((await runStartupWorker(f.state.root, f.opts)).outcome, outcome);
    const receipt = await readReceipt(f.state);
    assert.equal(receipt.outcome, outcome);
    assert.equal(f.phases.at(-1), 'before-receipt');
    if (outcome === 'ready') assert.equal(receipt.roles.inner.pid, 113);
    if (options.held) assert.equal(receipt.webLaunch, 'not-issued');
    if (options.webExited) assert.equal(receipt.webLaunch, 'exited');
  });
}
test('worker waits passively for initialization before any Zellij CLI query', async (t) => {
  const f = await workerFixture(t, { log: null });
  const originalWait = f.opts.wait;
  let withheld = false;
  f.opts.wait = async (check) => {
    const result = await check();
    if (result) return result;
    assert.equal(withheld, false);
    withheld = true;
    assert.equal(f.commands.some((args) => args.includes('list-panes') || args.includes('--create-read-only-token')), false);
    await fs.writeFile(f.logFile, initializationLog, { mode: 0o600 });
    return originalWait(check);
  };
  const originalExec = f.opts.exec;
  f.opts.exec = async (file, args) => {
    if (file === f.state.binaryPath) assert.equal(withheld, true, 'Zellij CLI must not beat initialization');
    return originalExec(file, args);
  };
  assert.equal((await runStartupWorker(f.state.root, f.opts)).outcome, 'ready');
  assert.equal(withheld, true);
});

for (const kind of ['missing', 'malformed', 'symlink-file', 'symlink-parent', 'public-file', 'oversized', 'no-daemon', 'duplicate-daemon']) {
  test(`initialization gate fails closed for ${kind} before Zellij CLI`, async (t) => {
    const f = await workerFixture(t, { log: kind === 'missing' ? null : initializationLog });
    if (kind === 'malformed') await fs.writeFile(f.logFile, initializationLog.replace('zellij_server', 'other_module'));
    if (kind === 'public-file') await fs.chmod(f.logFile, 0o644);
    if (kind === 'oversized') await fs.writeFile(f.logFile, initializationLog + 'x'.repeat(128 * 1024));
    if (kind === 'symlink-file') {
      const target = path.join(f.dataDir, 'outside.log');
      await fs.rename(f.logFile, target); await fs.symlink(target, f.logFile);
    }
    if (kind === 'symlink-parent') {
      const directory = path.dirname(f.logFile); const target = path.join(f.dataDir, 'outside-logs');
      await fs.rename(directory, target); await fs.symlink(target, directory);
    }
    if (kind === 'no-daemon') f.opts.snapshot = async () => [];
    if (kind === 'duplicate-daemon') f.opts.snapshot = async () => [f.roles.daemon, { ...f.roles.daemon, pid: 999 }];
    let zellijCalls = 0;
    const originalExec = f.opts.exec;
    f.opts.exec = async (file, args) => { if (file === f.state.binaryPath) zellijCalls++; return originalExec(file, args); };
    assert.deepEqual(await runStartupWorker(f.state.root, f.opts), { claimed: true, settled: false });
    assert.equal(zellijCalls, 0);
    assert.equal(await exists(path.join(f.state.root, 'receipt.json')), false);
  });
}

test('C-locale tmux formats preserve startup identities and healthy active client', async (t) => {
  const f = await workerFixture(t);
  assert.equal((await runStartupWorker(f.state.root, f.opts)).outcome, 'ready');
  f.adapter.active = { ...f.state, receipt: await readReceipt(f.state) };
  f.adapter.snapshot = f.opts.snapshot;
  f.adapter.observe = f.opts.observe;
  let readonly = 1;
  f.adapter.exec = async (file, args) => ({ stdout: tmuxCFormat(args.at(-1), {
    client_pid: 113, client_readonly: readonly, session_name: 'codex-main',
  }) });
  let failures = 0; f.adapter.on('failure', () => { failures++; });
  await f.adapter._checkActive();
  assert.equal(failures, 0, 'healthy read-only client must remain active');
  readonly = 0;
  await f.adapter._checkActive();
  assert.equal(failures, 1, 'loss of read-only attachment must still fail');
});

test('unexpected background plugin keeps startup fenced', async (t) => {
  const f = await workerFixture(t, { backgroundPlugin: true });
  assert.deepEqual(await runStartupWorker(f.state.root, f.opts), { claimed: true, settled: false });
  assert.equal(await exists(path.join(f.state.root, 'receipt.json')), false);
  assert.match(JSON.parse(await fs.readFile(path.join(f.state.root, 'startup-error.json'), 'utf8')).message, /Unexpected fixed Observer layout/);
});

test('lost creation acknowledgement never publishes a terminal receipt', async (t) => {
  const f = await workerFixture(t, { launchFailure: true });
  assert.deepEqual(await runStartupWorker(f.state.root, f.opts), { claimed: true, settled: false });
  assert.equal(await exists(path.join(f.state.root, 'receipt.json')), false);
});

test('retired interruption resumes even with missing metadata and no native commands', async (t) => {
  const f = await fixture(t, { phase: async (name) => { if (name === 'retired') throw new Error('interrupted retirement'); } });
  const s = await f.publish();
  await assert.rejects(f.adapter.reconcilePersisted(), /interrupted retirement/);
  const [name] = await fs.readdir(f.adapter.runtimeRoot);
  assert.ok(name.startsWith('.retired-'));
  await fs.unlink(path.join(f.adapter.runtimeRoot, name, 'state.json'));
  f.calls.length = 0;
  await f.adapter.reconcilePersisted();
  assert.deepEqual(await fs.readdir(f.adapter.runtimeRoot), []);
  assert.equal(f.calls.length, 0);
  assert.equal(await exists(s.root), false);
});

test('active inner role disappearance emits one failure and read-only loss is detected', async (t) => {
  const f = await workerFixture(t);
  await runStartupWorker(f.state.root, f.opts);
  f.adapter.active = { ...f.state, receipt: await readReceipt(f.state) };
  f.adapter.snapshot = f.opts.snapshot;
  f.adapter.observe = f.opts.observe;
  f.adapter.exec = f.opts.exec;
  // Queries after receipt are expected here; use a separate strict mock.
  f.adapter.exec = async () => ({ stdout: '113|0|codex-main\n' });
  let failures = 0; f.adapter.on('failure', () => { failures++; });
  await f.adapter._checkActive(); await f.adapter._checkActive();
  assert.equal(failures, 1);
  f.adapter.active.failed = false;
  f.adapter.observe = async () => null;
  await f.adapter._checkActive();
  assert.equal(failures, 2);
});

test('settled cleanup tolerates partial socket deletion and repeats absence before retirement', async (t) => {
  const f = await fixture(t); const s = await f.publish();
  t.after(() => fs.rm(s.socketRoot, { recursive: true, force: true }));
  await fs.rename(path.join(s.root, 'pending'), path.join(s.root, 'starting'));
  await writeAtomic(path.join(s.root, 'receipt.json'), failedReceipt(s));
  await fs.mkdir(s.socketRoot, { mode: 0o700 });
  // Models interruption after owner.json unlink but before socket-root rmdir.
  await writeAtomic(path.join(s.root, 'retirement.json'), { nonce: s.nonce, socketRemoval: true });
  let observations = 0;
  f.adapter.snapshot = async () => { observations++; return []; };
  f.adapter.observe = async () => null;
  await f.adapter.reconcilePersisted();
  assert.ok(observations > 0);
  assert.equal(await exists(s.socketRoot), false);
  assert.equal(await exists(s.root), false);
});

test('missing socket owner without retirement evidence remains fenced', async (t) => {
  const f = await fixture(t); const s = await f.publish();
  t.after(() => fs.rm(s.socketRoot, { recursive: true, force: true }));
  await fs.rename(path.join(s.root, 'pending'), path.join(s.root, 'starting'));
  await writeAtomic(path.join(s.root, 'receipt.json'), failedReceipt(s));
  await fs.mkdir(s.socketRoot, { mode: 0o700 });
  await assert.rejects(f.adapter.reconcilePersisted(), { code: 'ENOENT' });
  assert.equal(await exists(s.root), true);
});

test('failed web cleanup preserves an unrelated listener on the selected port', async (t) => {
  const { default: net } = await import('node:net');
  const listener = net.createServer((socket) => socket.end('foreign listener'));
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => listener.close(resolve)));
  const f = await fixture(t, { choosePort: async () => listener.address().port });
  const s = await f.publish();
  await fs.rename(path.join(s.root, 'pending'), path.join(s.root, 'starting'));
  await writeAtomic(path.join(s.root, 'receipt.json'), { ...failedReceipt(s), sessionIssued: true, webLaunch: 'exited',
    roles: { outer: role(110), client: role(111), daemon: role(112), inner: role(113), web: null } });
  f.adapter.observe = async () => null;
  await f.adapter.reconcilePersisted();
  assert.equal(await exists(s.root), false);
  assert.equal(listener.listening, true);
  const text = await new Promise((resolve, reject) => {
    const client = net.createConnection(s.port, '127.0.0.1'); let value = '';
    client.on('data', (chunk) => { value += chunk; }); client.on('end', () => resolve(value)); client.on('error', reject);
  });
  assert.equal(text, 'foreign listener');
});


test('changed executable or self-consistent changed layout cannot reach native commands', async (t) => {
  const f = await fixture(t); const s = await f.publish();
  const original = await fs.readFile(f.binaryPath);
  await fs.writeFile(f.binaryPath, 'changed executable');
  await assert.rejects(validateState(s.root), { code: 'unsafe_runtime_state' });
  await fs.writeFile(f.binaryPath, original);
  const changed = 'layout { pane command="sh" }\n';
  await fs.writeFile(s.layoutFile, changed);
  await writeAtomic(path.join(s.root, 'state.json'), { ...s, hashes: { ...s.hashes, layoutFile: digest(changed) } });
  let commands = 0;
  await assert.rejects(runStartupWorker(s.root, { exec: async () => { commands++; } }), { code: 'unsafe_runtime_state' });
  assert.equal(commands, 0);
});

test('optional Observer import does not resolve a platform-specific temp directory', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const moduleUrl = new URL('../src/lib/observer-containment.js', import.meta.url).href;
  const script = `import fs from 'node:fs/promises'; fs.realpath = async () => { throw new Error('unsupported temp'); }; await import(${JSON.stringify(moduleUrl)});`;
  await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script]);
});

test('interrupted startup cancels issuer before freezing private producers and catches a late child', async (t) => {
  const f = await fixture(t); const s = await f.publish();
  await fs.mkdir(path.join(s.root, 'pending', 'claim'));
  const worker = role(109, `node worker ${s.root}`);
  const server = role(110, 'tmux: server');
  const daemon = role(112, `zellij --server ${s.socketRoot}/session`);
  const inner = role(113, 'tmux attach-session -r', 112);
  const foreign = role(999, 'foreign listener');
  await writeAtomic(path.join(s.root, 'pending', 'claim', 'worker.json'), { nonce: s.nonce, role: worker });
  await fs.rename(path.join(s.root, 'pending'), path.join(s.root, 'starting'));
  await writeAtomic(path.join(s.root, 'starting', 'server.json'), { nonce: s.nonce, role: server });
  const live = new Map([worker, server, daemon, inner, foreign].map((r) => [r.pid, r]));
  const signals = [];
  let lateChild = false;
  f.adapter.observe = async (pid) => live.get(pid) || null;
  f.adapter.snapshot = async () => [...live.values()];
  f.adapter.cleanupTimeoutMs = 1000;
  f.adapter.signal = (pid, signal) => {
    assert.equal(fsSync.existsSync(path.join(s.root, 'recovery.json')), true, 'cancel marker precedes all signals');
    signals.push([pid, signal]);
    if (pid === 110 && signal === 'SIGSTOP' && !lateChild) {
      live.set(115, role(115, 'child forked just before server stopped', 110));
      lateChild = true;
    }
    if (signal === 'SIGKILL') live.delete(pid);
  };
  await f.adapter.reconcilePersisted();
  assert.deepEqual(signals[0], [109, 'SIGKILL']);
  assert.ok(signals.some(([pid, signal]) => pid === 115 && signal === 'SIGKILL'));
  assert.ok(signals.some(([pid, signal]) => pid === 113 && signal === 'SIGKILL'));
  assert.equal(signals.some(([pid]) => pid === 999), false);
  assert.deepEqual([...live.keys()], [999]);
  assert.equal(await exists(s.root), false);
});

test('reused recorded server PID does not authorize its foreign replacement or descendants', async (t) => {
  const f = await fixture(t); const s = await f.publish();
  await fs.mkdir(path.join(s.root, 'pending', 'claim'));
  await writeAtomic(path.join(s.root, 'pending', 'claim', 'worker.json'), { nonce: s.nonce, role: role(109) });
  await fs.rename(path.join(s.root, 'pending'), path.join(s.root, 'starting'));
  await writeAtomic(path.join(s.root, 'starting', 'server.json'), { nonce: s.nonce, role: role(110) });
  const live = [{ ...role(110, 'unrelated server'), start: 'replacement' }, role(111, 'foreign child', 110)];
  f.adapter.observe = async (pid) => live.find((r) => r.pid === pid) || null;
  f.adapter.snapshot = async () => live;
  f.adapter.signal = () => assert.fail('foreign process signaled');
  await f.adapter.reconcilePersisted();
  assert.equal(await exists(s.root), false);
});

test('cancelled worker held before outer launch cannot issue a late native command', async (t) => {
  const f = await workerFixture(t);
  let launches = 0;
  f.opts.launchServer = async () => { launches++; return 110; };
  f.opts.phase = async (name) => {
    if (name === 'before-outer') await writeAtomic(path.join(f.state.root, 'recovery.json'), { nonce: f.state.nonce, cancelled: true });
  };
  await assert.rejects(runStartupWorker(f.state.root, f.opts), { code: 'startup_cancelled' });
  assert.equal(launches, 0);
  assert.equal(f.commands.length, 0);
  assert.equal(await exists(path.join(f.state.root, 'receipt.json')), false);
});

test('all tmux pane creation disables server bootstrap and follows persisted server identity', async (t) => {
  const f = await workerFixture(t);
  const exec = f.opts.exec;
  f.opts.exec = async (file, args) => {
    if (args.includes('new-session') || args.includes('new-window')) {
      assert.equal(args[0], '-N');
      const server = JSON.parse(await fs.readFile(path.join(f.state.root, 'starting', 'server.json'), 'utf8'));
      assert.equal(server.nonce, f.state.nonce);
      assert.equal(server.role.pid, 110);
      assert.equal(await exists(path.join(f.state.root, 'starting', 'server-permit.json')), true);
    }
    return exec(file, args);
  };
  assert.equal((await runStartupWorker(f.state.root, f.opts)).outcome, 'ready');
});

test('malformed claimed worker identity fails closed without signals', async (t) => {
  const f = await fixture(t); const s = await f.publish();
  await fs.mkdir(path.join(s.root, 'pending', 'claim'));
  await writeAtomic(path.join(s.root, 'pending', 'claim', 'worker.json'), { nonce: 'wrong', role: role(109) });
  await fs.rename(path.join(s.root, 'pending'), path.join(s.root, 'starting'));
  f.adapter.signal = () => assert.fail('malformed authority must not signal');
  await assert.rejects(f.adapter.reconcilePersisted(), { code: 'unsafe_runtime_state' });
  assert.equal(await exists(s.root), true);
});

test('historical receipt-only generation without recovery contract remains fenced', async (t) => {
  const f = await fixture(t); const s = await f.publish();
  delete s.startupRecovery;
  const config = 'set-option -g remain-on-exit on\n';
  await fs.writeFile(s.tmuxConfig, config);
  s.hashes.tmuxConfig = digest(config);
  await writeAtomic(path.join(s.root, 'state.json'), s);
  await fs.rename(path.join(s.root, 'pending'), path.join(s.root, 'starting'));
  f.adapter.signal = () => assert.fail('old generation must not enter new recovery');
  await assert.rejects(f.adapter.reconcilePersisted(), { code: 'startup_incomplete' });
  assert.equal(await exists(s.root), true);
});

test('target preflight distinguishes verified absence from command failures', async (t) => {
  const f = await fixture(t);
  const missing = Object.assign(new Error('tmux has-session failed'), { code: 1, stderr: "can't find session: codex-main\n" });
  f.adapter.exec = async (_file, args) => {
    if (args.includes('has-session')) throw missing;
    return { stdout: 'sentinel\n' };
  };
  await assert.rejects(f.publish(), { code: 'target_unavailable' });
  assert.equal(await exists(f.adapter.runtimeRoot), false);
  for (const error of [Object.assign(new Error('permission'), { code: 1, stderr: 'permission denied' }),
    Object.assign(new Error('binary'), { code: 'ENOENT' }),
    Object.assign(new Error('timeout'), { code: 1, killed: true })]) {
    f.adapter.exec = async () => { throw error; };
    await assert.rejects(f.publish(), (actual) => actual === error);
  }
  const socket = path.join(f.dataDir, 'missing-target.sock');
  f.adapter.exec = async () => { throw Object.assign(new Error('absent'), { code: 1, stderr: `error connecting to ${socket} (No such file or directory)\n` }); };
  await assert.rejects(f.publish(), { code: 'target_unavailable' });
  assert.equal(await exists(f.adapter.runtimeRoot), false);
});

test('target disappearance between preflight and socket resolution stays retryable', async (t) => {
  const f = await fixture(t);
  const missing = Object.assign(new Error('target disappeared'), { code: 1 });
  let probes = 0;
  f.adapter.exec = async (_file, args) => {
    if (args.includes('has-session') && ++probes === 1) return { stdout: '' };
    if (args.includes('list-sessions')) return { stdout: 'sentinel\n' };
    throw missing;
  };
  await assert.rejects(f.publish(), (error) => error.code === 'target_unavailable' && error.cause === missing);
  assert.equal(probes, 2);
  assert.equal(await exists(f.adapter.runtimeRoot), false);
});

test('socket resolution preserves unrelated failures and inconclusive target probes', async (t) => {
  const f = await fixture(t);
  for (const mode of ['present', 'probe-failed', 'timeout', 'permission']) {
    const original = Object.assign(new Error(mode), { code: mode === 'permission' ? 'EACCES' : 1,
      ...(mode === 'timeout' ? { killed: true } : {}) });
    let probes = 0;
    f.adapter.exec = async (_file, args) => {
      if (args.includes('has-session')) {
        if (++probes === 1 || mode === 'present') return { stdout: '' };
        throw Object.assign(new Error('probe failed'), { code: 'EACCES' });
      }
      throw original;
    };
    await assert.rejects(f.publish(), (error) => error === original);
    assert.equal(probes, ['timeout', 'permission'].includes(mode) ? 1 : 2);
  }
});

for (const code of ['startup_failed', 'startup_incomplete', 1]) {
  test(`failed start ${code} classifies confirmed target absence only after cleanup`, async (t) => {
    const f = await fixture(t);
    let cleaned = false;
    f.adapter._launchWorker = async () => {};
    const original = Object.assign(new Error('target attach failed'), { code });
    f.adapter._waitReceipt = async () => { throw original; };
    const cleanup = f.adapter._cleanup.bind(f.adapter);
    f.adapter._cleanup = async (state) => { await cleanup(state); cleaned = true; };
    const exec = f.adapter.exec;
    let probes = 0;
    f.adapter.exec = async (file, args) => {
      if (args.includes('has-session') && ++probes > 1) {
        assert.equal(cleaned, true);
        assert.deepEqual(await fs.readdir(f.adapter.runtimeRoot), []);
        throw Object.assign(new Error('missing target'), { code: 1 });
      }
      if (args.includes('list-sessions')) return { stdout: 'sentinel\n' };
      return exec(file, args);
    };
    await assert.rejects(f.adapter.startGeneration({ generation: 1, binaryPath: f.binaryPath, runtime: 'codex' }),
      (error) => error.code === 'target_unavailable' && error.cause === original);
    assert.equal(probes, 2);
    assert.equal(f.adapter.active, null);
  });
}

test('failed-start cleanup uncertainty prevents target-loss classification', async (t) => {
  const f = await fixture(t);
  const original = Object.assign(new Error('attach failed'), { code: 'startup_failed' });
  const cleanupError = Object.assign(new Error('absence unproven'), { code: 'cleanup_failed' });
  f.adapter._launchWorker = async () => { throw original; };
  f.adapter._cleanup = async () => { throw cleanupError; };
  const exec = f.adapter.exec;
  let probes = 0;
  f.adapter.exec = async (file, args) => {
    if (args.includes('has-session') && ++probes > 1) throw Object.assign(new Error('target absent'), { code: 1 });
    if (args.includes('list-sessions')) return { stdout: 'sentinel\n' };
    return exec(file, args);
  };
  await assert.rejects(f.adapter.startGeneration({ generation: 1, binaryPath: f.binaryPath, runtime: 'codex' }),
    (error) => error === original && error.cleanupError === cleanupError);
  assert.equal(probes, 1);
});

test('failed starts preserve target-present, inconclusive and explicit safety errors', async (t) => {
  for (const mode of ['present', 'probe-failed', 'unsafe_runtime_state', 'EACCES', 'unsupported_runtime']) {
    const f = await fixture(t);
    const code = ['present', 'probe-failed'].includes(mode) ? 'startup_failed' : mode;
    const original = Object.assign(new Error(mode), { code });
    f.adapter._launchWorker = async () => { throw original; };
    const exec = f.adapter.exec;
    let probes = 0;
    f.adapter.exec = async (file, args) => {
      if (args.includes('has-session') && ++probes > 1 && mode === 'probe-failed') {
        throw Object.assign(new Error('probe denied'), { code: 'EACCES' });
      }
      return exec(file, args);
    };
    await assert.rejects(f.adapter.startGeneration({ generation: 1, binaryPath: f.binaryPath, runtime: 'codex' }),
      (error) => error === original && !error.cleanupError);
    assert.deepEqual(await fs.readdir(f.adapter.runtimeRoot), []);
    assert.equal(probes, ['present', 'probe-failed'].includes(mode) ? 2 : 1);
  }
});

test('worker measures the Agent before attachment and sizes the private client including status rows', async (t) => {
  const f = await workerFixture(t);
  assert.equal((await runStartupWorker(f.state.root, f.opts)).outcome, 'ready');
  const query = f.commands.findIndex((args) => args.includes('#{window_width} #{window_height} #{status}'));
  const launch = f.commands.findIndex((args) => args.includes('new-session'));
  assert.ok(query >= 0 && query < launch);
  assert.deepEqual(f.commands[query], ['-N', '-S', f.state.tmuxSocket, 'display-message', '-p', '-t', '=codex-main:', '#{window_width} #{window_height} #{status}']);
  const args = f.commands[launch];
  assert.equal(args[args.indexOf('-x') + 1], '140');
  assert.equal(args[args.indexOf('-y') + 1], '41');
});

test('invalid initial Agent dimensions fail closed before any private process is launched', async (t) => {
  for (const output of ['', '501 40 on', '140 200 on', '140 40 unknown']) await t.test(JSON.stringify(output), async (t) => {
    const f = await workerFixture(t);
    let launched = false;
    f.opts.launchServer = async () => { launched = true; throw new Error('must not launch'); };
    f.opts.exec = async (_file, args) => {
      assert.ok(args.includes('display-message'));
      return { stdout: output };
    };
    assert.equal((await runStartupWorker(f.state.root, f.opts)).outcome, 'failed');
    assert.equal(launched, false);
    const receipt = await readReceipt(f.state);
    assert.equal(receipt.error.code, 'target_size_unavailable');
    assert.equal(receipt.sessionIssued, false);
  });
});

test('containment resize mutates only its private window and fences stale generations', async (t) => {
  const f = await fixture(t);
  const active = await f.publish();
  f.adapter.active = active;
  f.calls.length = 0;
  assert.equal(await f.adapter.resize(active, { cols: 140, rows: 41 }), true);
  assert.deepEqual(f.calls, [['-N', '-S', active.outerSocket, 'resize-window', '-t', 'observer:client', '-x', '140', '-y', '41']]);
  assert.equal(await f.adapter.resize({ ...active }, { cols: 100, rows: 30 }), false);
  await assert.rejects(f.adapter.resize(active, { cols: 501, rows: 30 }), { code: 'invalid_size' });
  active.resizeClosed = true;
  assert.equal(await f.adapter.resize(active, { cols: 100, rows: 30 }), false);
  assert.equal(f.calls.length, 1);
});

test('containment serializes private resizes and cleanup drains issued commands before stopping', async (t) => {
  const f = await fixture(t);
  const active = await f.publish();
  f.adapter.active = active;
  const events = [];
  let finish;
  f.adapter.exec = async (_file, args) => {
    events.push(args);
    await new Promise((resolve) => { finish = resolve; });
  };
  const first = f.adapter.resize(active, { cols: 140, rows: 41 });
  const second = f.adapter.resize(active, { cols: 120, rows: 36 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.length, 1);
  // Stop cleanup just after its drain, before any filesystem retirement.
  f.adapter._assertOwnerGone = async () => { events.push('cleanup'); throw new Error('fixture end'); };
  const cleanup = assert.rejects(f.adapter._cleanup(active), /fixture end/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.length, 1);
  finish();
  assert.equal(await first, false);
  assert.equal(await second, false);
  await cleanup;
  assert.equal(events.length, 2);
  assert.equal(events[1], 'cleanup');
});

for (const [status, rows] of [['off', 40], ['on', 41], ['2', 42], ['5', 45]]) {
  test(`startup preserves raw Agent window dimensions with status ${status}`, async (t) => {
    const f = await workerFixture(t);
    const exec = f.opts.exec;
    let queries = 0;
    f.opts.exec = async (file, args) => {
      const result = await exec(file, args);
      if (args.includes('#{window_width} #{window_height} #{status}')) {
        queries += 1;
        return { stdout: `140 40 ${status}` };
      }
      return result;
    };
    f.opts.probe = () => ({ connect: async ({ size }) => assert.deepEqual(size, { cols: 140, rows }), close() {} });
    assert.equal((await runStartupWorker(f.state.root, f.opts)).outcome, 'ready');
    const launch = f.commands.find((args) => args.includes('new-session'));
    assert.equal(launch[launch.indexOf('-y') + 1], String(rows));
    assert.equal(queries, 3, 'baseline, post-attach, and final readiness verification');
  });
}

for (const [name, output, expected] of [
  ['width changed', '139 40 on', 'target_size_changed'],
  ['height changed but total rows equal', '140 39 2', 'target_size_changed'],
  ['unknown dimensions', '', 'target_size_unavailable'],
]) {
  test(`post-attach guard rejects ${name} without starting web or resizing Agent`, async (t) => {
    const f = await workerFixture(t);
    const exec = f.opts.exec;
    let queries = 0;
    f.opts.exec = async (file, args) => {
      const result = await exec(file, args);
      if (args.includes('#{window_width} #{window_height} #{status}') && ++queries > 1) return { stdout: output };
      return result;
    };
    assert.equal((await runStartupWorker(f.state.root, f.opts)).outcome, 'failed');
    const receipt = await readReceipt(f.state);
    assert.equal(receipt.error.code, expected);
    assert.equal(receipt.roles.inner.pid, 113, 'identified inner client is available for cleanup');
    assert.equal(receipt.webLaunch, 'not-issued');
    assert.equal(f.commands.some((args) => args.includes('--create-read-only-token')), false);
    assert.equal(f.commands.some((args) => args.includes('resize-window') || args.includes('resize-pane')), false);
  });
}

test('final readiness guard also rejects Agent changes during web handshake', async (t) => {
  const f = await workerFixture(t);
  const exec = f.opts.exec;
  let queries = 0;
  f.opts.exec = async (file, args) => {
    const result = await exec(file, args);
    if (args.includes('#{window_width} #{window_height} #{status}') && ++queries === 3) return { stdout: '120 35 on' };
    return result;
  };
  assert.equal((await runStartupWorker(f.state.root, f.opts)).outcome, 'failed');
  assert.equal((await readReceipt(f.state)).error.code, 'target_size_changed');
});

test('startGeneration waits for failed-guard cleanup before propagating the error', async (t) => {
  const f = await workerFixture(t);
  const exec = f.opts.exec;
  let queries = 0;
  f.opts.exec = async (file, args) => {
    const result = await exec(file, args);
    if (args.includes('#{window_width} #{window_height} #{status}') && ++queries > 1) return { stdout: '100 29 on' };
    return result;
  };
  f.adapter.reconcilePersisted = async () => [];
  f.adapter._publish = async () => f.state;
  f.adapter._launchWorker = () => runStartupWorker(f.state.root, f.opts);
  let finishCleanup;
  f.adapter._cleanup = async (state) => {
    assert.equal(state, f.state);
    assert.equal((await readReceipt(state)).error.code, 'target_size_changed');
    await new Promise((resolve) => { finishCleanup = resolve; });
  };
  let completed = false;
  const rejected = assert.rejects(f.adapter.startGeneration({ generation: 1 }), { code: 'target_size_changed' })
    .then(() => { completed = true; });
  for (let index = 0; index < 200 && !finishCleanup; index += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(typeof finishCleanup, 'function');
  assert.equal(completed, false);
  assert.equal(f.adapter.active, null);
  finishCleanup(); await rejected;
  assert.equal(completed, true);
});

function agentTmux({ status = 'on', applied = null } = {}) {
  const calls = [];
  let size = { cols: 80, rows: 24 };
  const exec = async (file, args) => {
    calls.push([file, args]);
    const format = args.at(-1);
    if (args.includes('has-session')) return { stdout: '' };
    if (format === '#{socket_path}') return { stdout: '/tmp/agent.sock\n' };
    if (format === '#{status}') return { stdout: `${status}\n` };
    if (args.includes('resize-window')) {
      size = applied || { cols: Number(args[args.indexOf('-x') + 1]), rows: Number(args[args.indexOf('-y') + 1]) };
      return { stdout: '' };
    }
    if (format === '#{window_width} #{window_height} #{status}') return { stdout: `${size.cols} ${size.rows} ${status}\n` };
    throw new Error(`unexpected tmux call ${args.join(' ')}`);
  };
  return { calls, exec };
}

test('resizeAgent resizes only the runtime session on its own socket and verifies the result', async (t) => {
  const tmux = agentTmux();
  const f = await fixture(t, { exec: tmux.exec, tmuxPath: '/usr/bin/tmux' });
  assert.deepEqual(await f.adapter.resizeAgent({ runtime: 'claude', cols: 132, rows: 60 }), { cols: 132, rows: 60, statusLines: 1 });
  assert.ok(tmux.calls.every(([file]) => file === '/usr/bin/tmux'));
  const resize = tmux.calls.find(([, args]) => args.includes('resize-window'))[1];
  assert.deepEqual(resize, ['-N', '-S', '/tmp/agent.sock', 'resize-window', '-t', '=claude-main:', '-x', '132', '-y', '60']);
  const codex = agentTmux();
  f.adapter.exec = codex.exec;
  await f.adapter.resizeAgent({ runtime: 'codex', cols: 100, rows: 40 });
  assert.ok(codex.calls.find(([, args]) => args.includes('resize-window'))[1].includes('=codex-main:'));
});

test('resizeAgent rejects heights that overflow with the status line and unverified results', async (t) => {
  const tall = agentTmux({ status: '3' });
  const f = await fixture(t, { exec: tall.exec });
  await assert.rejects(f.adapter.resizeAgent({ runtime: 'claude', cols: 120, rows: 198 }), { code: 'invalid_size', maxRows: 197 });
  assert.equal(tall.calls.some(([, args]) => args.includes('resize-window')), false);
  const off = agentTmux({ status: 'off' });
  f.adapter.exec = off.exec;
  assert.deepEqual(await f.adapter.resizeAgent({ runtime: 'claude', cols: 120, rows: 200 }), { cols: 120, rows: 200, statusLines: 0 });

  const clamped = agentTmux({ applied: { cols: 120, rows: 45 } });
  f.adapter.exec = clamped.exec;
  await assert.rejects(f.adapter.resizeAgent({ runtime: 'claude', cols: 120, rows: 50 }), { code: 'agent_resize_failed' });
  await assert.rejects(f.adapter.resizeAgent({ runtime: 'other', cols: 120, rows: 50 }), { code: 'unsupported_runtime' });
});

test('resizeAgent reports a missing Agent session without resizing', async (t) => {
  const calls = [];
  const f = await fixture(t, { exec: async (file, args) => {
    calls.push(args);
    if (args.includes('has-session')) throw Object.assign(new Error("can't find session"), { code: 1 });
    if (args.includes('list-sessions')) return { stdout: 'other\n' };
    throw new Error('unexpected');
  } });
  await assert.rejects(f.adapter.resizeAgent({ runtime: 'claude', cols: 120, rows: 50 }), { code: 'target_unavailable' });
  assert.equal(calls.some((args) => args.includes('resize-window')), false);
});
