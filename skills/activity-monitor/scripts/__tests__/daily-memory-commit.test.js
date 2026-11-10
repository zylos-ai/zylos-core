// Integration boundary: the daily memory commit through SupervisorMachineTasks.tick() with its real script
// runner, which runs the real zylos-memory/scripts/daily-commit.js and git in a temporary memory repository.
// Covers: a commit in the first round of the hour and none after it; a failed run recorded for the day with
// git's error in the log, not retried later that day, retried the next day; files over 50 MB left out of the
// commit and logged (untracked and tracked), a file over core.bigFileThreshold (512 MB) never written into a
// pack. Large files are sparse, so they take no disk space.
// Isolation: HOME, ZYLOS_DIR, PM2_HOME and TMPDIR point into a fresh temporary directory before anything runs,
// git ignores the user's global and system config, and the directory is removed afterwards. Every other machine
// task is disabled; no PM2, tmux, runtime, C4 or database is used. Run for changes to the daily memory commit,
// SupervisorMachineTasks' daily tasks or script runner, or daily-commit.js; skip otherwise.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { after, before, beforeEach, describe, it } from 'node:test';
import { SupervisorMachineTasks } from '../supervisor-machine-tasks.js';

const MB = 1024 * 1024;
const KEY = 'daily-memory-commit-state';

let root;
let zylosDir;
let memory;

before(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'daily-memory-commit-')));
  zylosDir = path.join(root, 'zylos');
  Object.assign(process.env, {
    HOME: path.join(root, 'home'),
    ZYLOS_DIR: zylosDir,
    PM2_HOME: path.join(root, 'pm2'),
    TMPDIR: path.join(root, 'tmp'),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  });
  for (const dir of ['home', 'pm2', 'tmp']) fs.mkdirSync(path.join(root, dir));
  memory = path.join(zylosDir, 'memory');
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

