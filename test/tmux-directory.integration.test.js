import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { runTmuxCommand } from '../cli/lib/runtime/tmux-connection.js';
import { SessionAdapter } from '../cli/lib/runtime/session-adapter.js';
import * as helpers from '../cli/lib/runtime/tmux-helpers.js';
import { listGroupTmuxSessions } from '../cli/lib/session-group-paths.js';
import { attachCommand } from '../cli/commands/attach.js';
import { targetArgs } from '../skills/dashboard/src/lib/observer-tmux-state.js';
import { fileURLToPath } from 'node:url';

// Boundary: full Docker shell entrypoint and shared client policy, with private
// fake zylos/PM2/sleep/tmux binaries. Run for Docker tmux-call or directory-policy changes; otherwise
// skip. HOME/ZYLOS_DIR/PM2_HOME/TMPDIR are private; no server or DB is used.
for (const runtime of ['claude', 'codex']) for (const mode of ['unset', 'empty', 'private', 'shared-root', 'linked-root', 'unsafe-child', 'missing', 'shutdown-missing']) {
  test(`Docker ${runtime} entrypoint uses ${mode} directory policy for startup and shutdown`, { timeout: 10000 }, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-tmux-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const home = path.join(root, 'h'), bin = path.join(root, 'b'), tmp = path.join(root, 't');
    for (const dir of [home, bin, tmp]) fs.mkdirSync(dir, { mode: 0o700 });
    if (mode === 'shared-root') fs.chmodSync(tmp, 0o777);
    if (mode === 'linked-root') fs.symlinkSync(tmp, path.join(root, 'linked'));
    if (mode === 'unsafe-child') {
      const child = path.join(tmp, `tmux-${process.getuid()}`);
      fs.mkdirSync(child); fs.chmodSync(child, 0o707);
    }
    const zylos = path.join(home, 'zylos');
    const skills = path.join(zylos, '.claude/skills'); fs.mkdirSync(skills, { recursive: true });
    fs.symlinkSync(fileURLToPath(new URL('../skills/comm-bridge', import.meta.url)), path.join(skills, 'comm-bridge'));
    const calls = path.join(root, 'calls.jsonl');
    fs.writeFileSync(path.join(bin, 'package.json'), '{"type":"module"}');
    fs.writeFileSync(path.join(bin, 'tmux'), `#!${process.execPath}\nimport fs from 'node:fs';
fs.appendFileSync(process.env.TMUX_CALLS, JSON.stringify({args:process.argv.slice(2),
identity:process.env.ZYLOS_RUN_ID})+'\\n');
if (process.env.TMUX_REMOVE_ON_LAUNCH === '1' && process.argv.includes('new-session')) fs.renameSync(process.env.TMUX_TMPDIR, process.env.TMUX_TMPDIR+'-gone');
if (process.argv.includes('kill-session')) { console.error('fixture absent session'); process.exit(1); }\n`, { mode: 0o700 });
    for (const name of ['zylos', 'pm2', 'sleep']) fs.writeFileSync(path.join(bin, name),
      '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    const env = { ...process.env, HOME: home, ZYLOS_DIR: zylos, PM2_HOME: path.join(root, 'p'), TMPDIR: tmp,
      PATH: `${bin}:${process.env.PATH}`, TMUX_CALLS: calls, ZYLOS_RUNTIME: runtime,
      ZYLOS_RUN_ID: 'must-not-inherit', CODEX_API_KEY: 'fixture', OPENAI_API_KEY: '',
      ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '' };
    if (mode === 'shutdown-missing') env.TMUX_REMOVE_ON_LAUNCH = '1';
    delete env.TMUX;
    if (mode === 'unset') delete env.TMUX_TMPDIR;
    else if (mode === 'empty') env.TMUX_TMPDIR = '';
    else if (mode === 'linked-root') env.TMUX_TMPDIR = path.join(root, 'linked');
    else env.TMUX_TMPDIR = mode === 'missing' ? path.join(tmp, 'missing') : tmp;
    t.diagnostic(JSON.stringify({ HOME: home, ZYLOS_DIR: zylos, PM2_HOME: env.PM2_HOME,
      TMPDIR: tmp, TMUX_TMPDIR: env.TMUX_TMPDIR ?? null, binary: path.join(bin, 'tmux') }));
    const result = spawnSync('bash', [fileURLToPath(new URL('../docker/entrypoint.sh', import.meta.url))],
      { env, timeout: 8000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    if (mode === 'missing' || mode === 'unsafe-child') {
      assert.equal(result.status, 1);
      assert.match(result.stderr, mode === 'missing' ? /TMUX_DIR_MISSING/ : /TMUX_DIR_UNSAFE/);
      assert.equal(fs.existsSync(calls), false);
      return;
    }
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /fixture absent session/);
    const rows = fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse);
    if (mode === 'shutdown-missing') {
      assert.match(result.stderr, /TMUX_DIR_MISSING/);
      assert.equal(rows.length, 2, 'shutdown stops are rejected before client invocation');
      return;
    }
    assert.equal(rows.length, 4, 'stale-session stop, launch and both shutdown stops');
    const prefix = ['private', 'shared-root', 'linked-root'].includes(mode)
      ? ['-S', path.join(tmp, `tmux-${process.getuid()}`, 'default')] : [];
    assert.deepEqual(rows.map(row => row.args.slice(0, prefix.length)), rows.map(() => prefix));
    assert.deepEqual(rows.map(row => row.args[prefix.length]), ['kill-session', 'new-session', 'kill-session', 'kill-session']);
    assert.ok(rows.every(row => row.identity === undefined));
  });
}

