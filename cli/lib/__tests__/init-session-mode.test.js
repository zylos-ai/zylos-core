import assert from 'node:assert/strict';
import { test } from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { initSessionModeConflict, initSessionModeUpdate } from '../../commands/init.js';
import { CONFIG_FILE, ZYLOS_DIR } from '../config.js';
import { updateConfigWithLock } from '../config-lock.js';
import { guardDatabase } from '../../../skills/comm-bridge/scripts/sqlite-schema.js';
import * as c4Schema from '../../../skills/comm-bridge/scripts/c4-schema.js';
import { createStore } from '../../../skills/comm-bridge/scripts/c4-v2-store.js';

const CLI = fileURLToPath(new URL('../../zylos.js', import.meta.url));

// Every CLI case runs the real CLI in its own temporary HOME/ZYLOS_DIR. The refusals
// happen before prerequisites, installers, auth or services, so nothing outside
// that directory is reached; a case that got further would change the snapshot.
function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'init-mode-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const zylosDir = path.join(home, 'zylos');
  fs.mkdirSync(home);
  return { root, home, zylosDir };
}

function installComplete(zylosDir, config) {
  fs.mkdirSync(path.join(zylosDir, '.claude', 'skills'), { recursive: true });
  fs.mkdirSync(path.join(zylosDir, '.zylos'), { recursive: true });
  fs.writeFileSync(path.join(zylosDir, '.zylos', 'components.json'), '{}\n');
  if (config !== undefined) fs.writeFileSync(path.join(zylosDir, '.zylos', 'config.json'), config);
}

// A real C4 database with an open single-to-multi transition, as the supervisor's
// automatic migration leaves it before its cutover writes the session_mode key.
function openTransition(zylosDir) {
  fs.mkdirSync(path.join(zylosDir, 'comm-bridge'), { recursive: true });
  const database = new Database(path.join(zylosDir, 'comm-bridge', 'c4.db'));
  try {
    guardDatabase(database, c4Schema);
    createStore(database, { readConfig: () => ({ state: 'ok', config: {} }) }).beginModeTransition('single', 'multi');
  } finally { database.close(); }
}

function snapshot(dir) {
  const rows = [];
  const walk = current => {
    for (const name of fs.readdirSync(current).sort()) {
      const file = path.join(current, name);
      const stat = fs.lstatSync(file);
      const rel = path.relative(dir, file);
      if (stat.isDirectory()) { rows.push(`d ${rel}`); walk(file); }
      else rows.push(`f ${rel} ${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`);
    }
  };
  walk(dir);
  return rows.join('\n');
}

// PATH holds only this node and system directories, and npm's global prefix is the
// sandbox: if a refusal ever stopped working, init would stop at its missing-PM2
// step instead of installing into or starting anything from the machine's real tools.
function runInit({ root, home, zylosDir }, args) {
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  if (!fs.existsSync(path.join(bin, 'node'))) fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  const env = { ...process.env, HOME: home, ZYLOS_DIR: zylosDir, PM2_HOME: path.join(root, 'pm2'),
    PATH: `${bin}:/usr/bin:/bin`, NPM_CONFIG_PREFIX: path.join(root, 'npm'), NO_COLOR: '1', CI: 'true' };
  delete env.ZYLOS_UPSTREAM_CONFIG;
  return spawnSync(process.execPath, [CLI, 'init', ...args], { env, encoding: 'utf8', timeout: 30_000 });
}

// The runner gives this process its own temporary ZYLOS_DIR; these cases use its config and C4 paths.
function useRunnerInstance(t, config) {
  // The runner places TMPDIR at <root>/tmp and ZYLOS_DIR at <root>/home/zylos.
  assert.equal(path.dirname(path.dirname(ZYLOS_DIR)), path.dirname(os.tmpdir()), `ZYLOS_DIR is not the runner's: ${ZYLOS_DIR}`);
  const c4 = path.join(ZYLOS_DIR, 'comm-bridge');
  t.after(() => {
    fs.rmSync(CONFIG_FILE, { force: true });
    fs.rmSync(c4, { recursive: true, force: true });
  });
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, config);
}

