// Integration boundary: the daily memory commit through the real task table
// (createActivityMonitorTaskScheduler + TaskScheduler), the real execute and
// state file (tasks/daily-memory-commit.js) and the real
// zylos-memory/scripts/daily-commit.js, which runs git in a temporary memory
// repository. Covers: a commit on the first tick of the hour and none after it;
// a failed run recorded for the day and not retried on later ticks, retried the
// next day; files over 50 MB left out of the commit and logged (untracked and
// tracked, and one staged before the run) while small files whose names their
// paths would match as globs are committed, a long error kept to 500 characters
// in the state, a file over core.bigFileThreshold (512 MB) never written into a
// pack. Large files are sparse. git reads only the 50 MB file that is committed
// and the 50 MB + 1 byte file staged by hand (on tmpfs, reading allocates it),
// never the larger ones.
// Isolation: HOME, ZYLOS_DIR, PM2_HOME and TMPDIR point into a fresh temporary
// directory before anything runs, git ignores the user's global and system
// config, and the directory is removed afterwards. No PM2, tmux, runtime or
// database is used. Run for changes to the daily memory commit, the task
// scheduler's daily tasks or daily-commit.js; skip otherwise.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { after, before, beforeEach, describe, it } from 'node:test';
import { createActivityMonitorTaskScheduler } from '../tasks/activity-monitor-tasks.js';
import { createDailyMemoryCommit } from '../tasks/daily-memory-commit.js';

const SCRIPT = fileURLToPath(new URL('../../../zylos-memory/scripts/daily-commit.js', import.meta.url));
const MB = 1024 * 1024;

let root;
let memory;
let stateFile;

before(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'daily-memory-commit-')));
  Object.assign(process.env, {
    HOME: path.join(root, 'home'),
    ZYLOS_DIR: path.join(root, 'zylos'),
    PM2_HOME: path.join(root, 'pm2'),
    TMPDIR: path.join(root, 'tmp'),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  });
  for (const dir of ['home', 'pm2', 'tmp']) fs.mkdirSync(path.join(root, dir));
  memory = path.join(process.env.ZYLOS_DIR, 'memory');
  stateFile = path.join(process.env.ZYLOS_DIR, 'activity-monitor', 'daily-memory-commit-state.json');
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

beforeEach(() => {
  fs.rmSync(process.env.ZYLOS_DIR, { recursive: true, force: true });
  fs.mkdirSync(memory, { recursive: true });
  fs.writeFileSync(path.join(memory, 'state.md'), '# State\n');
});

