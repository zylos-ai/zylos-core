import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork, spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { SINGLE_UPGRADE_RESTART_CHECK_PROMPT } from '../skills/activity-monitor/scripts/reclaim-prompts.js';

const repository = fileURLToPath(new URL('../', import.meta.url));

function isolatedEnvironment(t, failure = null) {
  const home = fs.realpathSync(process.env.HOME);
  assert.notEqual(home, fs.realpathSync(os.userInfo().homedir), 'HOME must be isolated by the test runner');
  const runnerRoot = path.dirname(home);
  for (const key of ['ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) {
    assert.ok(process.env[key]?.startsWith(runnerRoot + path.sep), `${key} must be isolated`);
  }
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR, 'upgrade-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const privateHome = path.join(root, 'home'), zylos = path.join(privateHome, 'zylos');
  const bin = path.join(root, 'bin'), tmp = path.join(root, 'tmp');
  for (const directory of [privateHome, zylos, bin, tmp]) fs.mkdirSync(directory, { recursive: true });
  const env = { ...process.env, HOME: privateHome, ZYLOS_DIR: zylos,
    PM2_HOME: path.join(root, 'pm2'), TMPDIR: tmp, TMUX_TMPDIR: tmp,
    ZYLOS_PACKAGE_ROOT: repository, PATH: `${bin}:/usr/bin:/bin`,
    TEST_INSTALL_NODE: process.execPath,
    TEST_INSTALL_FIXTURE: fileURLToPath(new URL('./fixtures/claude-installer.js', import.meta.url)),
    TEST_INSTALL_FAIL: failure === 'install' ? '1' : '0',
    TEST_CURL_FAIL: failure === 'download' ? '1' : '0' };
  for (const key of ['TMUX', 'ZYLOS_SESSION_GROUP', 'ZYLOS_RUN_ID', 'CLAUDE_SESSION_ID', 'CODEX_SESSION_ID']) delete env[key];
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  const curl = path.join(bin, 'curl');
  fs.copyFileSync(new URL('./fixtures/claude-installer-curl.js', import.meta.url), curl);
  fs.chmodSync(curl, 0o700);
  const skills = path.join(zylos, '.claude/skills');
  fs.mkdirSync(skills, { recursive: true });
  for (const skill of ['comm-bridge', 'activity-monitor', 'scheduler']) {
    fs.symlinkSync(path.join(repository, 'skills', skill), path.join(skills, skill));
  }
  fs.mkdirSync(path.join(zylos, '.zylos'));
  fs.writeFileSync(path.join(zylos, '.zylos/config.json'), JSON.stringify({ session_mode: 'single' }));
  const database = path.join(zylos, 'comm-bridge/c4.db');
  console.log('Upgrade isolation:', JSON.stringify({ HOME: env.HOME, ZYLOS_DIR: env.ZYLOS_DIR,
    PM2_HOME: env.PM2_HOME, TMPDIR: env.TMPDIR, socket: path.join(tmp, 'tmux.sock'),
    database, curl: fs.realpathSync(curl), installer: env.TEST_INSTALL_FIXTURE }));
  return { root, env, database };
}

async function runUpgrade(t, fixture) {
  const log = path.join(fixture.root, 'upgrade.log');
  const fd = fs.openSync(log, 'w');
  const child = spawn(process.execPath, [path.join(repository, 'skills/upgrade-claude/scripts/upgrade.js')], {
    env: fixture.env, cwd: fixture.root, detached: true, stdio: ['ignore', fd, fd],
  });
  fs.closeSync(fd);
  const ended = once(child, 'exit');
  t.after(async () => {
    // Include installer/control descendants if an assertion or deadline ends the case.
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    await ended;
  });
  const [code, signal] = await Promise.race([
    ended,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('Upgrade subprocess exceeded 15 seconds')), 15000);
      timer.unref();
      ended.finally(() => clearTimeout(timer));
    }),
  ]);
  return { code, signal, log: fs.readFileSync(log, 'utf8') };
}

async function holdClaude(t, env) {
  const child = fork(new URL('./fixtures/claude-process.js', import.meta.url), [], {
    env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const ended = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await ended; });
  const [ready] = await once(child, 'message', { signal: AbortSignal.timeout(5000) });
  assert.equal(ready.ready, true);
  return child;
}