beforeEach(() => {
  fs.rmSync(zylosDir, { recursive: true, force: true });
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
const packFiles = () => fs.readdirSync(path.join(memory, '.git', 'objects', 'pack'));

/** Machine tasks with everything but the daily memory commit disabled, at 03:05 local time on `day`. */
function machine(t, day) {
  const logs = [];
  const clock = { day };
  const tasks = new SupervisorMachineTasks({
    zylosDir,
    readMode: () => ({ mode: 'single' }),
    readConfig: () => ({ upgrade_check_enabled: false, daily_upgrade_enabled: false, health_check_enabled: false,
      usage_monitor_enabled: false, usage_alert_enabled: false }),
    resolveTargetRuntime: () => { throw new Error('nothing else is due'); },
    readHealth: () => { throw new Error('nothing else is due'); },
    now: () => new Date(2026, 10, clock.day, 3, 5).getTime(),
    enqueue: async () => { throw new Error('no control may be enqueued'); },
    log: line => logs.push(String(line)),
  });
  t.after(() => tasks.stop());
  return {
    clock, logs, tasks,
    round: async () => { await tasks.tick({}); await Promise.all([...tasks.pending.values()]); },
    attempts: () => logs.filter(line => line.startsWith(`${KEY}: `)).length,
    state: () => tasks.state(KEY),
  };
}

describe('daily memory commit', () => {
  it('runs in an isolated memory directory', () => {
    assert.ok(memory.startsWith(root + path.sep));
    assert.equal(process.env.ZYLOS_DIR, zylosDir);
    assert.equal(process.env.HOME, path.join(root, 'home'));
  });

  it('commits in the first round of the hour and not again that day', async t => {
    const run = machine(t, 10);
    await run.round();
    assert.equal(commits(), '1');
    assert.match(git('log', '-1', '--format=%s'), /^memory: daily snapshot /);
    assert.deepEqual(committed(), ['state.md']);
    assert.equal(run.state().last_date, '2026-11-10');
    assert.equal(run.state().last_status, 'ok');
    assert.equal(run.state().last_error, undefined);
    assert.match(run.logs.at(-1), /^daily-memory-commit-state: .*memory: daily snapshot/s);

    fs.writeFileSync(path.join(memory, 'state.md'), '# State\nchanged\n');
    await run.round();
    assert.equal(commits(), '1', 'no second commit the same day');
    assert.equal(run.attempts(), 1);
  });

  it('records a failed run for the day with git\'s error, does not retry it that day, and retries the next day', async t => {
    const run = machine(t, 10);
    await run.round();
    run.clock.day = 11;
    fs.writeFileSync(path.join(memory, 'state.md'), '# State\nchanged\n');
    sparse('archive/backup.tar', 600 * MB);
    const lock = path.join(memory, '.git', 'index.lock');
    fs.writeFileSync(lock, '');

    await run.round();
    assert.equal(run.attempts(), 2);
    const failure = run.logs.at(-1);
    assert.match(failure, /^daily-memory-commit-state: Skipped 1 file\(s\) over 50 MB, not committed: archive\/backup\.tar \(600 MB\)\ndaily-commit error: fatal: Unable to create '[^']*index\.lock'/,
      'the log carries what was left out and git\'s error, not only the exit code');
    assert.ok(failure.length <= 'daily-memory-commit-state: '.length + 501, 'truncated');
    assert.equal(run.state().last_date, '2026-11-11');
    assert.equal(run.state().last_status, 'failed');
    assert.match(run.state().last_error, /index\.lock/);
    assert.ok(run.state().last_error.length <= 501);

    for (let i = 0; i < 5; i++) await run.round();
    assert.equal(run.attempts(), 2, 'no retry later the same day');
    assert.equal(commits(), '1');

    fs.rmSync(lock);
    run.clock.day = 12;
    await run.round();
    assert.equal(run.attempts(), 3);
    assert.equal(commits(), '2');
    assert.deepEqual(committed(), ['state.md']);
    assert.equal(run.state().last_date, '2026-11-12');
    assert.equal(run.state().last_status, 'ok');
    assert.equal(run.state().last_error, undefined);
  });

  it('leaves files over 50 MB out of the commit, logs them, and never streams a file over 512 MB into a pack', async t => {
    sparse('archive/memory-backup.tar', 600 * MB);
    sparse('archive/odd [1] *.bin', 50 * MB + 1);
    sparse('archive/at-limit.bin', 50 * MB);
    fs.writeFileSync(path.join(memory, 'archive', 'notes.md'), 'archived\n');
    const run = machine(t, 10);

    await run.round();
    assert.deepEqual(committed(), ['archive/at-limit.bin', 'archive/notes.md', 'state.md']);
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
    assert.equal(run.state().last_status, 'ok');
  });

  it('skips later changes to a tracked file once it is over 50 MB, and a day with only that change succeeds without a commit', async t => {
    const run = machine(t, 10);
    fs.mkdirSync(path.join(memory, 'logs'));
    fs.writeFileSync(path.join(memory, 'logs', 'growing.log'), 'small\n');
    await run.round();
    assert.deepEqual(committed(), ['logs/growing.log', 'state.md']);

    run.clock.day = 11;
    sparse('logs/growing.log', 60 * MB);
    fs.writeFileSync(path.join(memory, 'state.md'), '# State\nchanged\n');
    await run.round();
    assert.equal(commits(), '2');
    assert.equal(git('show', 'HEAD:logs/growing.log'), 'small\n');
    assert.equal(git('show', 'HEAD:state.md'), '# State\nchanged\n');
    assert.match(run.logs.at(-1), /^daily-memory-commit-state: Skipped 1 file\(s\) over 50 MB, not committed: logs\/growing\.log \(60 MB\)\n\[/);

    run.clock.day = 12;
    await run.round();
    assert.equal(commits(), '2', 'nothing else changed: no commit');
    assert.match(run.logs.at(-1), /^daily-memory-commit-state: Skipped 1 file\(s\).*\nNo memory changes to commit\.$/s);
    assert.equal(run.state().last_date, '2026-11-12');
    assert.equal(run.state().last_status, 'ok');
    assert.deepEqual(packFiles(), []);
  });
});