function git(...args) {
  return execFileSync('git', args, { cwd: memory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function sparse(relative, size) {
  const file = path.join(memory, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.closeSync(fs.openSync(file, 'w'));
  fs.truncateSync(file, size);
}

const commits = () => git('rev-list', '--count', 'HEAD').trim();
const committed = () => git('ls-tree', '-r', '--name-only', 'HEAD').trim().split('\n');
const state = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const packFiles = () => fs.readdirSync(path.join(memory, '.git', 'objects', 'pack'));

/** The activity monitor's task table with only the daily memory commit enabled, at 03:xx on `day.date`. */
function scheduler(day) {
  const logs = [];
  const log = message => logs.push(message);
  const commit = createDailyMemoryCommit({ stateFile, script: SCRIPT, log });
  const off = () => false;
  const tasks = createActivityMonitorTaskScheduler({
    usageMonitor: { isMonitorEnabled: off, isAlertEnabled: off },
    dailyUpgradeHour: 5,
    dailyMemoryCommitHour: 3,
    dailyUpgradeCheckHour: 6,
    healthCheckInterval: 86400,
    usageCheckInterval: 3600,
    usageAlertInterval: 3600,
    readDailyUpgradeEnabled: off,
    readHealthCheckEnabled: off,
    loadDailyUpgradeState: () => null,
    writeDailyUpgradeState: () => {},
    enqueueDailyUpgradeControl: () => { throw new Error('daily upgrade must not run'); },
    loadMemoryCommitState: commit.loadState,
    writeMemoryCommitState: commit.writeState,
    executeDailyMemoryCommit: commit.execute,
    loadUpgradeCheckState: () => null,
    writeUpgradeCheckState: () => {},
    executeUpgradeCheck: () => { throw new Error('upgrade check must not run'); },
    loadHealthCheckState: () => null,
    enqueueHealthCheck: () => { throw new Error('health check must not run'); },
    getLocalHour: () => 3,
    getLocalDate: () => day.date,
    nowEpoch: () => 1_800_000_000,
    log,
  });
  const attempts = () => logs.filter(line => line.startsWith('Daily memory commit')
    && !line.startsWith('Daily memory commit: failed to write state')).length;
  return { tick: () => tasks.tick({ health: 'ok' }), logs, attempts };
}

describe('daily memory commit', () => {
  it('runs in an isolated memory directory', () => {
    assert.ok(memory.startsWith(root + path.sep));
    assert.ok(stateFile.startsWith(root + path.sep));
    assert.equal(process.env.HOME, path.join(root, 'home'));
  });

  it('commits on the first tick of the hour and not again that day', () => {
    const day = { date: '2026-11-10' };
    const run = scheduler(day);
    assert.equal(run.tick(), 1);
    assert.equal(commits(), '1');
    assert.match(git('log', '-1', '--format=%s'), /^memory: daily snapshot /);
    assert.deepEqual(committed(), ['state.md']);
    assert.equal(state().last_date, '2026-11-10');
    assert.equal(state().last_status, 'ok');
    assert.equal(state().last_error, undefined);

    fs.writeFileSync(path.join(memory, 'state.md'), '# State\nchanged\n');
    assert.equal(run.tick(), 0);
    assert.equal(commits(), '1', 'no second commit the same day');
  });

  it('records a failed run for the day, does not retry it that day, and retries the next day', () => {
    const day = { date: '2026-11-10' };
    const run = scheduler(day);
    assert.equal(run.tick(), 1);
    day.date = '2026-11-11';
    fs.writeFileSync(path.join(memory, 'state.md'), '# State\nchanged\n');
    sparse('archive/backup.tar', 600 * MB);
    const lock = path.join(memory, '.git', 'index.lock');
    fs.writeFileSync(lock, '');

    assert.equal(run.tick(), 0);
    assert.equal(run.attempts(), 2);
    assert.match(run.logs.at(-2), /^Daily memory commit failed: Skipped 1 file\(s\) over 50 MB, not committed: archive\/backup\.tar \(600 MB\)\ndaily-commit error: .*index\.lock/s);
    assert.match(run.logs.at(-1), /^daily-memory-commit: failed, next attempt tomorrow \(date=2026-11-11\)$/);
    assert.equal(state().last_date, '2026-11-11');
    assert.equal(state().last_status, 'failed');
    assert.match(state().last_error, /index\.lock/);
    assert.ok(state().last_error.length <= 501);

    for (let i = 0; i < 5; i++) assert.equal(run.tick(), 0);
    assert.equal(run.attempts(), 2, 'no retry later the same day');
    assert.equal(commits(), '1');

    fs.rmSync(lock);
    day.date = '2026-11-12';
    assert.equal(run.tick(), 1);
    assert.equal(run.attempts(), 3);
    assert.equal(commits(), '2');
    assert.deepEqual(committed(), ['state.md']);
    assert.equal(state().last_date, '2026-11-12');
    assert.equal(state().last_status, 'ok');
    assert.equal(state().last_error, undefined);
  });

  it('leaves files over 50 MB out of the commit, logs them, and never streams a file over 512 MB into a pack', () => {
    sparse('archive/memory-backup.tar', 600 * MB);
    sparse('archive/odd [1] *.bin', 50 * MB + 1);
    sparse('archive/at-limit.bin', 50 * MB);
    fs.writeFileSync(path.join(memory, 'archive', 'notes.md'), 'archived\n');
    // Read as a glob, the skipped name `odd [1] *.bin` would also match this small file.
    fs.writeFileSync(path.join(memory, 'archive', 'odd 1 x.bin'), 'small\n');
    const run = scheduler({ date: '2026-11-10' });

    assert.equal(run.tick(), 1);
    assert.deepEqual(committed(), ['archive/at-limit.bin', 'archive/notes.md', 'archive/odd 1 x.bin', 'state.md']);
    const skipped = run.logs.join('\n').split('\n').find(line => line.startsWith('Skipped '));
    assert.ok(skipped, run.logs.join('\n'));
    assert.match(skipped, /^Skipped 2 file\(s\) over 50 MB, not committed: /);
    assert.ok(skipped.includes('archive/memory-backup.tar (600 MB)'), skipped);
    assert.ok(skipped.includes('archive/odd [1] *.bin (50 MB)'), skipped);
    assert.ok(!skipped.includes('at-limit'), skipped);
    // git writes a file over core.bigFileThreshold straight into objects/pack (tmp_pack_*, then pack-*);
    // everything committed here is a loose object, so the pack directory stays empty.
    assert.deepEqual(packFiles(), []);
    assert.deepEqual(git('ls-files', '--others', '-z').split('\0').filter(Boolean).sort(),
      ['archive/memory-backup.tar', 'archive/odd [1] *.bin'], 'the skipped files stay untracked');
    assert.equal(state().last_status, 'ok');
  });

  it('leaves daily upgrade and upgrade check retrying after a failure', () => {
    const runs = { upgrade: 0, check: 0 };
    const saved = {};
    let hour = 5;
    const off = () => false;
    const tasks = createActivityMonitorTaskScheduler({
      usageMonitor: { isMonitorEnabled: off, isAlertEnabled: off },
      dailyUpgradeHour: 5, dailyMemoryCommitHour: 3, dailyUpgradeCheckHour: 6,
      healthCheckInterval: 86400, usageCheckInterval: 3600, usageAlertInterval: 3600,
      readDailyUpgradeEnabled: () => true, readHealthCheckEnabled: off,
      loadDailyUpgradeState: () => saved.upgrade ?? null, writeDailyUpgradeState: date => { saved.upgrade = { last_date: date }; },
      enqueueDailyUpgradeControl: () => { runs.upgrade++; return false; },
      loadMemoryCommitState: () => null, writeMemoryCommitState: () => {}, executeDailyMemoryCommit: () => { throw new Error('not its hour'); },
      loadUpgradeCheckState: () => saved.check ?? null, writeUpgradeCheckState: date => { saved.check = { last_date: date }; },
      executeUpgradeCheck: () => { runs.check++; return false; },
      loadHealthCheckState: () => null, enqueueHealthCheck: off,
      getLocalHour: () => hour, getLocalDate: () => '2026-11-10', nowEpoch: () => 1_800_000_000, log: () => {},
    });
    tasks.tick({ health: 'ok' });
    tasks.tick({ health: 'ok' });
    hour = 6;
    tasks.tick({ health: 'ok' });
    tasks.tick({ health: 'ok' });
    assert.deepEqual(runs, { upgrade: 2, check: 2 });
    assert.deepEqual(saved, {}, 'no state written for a failed run');
  });

  it('skips later changes to a tracked file once it is over 50 MB, and a day with only that change succeeds without a commit', () => {
    const day = { date: '2026-11-10' };
    const run = scheduler(day);
    fs.mkdirSync(path.join(memory, 'logs'));
    fs.writeFileSync(path.join(memory, 'logs', 'growing.log'), 'small\n');
    assert.equal(run.tick(), 1);
    assert.deepEqual(committed(), ['logs/growing.log', 'state.md']);

    day.date = '2026-11-11';
    sparse('logs/growing.log', 60 * MB);
    fs.writeFileSync(path.join(memory, 'state.md'), '# State\nchanged\n');
    assert.equal(run.tick(), 1);
    assert.equal(commits(), '2');
    assert.equal(git('show', 'HEAD:logs/growing.log'), 'small\n');
    assert.equal(git('show', 'HEAD:state.md'), '# State\nchanged\n');
    assert.ok(run.logs.some(line => line.startsWith('Daily memory commit: Skipped 1 file(s) over 50 MB, not committed: logs/growing.log (60 MB)')), run.logs.join('\n'));

    day.date = '2026-11-12';
    assert.equal(run.tick(), 1);
    assert.equal(commits(), '2', 'nothing else changed: no commit');
    assert.match(run.logs.at(-2), /Skipped 1 file\(s\).*\nNo memory changes to commit\.$/s);
    assert.equal(state().last_date, '2026-11-12');
    assert.equal(state().last_status, 'ok');
    assert.deepEqual(packFiles(), []);
  });

  it('keeps the first 500 characters of a long error as last_error', () => {
    const day = { date: '2026-11-10' };
    const run = scheduler(day);
    assert.equal(run.tick(), 1);
    day.date = '2026-11-11';
    for (let i = 1; i <= 11; i++) sparse(`archive/a-long-archive-name-to-make-the-error-long-${String(i).padStart(2, '0')}.tar`, 51 * MB);
    fs.writeFileSync(path.join(memory, '.git', 'index.lock'), '');

    assert.equal(run.tick(), 0);
    const prefix = 'Daily memory commit failed: ';
    const failure = run.logs.find(line => line.startsWith(prefix));
    assert.match(failure, /^Daily memory commit failed: Skipped 11 file\(s\) over 50 MB, not committed: .*, and 1 more\n/);
    const detail = failure.slice(prefix.length);
    assert.ok(detail.length > 500, `the error is ${detail.length} characters`);
    assert.equal(state().last_status, 'failed');
    assert.equal(state().last_error.length, 501);
    assert.equal(state().last_error, `${detail.slice(0, 500)}…`);
  });

  it('does not commit a file over 50 MB that was already staged before the run', () => {
    const day = { date: '2026-11-10' };
    const run = scheduler(day);
    assert.equal(run.tick(), 1);
    day.date = '2026-11-11';
    sparse('archive/staged.tar', 50 * MB + 1);
    git('add', 'archive/staged.tar');
    fs.writeFileSync(path.join(memory, 'state.md'), '# State\nchanged\n');

    assert.equal(run.tick(), 1);
    assert.equal(commits(), '2');
    assert.deepEqual(committed(), ['state.md']);
    assert.ok(run.logs.some(line => line.startsWith('Daily memory commit: Skipped 1 file(s) over 50 MB, not committed: archive/staged.tar (50 MB)')), run.logs.join('\n'));
    assert.equal(git('ls-files', '--stage', '--', 'archive').trim(), '', 'unstaged, not only left out of this commit');
    assert.equal(git('ls-files', '--others', '--', 'archive').trim(), 'archive/staged.tar');
  });
});
