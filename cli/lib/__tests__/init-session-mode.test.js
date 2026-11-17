import assert from 'node:assert/strict';
import { test } from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseInitFlags, printInitHelp, initSessionModeConflict, initSessionModeUpdate } from '../../commands/init.js';
import { updateConfigWithLock } from '../config-lock.js';

const CLI = fileURLToPath(new URL('../../zylos.js', import.meta.url));

// Every case runs the real CLI in its own temporary HOME/ZYLOS_DIR. The refusals
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

function runInit({ home, zylosDir }, args) {
  const env = { ...process.env, HOME: home, ZYLOS_DIR: zylosDir, NO_COLOR: '1', CI: 'true' };
  delete env.ZYLOS_UPSTREAM_CONFIG;
  return spawnSync(process.execPath, [CLI, 'init', ...args], { env, encoding: 'utf8', timeout: 30_000 });
}

test('init --session-mode parses single and multi; absent means no selection', () => {
  assert.equal(parseInitFlags([]).sessionMode, null);
  assert.equal(parseInitFlags(['--session-mode', 'single']).sessionMode, 'single');
  assert.equal(parseInitFlags(['-y', '--session-mode', 'multi']).sessionMode, 'multi');
});

test('init --help documents --session-mode and the switch command', t => {
  const lines = [];
  t.mock.method(console, 'log', text => lines.push(String(text)));
  printInitHelp();
  const help = lines.join('\n');
  assert.match(help, /--session-mode <mode>\s+New install only: single or multi \(default: multi\)/);
  assert.match(help, /zylos session-mode switch/);
});

test('init rejects an invalid or missing --session-mode value before any change', t => {
  for (const args of [['-y', '--session-mode', 'both'], ['-y', '--session-mode'], ['-y', '--session-mode', '--quiet']]) {
    const box = sandbox(t);
    const before = snapshot(box.home);
    const result = runInit(box, args);
    assert.equal(result.status, 1, `${args.join(' ')}: ${result.stderr}`);
    assert.match(result.stderr, args[2] === 'both' ? /INIT_SESSION_MODE_INVALID.*single or multi/ : /--session-mode requires a value/);
    assert.equal(fs.existsSync(box.zylosDir), false);
    assert.equal(snapshot(box.home), before);
  }
});

test('installed instance with a different --session-mode exits with the switch hint and changes nothing', t => {
  const cases = [
    { config: '{"session_mode":"multi","runtime":"claude"}\n', requested: 'single', current: 'multi' },
    { config: '{"session_mode":"single"}\n', requested: 'multi', current: 'single' },
    // No key: the instance runs single, as status and readiness report it.
    { config: '{"runtime":"claude"}\n', requested: 'multi', current: 'single' },
    { config: undefined, requested: 'multi', current: 'single' },
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

test('session mode conflict is checked only for a complete install with an explicit mode', () => {
  const mode = value => () => ({ mode: value, keyPresent: value !== null });
  assert.equal(initSessionModeConflict(null, 'complete', { readMode: mode('multi') }), null);
  assert.equal(initSessionModeConflict('multi', 'complete', { readMode: mode('multi') }), null);
  assert.equal(initSessionModeConflict('single', 'complete', { readMode: mode(null) }), null);
  assert.equal(initSessionModeConflict('single', 'complete', { readMode: mode('multi') }).code, 'INIT_SESSION_MODE_MISMATCH');
  assert.equal(initSessionModeConflict('multi', 'complete', { readMode: mode(null) }).code, 'INIT_SESSION_MODE_MISMATCH');
  const unread = () => { throw Object.assign(new Error('bad json'), { code: 'CONFIG_UNREADABLE' }); };
  assert.equal(initSessionModeConflict('multi', 'complete', { readMode: unread }).code, 'CONFIG_UNREADABLE');
  // Fresh and incomplete installs have no running mode to protect; the mode is never read.
  for (const state of ['fresh', 'incomplete']) {
    assert.equal(initSessionModeConflict('single', state, { readMode: unread }), null);
  }
});

test('session mode write before services start: explicit value replaces, default only fills fresh installs', t => {
  assert.deepEqual(initSessionModeUpdate('fresh', null), { setIfAbsent: { session_mode: 'multi' } });
  assert.deepEqual(initSessionModeUpdate('fresh', 'single'), { set: { session_mode: 'single' } });
  assert.deepEqual(initSessionModeUpdate('fresh', 'multi'), { set: { session_mode: 'multi' } });
  assert.equal(initSessionModeUpdate('incomplete', null), null);
  assert.deepEqual(initSessionModeUpdate('incomplete', 'single'), { set: { session_mode: 'single' } });
  assert.equal(initSessionModeUpdate('complete', null), null);
  assert.equal(initSessionModeUpdate('complete', 'single'), null);

  // A leftover value from an unfinished install is replaced by the explicit flag.
  const box = sandbox(t);
  const configFile = path.join(box.root, 'config.json');
  fs.writeFileSync(configFile, '{"session_mode":"multi","runtime":"claude"}\n');
  updateConfigWithLock({ configFile, lockFile: `${configFile}.lock`, update: initSessionModeUpdate('incomplete', 'single') });
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile, 'utf8')), { session_mode: 'single', runtime: 'claude' });
});