function controls(database) {
  // Installation failures return before the restart producer opens the ledger.
  if (!fs.existsSync(database)) return [];
  const db = new Database(database, { readonly: true });
  try { return db.prepare('SELECT id, raw_content, status FROM control_queue ORDER BY id LIMIT 3').all(); }
  finally { db.close(); }
}

// Boundary: real upgrade entry, native install pipeline and real C4 enqueue on a
// private database, with a network-free curl fixture installing a version stub.
// Run when install/enqueue order changes; skip for unrelated edits. No service or
// tmux server is started; real authenticated replacement is a reviewer scenario.
// Run only in isolation, never against live resources: isolate HOME, ZYLOS_DIR,
// PM2_HOME and a short TMPDIR; reserve a private tmux socket and test database.
// Read actual paths before starting and clean all processes/resources afterwards.
for (const otherClaude of [false, true]) {
  test(`single-session upgrade installs before queueing exit${otherClaude ? ' while another Claude remains running' : ''}`,
    { timeout: 25000 }, async t => {
      const fixture = isolatedEnvironment(t);
      const claude = otherClaude ? await holdClaude(t, fixture.env) : null;
      const started = performance.now(), result = await runUpgrade(t, fixture);
      assert.equal(result.code, 0, result.log);
      assert.equal(result.signal, null);
      assert.ok(performance.now() - started < 15000, result.log);
      const installed = result.log.indexOf('Upgrade completed successfully');
      const queued = result.log.indexOf('enqueued via control queue');
      assert.ok(installed >= 0 && queued > installed, result.log);
      const rows = controls(fixture.database);
      assert.equal(rows.length, 2);
      assert.equal(rows[0].raw_content, SINGLE_UPGRADE_RESTART_CHECK_PROMPT);
      assert.equal(rows[1].raw_content, '/exit');
      assert.equal(rows[0].status, 'pending');
      assert.equal(rows[1].status, 'pending');
      assert.equal(execFileSync(path.join(fixture.env.HOME, '.local/bin/claude'), ['--version'], {
        env: fixture.env, encoding: 'utf8', timeout: 5000,
      }).trim(), 'Claude Code isolated-new');
      if (claude) { assert.equal(claude.exitCode, null); assert.equal(claude.signalCode, null); }
      console.log('Upgrade outcome:', JSON.stringify({ otherClaude, code: result.code, installedBeforeQueue: true,
        version: 'Claude Code isolated-new', unrelatedClaudeAlive: claude ? claude.exitCode === null : null }));
    });
}

async function assertFailedUpgrade(t, failure) {
  const fixture = isolatedEnvironment(t, failure), claude = await holdClaude(t, fixture.env);
  const result = await runUpgrade(t, fixture);
  assert.equal(result.code, 1, result.log);
  assert.match(result.log, /ERROR: Upgrade failed!/);
  assert.doesNotMatch(result.log, /enqueued via control queue/);
  assert.equal(controls(fixture.database).length, 0);
  assert.equal(claude.exitCode, null);
  assert.equal(claude.signalCode, null);
  assert.equal(fs.existsSync(path.join(fixture.env.HOME, '.local/bin/claude')), false);
  console.log('Upgrade failure outcome:', JSON.stringify({ failure, code: result.code, queuedControls: 0, currentClaudeAlive: true }));
}

// Boundary: real installer failure through main's error handling and private C4
// state; run for installation-error or exit-queue changes, skip unrelated edits.
// Run only in isolation, never against live resources: isolate HOME, ZYLOS_DIR,
// PM2_HOME and a short TMPDIR; reserve a private tmux socket and test database.
// Read actual paths before starting and clean all processes/resources afterwards.
test('failed installation logs an error and leaves the running Claude without queued exit', { timeout: 25000 }, async t => {
  await assertFailedUpgrade(t, 'install');
});

// Boundary: curl fails before writing any installer input; the real shell
// pipeline/main must report failure and preserve the current runtime. Run for
// native download/pipeline error handling; unrelated edits may skip.
// Run only in isolation, never against live resources: isolate HOME, ZYLOS_DIR,
// PM2_HOME and a short TMPDIR; reserve a private tmux socket and test database.
// Read actual paths before starting and clean all processes/resources afterwards.
test('failed download logs an error and leaves the running Claude without queued exit', { timeout: 25000 }, async t => {
  await assertFailedUpgrade(t, 'download');
});