test('installed instance with a different saved --session-mode exits with the switch hint and changes nothing', t => {
  const cases = [
    { config: '{"session_mode":"multi","runtime":"claude"}\n', requested: 'single', current: 'multi' },
    { config: '{"session_mode":"single"}\n', requested: 'multi', current: 'single' },
  ];
  for (const { config, requested, current } of cases) {
    const box = sandbox(t);
    installComplete(box.zylosDir, config);
    const before = snapshot(box.home);
    const result = runInit(box, ['-y', '--session-mode', requested]);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, new RegExp(`Error \\[INIT_SESSION_MODE_MISMATCH\\]: This instance is already installed in ${current} session mode`));
    assert.match(result.stderr, new RegExp(`zylos session-mode switch ${requested}`));
    assert.doesNotMatch(result.stdout, /Checking prerequisites/);
    assert.equal(snapshot(box.home), before);
  }
});

test('installed instance with an unreadable session mode exits without guessing or changing anything', t => {
  for (const config of ['{broken', '{"session_mode":"both"}\n']) {
    const box = sandbox(t);
    installComplete(box.zylosDir, config);
    const before = snapshot(box.home);
    const result = runInit(box, ['-y', '--session-mode', 'single']);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /CONFIG_UNREADABLE/);
    assert.doesNotMatch(result.stdout, /Checking prerequisites/);
    assert.equal(snapshot(box.home), before);
  }
});

test('installed instance without a saved mode refuses single while a mode switch is open and changes nothing', t => {
  for (const config of ['{"runtime":"claude"}\n', undefined]) {
    const box = sandbox(t);
    installComplete(box.zylosDir, config);
    openTransition(box.zylosDir);
    const before = snapshot(box.home);
    const result = runInit(box, ['-y', '--session-mode', 'single']);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Error \[INIT_SESSION_MODE_SWITCH_IN_PROGRESS\]: A session mode switch \(single to multi\) is in progress/);
    assert.match(result.stderr, /zylos session-mode switch single/);
    assert.doesNotMatch(result.stdout, /Checking prerequisites/);
    assert.equal(snapshot(box.home), before);
  }
});

test('no saved mode: an open mode switch in the real C4 store refuses single but not multi', async t => {
  useRunnerInstance(t, '{"runtime":"claude"}\n');
  openTransition(ZYLOS_DIR);
  assert.equal((await initSessionModeConflict('single', 'complete')).code, 'INIT_SESSION_MODE_SWITCH_IN_PROGRESS');
  assert.equal(await initSessionModeConflict('multi', 'complete'), null);
  const broken = () => { throw new Error('database is locked'); };
  assert.equal((await initSessionModeConflict('single', 'complete', { readTransition: broken })).code, 'MODE_TRANSITION_UNREADABLE');
  assert.equal(fs.readFileSync(CONFIG_FILE, 'utf8'), '{"runtime":"claude"}\n');
});

test('fresh and incomplete installs are never refused; their explicit value is written', async t => {
  const unread = () => { throw Object.assign(new Error('bad json'), { code: 'CONFIG_UNREADABLE' }); };
  for (const state of ['fresh', 'incomplete']) {
    assert.equal(await initSessionModeConflict('single', state, { readMode: unread, readTransition: unread }), null);
  }
  assert.equal(await initSessionModeConflict(null, 'complete', { readMode: unread }), null);
  assert.deepEqual(initSessionModeUpdate('fresh', null), { setIfAbsent: { session_mode: 'multi' } });
  assert.deepEqual(initSessionModeUpdate('fresh', 'single'), { set: { session_mode: 'single' } });
  assert.deepEqual(initSessionModeUpdate('fresh', 'multi'), { set: { session_mode: 'multi' } });
  assert.equal(initSessionModeUpdate('incomplete', null), null);
  assert.deepEqual(initSessionModeUpdate('incomplete', 'single'), { set: { session_mode: 'single' } });
  assert.equal(initSessionModeUpdate('complete', null, { keyPresent: false }), null);

  // A leftover value from an unfinished install is replaced by the explicit flag.
  const box = sandbox(t);
  const configFile = path.join(box.root, 'config.json');
  fs.writeFileSync(configFile, '{"session_mode":"multi","runtime":"claude"}\n');
  updateConfigWithLock({ configFile, lockFile: `${configFile}.lock`, update: initSessionModeUpdate('incomplete', 'single') });
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile, 'utf8')), { session_mode: 'single', runtime: 'claude' });
});