const enabled = process.env.ZYLOS_TMUX_DIRECTORY_INTEGRATION === '1';

// Covers real connector/helpers/adapter/attach/observer isolation before and after
// private-directory removal. Run after socket-selection or directory-guard edits;
// skip unless a separate Unix user and the live user's UID are independently verified.
// The runner must isolate HOME, ZYLOS_DIR, PM2_HOME and short TMPDIR. No DB is used.
test('unavailable private directory cannot observe or mutate the dedicated user default server',
  { skip: !enabled, timeout: 30000 }, async t => {
    const uid = process.getuid();
    assert.match(process.env.ZYLOS_TEST_LIVE_UID ?? '', /^\d+$/, 'Supply independently verified live UID');
    assert.notEqual(uid, Number(process.env.ZYLOS_TEST_LIVE_UID), 'Must use a separate Unix user');
    for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) {
      assert.ok(process.env[key] && path.isAbsolute(process.env[key]), `${key} must be isolated`);
      assert.notEqual(process.env[key], os.userInfo().homedir);
    }
    const binary = process.env.TEST_TMUX_BIN || 'tmux';
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'td-'));
    fs.chmodSync(root, 0o700);
    const privateRoot = path.join(root, 'private');
    fs.mkdirSync(privateRoot, { mode: 0o700 });
    const defaultDirectory = path.join('/tmp', `tmux-${uid}`);
    fs.mkdirSync(defaultDirectory, { mode: 0o700, recursive: true });
    const defaultSocket = path.join(defaultDirectory, 'default');
    assert.equal(fs.existsSync(defaultSocket), false, 'Dedicated user must start with no default server');
    const previous = process.env.TMUX_TMPDIR;
    const privateSocket = path.join(privateRoot, `tmux-${uid}`, 'default');
    const env = { ...process.env, TMUX: '' }; delete env.TMUX_TMPDIR;
    const direct = (socket, args) => execFileSync(binary, ['-S', socket, ...args], {
      env, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'],
    }).trimEnd();
    let defaultStarted = false, privatePid, defaultPid;
    const waitStopped = async pid => {
      if (!pid) return;
      for (let i = 0; i < 100; i++) {
        try { process.kill(pid, 0); }
        catch (error) { if (error.code === 'ESRCH') return; throw error; }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.fail(`Test server ${pid} did not stop before directory cleanup`);
    };
    t.after(async () => {
      // Own both servers until they are stopped; only then remove fixture files.
      try {
        if (fs.existsSync(privateSocket)) direct(privateSocket, ['kill-server']);
        if (privatePid) {
          try { process.kill(privatePid, 'SIGTERM'); }
          catch (error) { if (error.code === 'ESRCH') privatePid = null; else throw error; }
        }
        await waitStopped(privatePid);
      } finally {
        if (defaultStarted) direct(defaultSocket, ['kill-server']);
        await waitStopped(defaultPid);
        if (defaultStarted) fs.rmSync(defaultSocket, { force: true });
        if (previous === undefined) delete process.env.TMUX_TMPDIR; else process.env.TMUX_TMPDIR = previous;
      }
      fs.rmSync(root, { recursive: true, force: true });
    });
    console.log(JSON.stringify({ uid, liveUid: Number(process.env.ZYLOS_TEST_LIVE_UID), binary,
      HOME: process.env.HOME, ZYLOS_DIR: process.env.ZYLOS_DIR, PM2_HOME: process.env.PM2_HOME,
      TMPDIR: process.env.TMPDIR, privateRoot, defaultSocket }));
    defaultStarted = true;
    direct(defaultSocket, ['-f', '/dev/null', 'new-session', '-d', '-s', 'directory-sentinel', 'sleep 60']);
    defaultPid = Number(direct(defaultSocket, ['display-message', '-p', '#{pid}']));
    const snapshot = () => [direct(defaultSocket, ['list-sessions', '-F', '#{session_id}:#{session_name}']),
      direct(defaultSocket, ['capture-pane', '-p', '-t', 'directory-sentinel'])];
    const before = snapshot();
    process.env.TMUX_TMPDIR = privateRoot;
    await runTmuxCommand(['new-session', '-d', '-s', 'private', 'sleep 60'], { binary, noServerStart: false });
    privatePid = Number(await runTmuxCommand(['display-message', '-p', '#{pid}'], { binary }));
    assert.ok(Number.isSafeInteger(privatePid) && privatePid > 1);
    fs.rmSync(privateRoot, { recursive: true });
    const reject = action => assert.rejects(async () => action(), { code: 'TMUX_DIR_MISSING' });
    for (const action of [
      () => runTmuxCommand(['list-sessions'], { binary }),
      () => runTmuxCommand(['kill-session', '-t', 'directory-sentinel'], { binary }),
      () => helpers.tmuxHasSession('directory-sentinel'), () => helpers.tmuxGetPanePid('directory-sentinel'),
      () => helpers.tmuxCapturePaneText('directory-sentinel'), () => helpers.tmuxKillSession('directory-sentinel'),
      () => helpers.tmuxSendKeys('directory-sentinel', 'Enter'),
      () => helpers.tmuxPasteBuffer('directory-sentinel', '/unused', 'buffer'),
      () => helpers.tmuxDeleteBuffer('buffer'), () => helpers.tmuxNewSession(['new-session', '-d']),
      () => listGroupTmuxSessions({ binary }),
      () => new SessionAdapter({ tmux: { binary } }).isRunning({ tmuxName: 'directory-sentinel' }),
      () => new SessionAdapter({ tmux: { binary } }).stop({ tmuxName: 'directory-sentinel' }),
      () => attachCommand({ resolve: async () => ({ sessionGroup: 'origin', runtime: 'claude', live: { tmuxName: 'directory-sentinel' } }) }),
      () => targetArgs({}, 'list-sessions'),
    ]) await reject(action);
    assert.deepEqual(snapshot(), before);
    console.log('default session list and pane snapshot unchanged after 15 rejected product entry calls');
  });
