// Integration boundary: the daily memory commit through SupervisorMachineTasks.tick() with its real script
// runner, which runs the real zylos-memory/scripts/daily-commit.js and git in a temporary memory repository.
// Covers: a commit in the first round of the hour and none after it; a failed run recorded for the day with
// git's error in the log, not retried later that day, retried the next day; files over 50 MB left out of the
// commit and logged (untracked, tracked, and one staged before the run) while small files whose names their paths
// would match as globs are committed, a long error kept to 500 characters in the log and the state, a file over
// core.bigFileThreshold (512 MB) never written into a pack. Large files are sparse. git reads only the 50 MB file
// that is committed and the 50 MB + 1 byte file staged by hand (on tmpfs, reading allocates it), never the larger
// ones.
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
    // Read as a glob, the skipped name `odd [1] *.bin` would also match this small file.
    fs.writeFileSync(path.join(memory, 'archive', 'odd 1 x.bin'), 'small\n');
    const run = machine(t, 10);

    await run.round();
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

  it('keeps the first 500 characters of a long error in the log and as last_error', async t => {
    const run = machine(t, 10);
    await run.round();
    run.clock.day = 11;
    const names = [];
    for (let i = 1; i <= 11; i++) {
      names.push(`archive/a-long-archive-name-to-make-the-error-long-${String(i).padStart(2, '0')}.tar`);
      sparse(names.at(-1), 51 * MB);
    }
    fs.writeFileSync(path.join(memory, '.git', 'index.lock'), '');
    const skipped = `Skipped 11 file(s) over 50 MB, not committed: ${names.slice(0, 10).map(name => `${name} (51 MB)`).join(', ')}, and 1 more`;
    assert.ok(skipped.length > 500);
    // The actual child runner must preserve raw stderr. Otherwise truncating
    // again at state/log sinks is idempotent and output-only checks miss it.
    await assert.rejects(run.tasks.execute(path.resolve('skills/zylos-memory/scripts/daily-commit.js'), 30000), error => {
      assert.ok(error.message.length > 501, 'runner passes the original long stderr to its caller');
      assert.ok(error.message.startsWith(skipped));
      return true;
    });

    await run.round();
    assert.equal(run.attempts(), 2);
    assert.equal(run.logs.at(-1), `${KEY}: ${skipped.slice(0, 500)}…`);
    assert.equal(run.state().last_status, 'failed');
    assert.equal(run.state().last_error.length, 501);
    assert.equal(run.state().last_error, `${skipped.slice(0, 500)}…`);
    const loggedError = run.logs.at(-1).slice(`${KEY}: `.length);
    assert.equal(loggedError.length, 501);
    assert.equal(loggedError.split('…').length - 1, 1);
    assert.equal(run.state().last_error.split('…').length - 1, 1);
    assert.equal(loggedError, run.state().last_error);
  });

  // Real Git duplicate records and the real daily script remain in the suite's
  // private root; run for path parsing/exclusion changes, skip unrelated work.
  it('lists an oversized file once when staged deletion and untracked status share its path', async t => {
    const run = machine(t, 10);
    fs.writeFileSync(path.join(memory, 'big'), 'original small blob\n');
    await run.round();
    run.clock.day = 11;
    git('rm', '--cached', '--', 'big');
    sparse('big', 60 * MB);
    const entries = git('status', '--porcelain', '-z', '--untracked-files=all').split('\0').filter(Boolean);
    assert.deepEqual(entries, ['D  big', '?? big'], 'real Git emits the same path twice');
    fs.writeFileSync(path.join(memory, 'state.md'), '# State\nsmall update\n');
    await run.round();
    const skipped = run.logs.at(-1).split('\n').find(line => line.startsWith('daily-memory-commit-state: Skipped '));
    assert.equal(skipped, `${KEY}: Skipped 1 file(s) over 50 MB, not committed: big (60 MB)`);
    assert.equal(skipped.split('big (60 MB)').length - 1, 1);
    assert.equal(commits(), '2');
    assert.equal(git('show', 'HEAD:big'), 'original small blob\n', 'oversized bytes never enter the new commit');
    assert.equal(git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD').trim(), 'state.md');
    assert.equal(fs.statSync(path.join(memory, 'big')).size, 60 * MB);
    assert.deepEqual(packFiles(), []);
  });

  // Git's tracked-before-untracked stream order differs from lexical order.
  // Run for changed-path parsing/exclusion changes; no external service is used.
  it('preserves the first-seen order of distinct oversized paths', async t => {
    const run = machine(t, 10);
    fs.writeFileSync(path.join(memory, 'z-big'), 'small\n');
    await run.round();run.clock.day = 11;
    git('rm', '--cached', '--', 'z-big');
    sparse('z-big', 60 * MB);sparse('a-big', 60 * MB);
    assert.deepEqual(git('status', '--porcelain', '-z', '--untracked-files=all').split('\0').filter(Boolean), ['D  z-big', '?? a-big', '?? z-big']);
    await run.round();
    assert.equal(run.logs.at(-1), `${KEY}: Skipped 2 file(s) over 50 MB, not committed: z-big (60 MB), a-big (60 MB)\nNo memory changes to commit.`);
    assert.equal(commits(), '1');
    assert.equal(git('show', 'HEAD:z-big'), 'small\n');
  });

  it('does not commit a file over 50 MB that was already staged before the run', async t => {
    const run = machine(t, 10);
    await run.round();
    run.clock.day = 11;
    sparse('archive/staged.tar', 50 * MB + 1);
    git('add', 'archive/staged.tar');
    fs.writeFileSync(path.join(memory, 'state.md'), '# State\nchanged\n');

    await run.round();
    assert.equal(commits(), '2');
    assert.deepEqual(committed(), ['state.md']);
    assert.match(run.logs.at(-1), /^daily-memory-commit-state: Skipped 1 file\(s\) over 50 MB, not committed: archive\/staged\.tar \(50 MB\)\n\[/);
    assert.equal(git('ls-files', '--stage', '--', 'archive').trim(), '', 'unstaged, not only left out of this commit');
    assert.equal(git('ls-files', '--others', '--', 'archive').trim(), 'archive/staged.tar');
    assert.equal(run.state().last_status, 'ok');
  });
});
