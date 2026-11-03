import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI_PATH = fileURLToPath(new URL('../c4-fetch.js', import.meta.url));
const RECEIVE_PATH = fileURLToPath(new URL('../c4-receive.js', import.meta.url));
const CHECKPOINT_PATH = fileURLToPath(new URL('../c4-checkpoint.js', import.meta.url));

function cli(args, env = {}) {
  const result = spawnSync('node', [CLI_PATH, ...args], {
    // A non-UTC zone makes --since tests catch local-time conversions.
    env: { ...process.env, TZ: 'Asia/Shanghai', ...env },
    encoding: 'utf8'
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

function receive(args, env = {}) {
  return spawnSync('node', [RECEIVE_PATH, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
}

function checkpoint(args, env = {}) {
  return spawnSync('node', [CHECKPOINT_PATH, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
}

function withTmpDir(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-fetch-cli-'));
  const env = { ZYLOS_DIR: tmpDir };
  // Warm up DB
  checkpoint(['latest'], env);
  try {
    return fn({ tmpDir, env });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function setTimestamps(tmpDir, timestamps) {
  const db = new Database(path.join(tmpDir, 'comm-bridge', 'c4.db'));
  try {
    const update = db.prepare('UPDATE conversations SET timestamp = ? WHERE id = ?');
    timestamps.forEach((timestamp, i) => update.run(timestamp, i + 1));
  } finally {
    db.close();
  }
}

function utcAgo(ms) {
  return new Date(Date.now() - ms).toISOString().slice(0, 19).replace('T', ' ');
}

// -- --unsummarized --

describe('c4-fetch --unsummarized', () => {
  it('reports no unsummarized conversations on fresh DB', () => {
    withTmpDir(({ env }) => {
      const { stdout, status } = cli(['--unsummarized'], env);
      assert.equal(status, 0);
      assert.ok(stdout.includes('No unsummarized conversations'));
    });
  });

  it('fetches unsummarized conversations', () => {
    withTmpDir(({ env }) => {
      receive(['--channel', 'system', '--no-reply', '--content', 'msg1'], env);
      receive(['--channel', 'system', '--no-reply', '--content', 'msg2'], env);

      const { stdout, status } = cli(['--unsummarized'], env);
      assert.equal(status, 0);
      assert.ok(stdout.includes('Unsummarized Range'));
      assert.ok(stdout.includes('count=2'));
      assert.ok(stdout.includes('msg1'));
      assert.ok(stdout.includes('msg2'));
    });
  });

  it('keeps inbound endpoint content clean without reply routing', () => {
    withTmpDir(({ tmpDir, env }) => {
      fs.mkdirSync(path.join(tmpDir, '.claude', 'skills', 'telegram'), { recursive: true });
      receive(['--channel', 'telegram', '--endpoint', '123', '--content', 'clean msg'], env);

      const { stdout, status } = cli(['--unsummarized'], env);
      assert.equal(status, 0);
      assert.ok(stdout.includes('clean msg'));
      assert.ok(!stdout.includes('reply via:'));
    });
  });

  it('includes last checkpoint summary', () => {
    withTmpDir(({ env }) => {
      receive(['--channel', 'system', '--no-reply', '--content', 'old msg'], env);
      checkpoint(['create', '1', '--summary', 'First sync done'], env);
      receive(['--channel', 'system', '--no-reply', '--content', 'new msg'], env);

      const { stdout, status } = cli(['--unsummarized'], env);
      assert.equal(status, 0);
      assert.ok(stdout.includes('First sync done'));
      assert.ok(stdout.includes('new msg'));
      assert.ok(!stdout.includes('old msg'));
    });
  });
});

// -- --begin / --end --

describe('c4-fetch --begin --end', () => {
  it('fetches conversations in range', () => {
    withTmpDir(({ env }) => {
      receive(['--channel', 'system', '--no-reply', '--content', 'msg1'], env);
      receive(['--channel', 'system', '--no-reply', '--content', 'msg2'], env);
      receive(['--channel', 'system', '--no-reply', '--content', 'msg3'], env);

      const { stdout, status } = cli(['--begin', '1', '--end', '2'], env);
      assert.equal(status, 0);
      assert.ok(stdout.includes('msg1'));
      assert.ok(stdout.includes('msg2'));
      assert.ok(!stdout.includes('msg3'));
    });
  });

  it('reports no conversations for empty range', () => {
    withTmpDir(({ env }) => {
      const { stdout, status } = cli(['--begin', '100', '--end', '200'], env);
      assert.equal(status, 0);
      assert.ok(stdout.includes('No conversations in this range'));
    });
  });
});

// -- --since --

describe('c4-fetch --since', () => {
  const HOUR = 60 * 60 * 1000;

  function withMessages(timestamps, fn) {
    return withTmpDir(({ tmpDir, env }) => {
      timestamps.forEach((_, i) => receive(['--channel', 'system', '--no-reply', '--content', `msg${i + 1}`], env));
      setTimestamps(tmpDir, timestamps);
      return fn({ env });
    });
  }

  it('fetches conversations within a relative duration', () => {
    withMessages([utcAgo(48 * HOUR), utcAgo(3 * HOUR), utcAgo(HOUR / 6)], ({ env }) => {
      const day = cli(['--since', '1d'], env);
      assert.equal(day.status, 0, day.stderr);
      assert.match(day.stdout, /\[Conversations\] \(since \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC, id 2 ~ 3\)/);
      assert.ok(!day.stdout.includes('msg1'));
      assert.ok(day.stdout.includes('msg2'));
      assert.ok(day.stdout.includes('msg3'));

      const hour = cli(['--since', '1h'], env);
      assert.equal(hour.status, 0, hour.stderr);
      assert.ok(!hour.stdout.includes('msg2'));
      assert.ok(hour.stdout.includes('msg3'));

      const minutes = cli(['--since', '5m'], env);
      assert.equal(minutes.status, 0, minutes.stderr);
      assert.ok(minutes.stdout.includes('No conversations in this range'));
    });
  });

  it('treats a datetime without an offset as UTC and includes the boundary', () => {
    withMessages(['2026-01-01 08:00:00', '2026-01-02 12:00:00', '2026-01-03 09:30:00'], ({ env }) => {
      for (const since of ['2026-01-02 12:00', '2026-01-02T12:00:00', '2026-01-02T12:00Z', '2026-01-02T20:00+08:00', '2026-01-02 07:00-0500', '2026-01-02T12:00:00.000Z']) {
        const { stdout, stderr, status } = cli(['--since', since], env);
        assert.equal(status, 0, stderr);
        assert.ok(stdout.includes('(since 2026-01-02 12:00:00 UTC, id 2 ~ 3)'), `${since}: ${stdout}`);
        assert.ok(!stdout.includes('msg1'), since);
      }

      const later = cli(['--since', '2026-01-02 12:00:01'], env);
      assert.equal(later.status, 0, later.stderr);
      assert.ok(!later.stdout.includes('msg2'));
      assert.ok(later.stdout.includes('msg3'));

      const day = cli(['--since', '2026-01-03'], env);
      assert.equal(day.status, 0, day.stderr);
      assert.ok(day.stdout.includes('(since 2026-01-03 00:00:00 UTC, id 3 ~ 3)'));
    });
  });

  it('includes the last checkpoint summary', () => {
    withTmpDir(({ env }) => {
      receive(['--channel', 'system', '--no-reply', '--content', 'msg1'], env);
      checkpoint(['create', '1', '--summary', 'First sync done'], env);

      const { stdout, status } = cli(['--since', '1d'], env);
      assert.equal(status, 0);
      assert.ok(stdout.includes('[Last Checkpoint Summary] First sync done'));
      assert.ok(stdout.includes('msg1'));
    });
  });

  it('reports no conversations after the given time', () => {
    withTmpDir(({ env }) => {
      receive(['--channel', 'system', '--no-reply', '--content', 'msg1'], env);

      const { stdout, status } = cli(['--since', '2099-01-01'], env);
      assert.equal(status, 0);
      assert.ok(stdout.includes('[Conversations] (since 2099-01-01 00:00:00 UTC)'));
      assert.ok(stdout.includes('No conversations in this range'));
    });
  });

  it('rejects invalid values', () => {
    withTmpDir(({ env }) => {
      const invalid = [
        [], ['yesterday'], ['24'], ['24x'], ['-1h'], ['1.5h'], ['1000000d'], ['99999999999d'],
        ['2026-02-30'], ['2026-1-2'], ['2026-01-02 24:00'], ['2026-01-02 12:60'],
        ['2026-01-02T12:00+24:00'], ['2026-01-02+08:00'], ['2026-01-02T12:00.000Z'],
        ['2026-01-02T12:00:00.0000Z'],
      ];
      for (const value of invalid) {
        const { stderr, status } = cli(['--since', ...value], env);
        assert.equal(status, 1, String(value));
        assert.ok(stderr.includes('--since <duration|datetime>'), String(value));
      }
    });
  });

  it('cannot be combined with --begin/--end or --unsummarized', () => {
    withTmpDir(({ env }) => {
      receive(['--channel', 'system', '--no-reply', '--content', 'msg1'], env);
      for (const args of [['--begin', '1', '--end', '2'], ['--unsummarized']]) {
        const { stdout, stderr, status } = cli(['--since', '1d', ...args], env);
        assert.equal(status, 1, String(args));
        assert.ok(stderr.includes('Usage'), String(args));
        assert.ok(!stdout.includes('msg1'), String(args));
      }
    });
  });
});

// -- validation --

describe('c4-fetch validation', () => {
  it('errors with no arguments', () => {
    withTmpDir(({ env }) => {
      const { stderr, status } = cli([], env);
      assert.equal(status, 1);
      assert.ok(stderr.includes('Usage'));
    });
  });

  it('errors with incomplete --begin/--end', () => {
    withTmpDir(({ env }) => {
      const { stderr, status } = cli(['--begin', '1'], env);
      assert.equal(status, 1);
      assert.ok(stderr.includes('Usage'));
    });
  });
});
