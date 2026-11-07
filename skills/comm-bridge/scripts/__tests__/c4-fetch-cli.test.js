import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI_PATH = fileURLToPath(new URL('../c4-fetch.js', import.meta.url));
const RECEIVE_PATH = fileURLToPath(new URL('../c4-db.js', import.meta.url));
const CHECKPOINT_PATH = fileURLToPath(new URL('../c4-checkpoint.js', import.meta.url));

function childOptions(env = {}) {
  const isolated = { ...process.env, TZ: 'Asia/Shanghai', ...env };
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) {
    assert.ok(isolated[key] && path.isAbsolute(isolated[key]), `${key} must be isolated`);
    assert.ok(fs.realpathSync(isolated[key]).startsWith(fs.realpathSync(os.tmpdir()) + path.sep), `${key} must remain under the test temporary directory`);
  }
  return { env: isolated, cwd: isolated.ZYLOS_DIR, encoding: 'utf8', timeout: 15_000, maxBuffer: 2 * 1024 * 1024 };
}

function cli(args, env = {}) {
  const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
    // A non-UTC zone makes --since tests catch local-time conversions.
    ...childOptions(env),
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

function receive(args, env = {}) {
  const channel = args[args.indexOf('--channel') + 1];
  const endpoint = args.includes('--endpoint') ? args[args.indexOf('--endpoint') + 1] : 'null';
  const content = args[args.indexOf('--content') + 1];
  return spawnSync(process.execPath, [RECEIVE_PATH, 'insert', 'out', channel, endpoint, content], {
    ...childOptions(env),
  });
}

function checkpoint(args, env = {}) {
  return spawnSync(process.execPath, [CHECKPOINT_PATH, ...args], {
    ...childOptions(env),
  });
}

function withTmpDir(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-fetch-cli-'));
  const env = { HOME: path.join(tmpDir, 'home'), ZYLOS_DIR: tmpDir, PM2_HOME: path.join(tmpDir, 'pm2'), TMPDIR: path.join(tmpDir, 'tmp') };
  for (const directory of Object.values(env)) fs.mkdirSync(directory, { recursive: true });
  try {
    // Warm up the private DB only after validating every child path.
    const warmup = checkpoint(['latest'], env);
    assert.equal(warmup.status, 0, warmup.stderr);
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
      assert.ok(stdout.includes('count=0'));
    });
  });

  it('fetches unsummarized conversations', () => {
    withTmpDir(({ env }) => {
      receive(['--channel', 'system', '--no-reply', '--content', 'msg1'], env);
      receive(['--channel', 'system', '--no-reply', '--content', 'msg2'], env);

      const { stdout, status } = cli(['--unsummarized'], env);
      assert.equal(status, 0);
      assert.ok(stdout.includes('unsummarized scope=*'));
      assert.ok(stdout.includes('count=2'));
      assert.ok(stdout.includes('msg1'));
      assert.ok(stdout.includes('msg2'));
    });
  });

  it('keeps outbound endpoint content clean without reply routing', () => {
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

  // Boundary: public argument parsing, query adapters and a private SQLite DB;
  // no services or tmux. Run for unsummarized paging/format changes; skip for
  // unrelated runtime, UI or transport changes.
  it('pages 120 group messages using the previous upper bound and stops at the delivered frontier', () => {
    withTmpDir(({ tmpDir, env }) => {
      const db = new Database(path.join(tmpDir, 'comm-bridge', 'c4.db'));
      try {
        const insert = db.prepare("INSERT INTO conversations(id,direction,channel,content,status,session_group) VALUES(?,'out','system',?,?,?)");
        insert.run(1, 'covered', 'delivered', 'foo');
        for (let i = 1; i <= 120; i++) {
          insert.run(i * 2, `foo message ${i}`, 'delivered', 'foo');
          insert.run(i * 2 + 1, `bar message ${i}`, 'delivered', 'bar');
        }
        insert.run(242, 'unfinished', 'pending', 'foo');
        db.prepare("UPDATE conversations SET direction='in' WHERE id=242").run();
        insert.run(243, 'beyond frontier', 'delivered', 'foo');
      } finally { db.close(); }
      assert.equal(checkpoint(['create', '1', '--group', 'foo', '--summary', 'coverage'], env).status, 0);
      let after = 0, seen = 0;
      for (const expectedCount of [50, 50, 20]) {
        const result = cli(['--unsummarized', '--group', 'foo', '--after', String(after), '--limit', '50', '--json'], env);
        assert.equal(result.status, 0, result.stderr);
        const page = JSON.parse(result.stdout).data;
        assert.equal(page.rows.length, expectedCount); assert.equal(page.safeEnd, 241); assert.equal(page.checkpointEnd, 1);
        for (const row of page.rows) { seen++; assert.equal(row.id, seen * 2); assert.equal(row.session_group, 'foo'); }
        assert.equal(page.upTo, seen < 120 ? seen * 2 : 241);
        after = page.upTo;
      }
      assert.equal(seen, 120);
      for (const after of [200, 241, 1000]) {
        const result = cli(['--unsummarized', '--group', 'foo', '--after', String(after), '--up-to', '200', '--json'], env);
        assert.equal(result.status, 0, result.stderr);
        const page = JSON.parse(result.stdout).data;
        assert.equal(page.rows.length, 0); assert.equal(page.upTo, 200);
      }
      const done = cli(['--unsummarized', '--group', 'foo', '--after', '241', '--json'], env);
      assert.equal(done.status, 0, done.stderr);
      assert.equal(JSON.parse(done.stdout).data.upTo, 241);
      assert.equal(JSON.parse(done.stdout).data.rows.length, 0);
    });
  });

  it('keeps Sync text byte-identical without a cursor and honors global coverage', () => {
    withTmpDir(({ tmpDir, env }) => {
      receive(['--channel', 'system', '--content', 'old msg'], env);
      assert.equal(checkpoint(['create', '1', '--summary', 'First sync done'], env).status, 0);
      receive(['--channel', 'system', '--content', 'new msg'], env);
      setTimestamps(tmpDir, ['2026-01-01 00:00:00', '2026-01-01 00:00:01']);
      const result = cli(['--unsummarized'], env);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, 'unsummarized scope=* checkpointEnd=1\n[Last Checkpoint Summary] First sync done\n[2026-01-01 00:00:01] OUT (system):\nnew msg\n\ncount=1 upTo=2 safeEnd=2\n');
      const beforeCoverage = cli(['--unsummarized', '--after', '0'], env);
      assert.equal(beforeCoverage.status, 0, beforeCoverage.stderr);
      assert.equal(beforeCoverage.stdout, result.stdout);
      for (const after of ['2', '3']) {
        const empty = cli(['--unsummarized', '--after', after, '--json'], env);
        assert.equal(empty.status, 0, empty.stderr);
        const page = JSON.parse(empty.stdout).data;
        assert.equal(page.rows.length, 0); assert.equal(page.upTo, 2);
      }
    });
  });

  it('rejects invalid cursors and documents the paging option', () => {
    withTmpDir(({ env }) => {
      for (const cursor of ['-1', '1.5', 'no', '9007199254740992']) {
        const result = cli(['--unsummarized', '--after', cursor, '--json'], env);
        assert.equal(result.status, 1); assert.equal(JSON.parse(result.stdout).error.code, 'INVALID_ARGS');
      }
      const help = cli(['--help'], env);
      assert.equal(help.status, 0, help.stderr);
      assert.match(help.stdout, /--unsummarized \[--group G\] \[--after ID\]/);
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
        assert.ok(stderr.includes('INVALID_ARGS'), String(value));
        assert.ok(value.length === 0 ? stderr.includes('Missing value for --since') : stderr.includes('since must be a duration'), `${value}: ${stderr}`);
      }
    });
  });

  it('cannot be combined with --begin/--end or --unsummarized', () => {
    withTmpDir(({ env }) => {
      receive(['--channel', 'system', '--no-reply', '--content', 'msg1'], env);
      const cases = [
        [['--begin', '1', '--end', '2'], 'Unknown option --begin'],
        [['--end', '2'], 'Unknown option --end'],
        [['--unsummarized'], 'Fetch modes are mutually exclusive'],
      ];
      for (const [args, message] of cases) {
        for (const order of [['--since', '1d', ...args], [...args, '--since', '1d']]) {
          const { stdout, stderr, status } = cli(order, env);
          assert.equal(status, 1, String(order));
          assert.ok(stderr.includes('INVALID_ARGS') && stderr.includes(message), `${order}: ${stderr}`);
          assert.ok(!stdout.includes('msg1'), String(order));
        }
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
      assert.ok(stderr.includes('end must be an integer'));
    });
  });
});

function withAbsorbed(fn) {
  return withTmpDir(({ tmpDir, env }) => {
    const seed = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import * as db from ${JSON.stringify(new URL('../c4-db.js', import.meta.url).href)};
      const rows = Array.from({ length: 23 }, (_, i) => db.insertConversation('in', 'system', 'route-' + i, '🚀'.repeat(301) + '\\n尾'));
      const { runId } = db.beginModeTransition('single', 'multi');
      db.setDrainFence('*'); db.absorbForTransition(runId);
      console.log(JSON.stringify({ runId, ids: rows.map(row => row.id) })); db.close();
    `], childOptions(env));
    assert.equal(seed.status, 0, seed.stderr);
    const seeded = JSON.parse(seed.stdout);
    const args = ['--absorbed', '--run-id', seeded.runId];
    fn({ tmpDir, env, args, ...seeded });
  });
}

describe('c4-fetch absorbed public CLI', () => {
  it('parses absorbed JSON --after and --limit pagination flags', () => {
    withAbsorbed(({ env, args, ids }) => {
      const page = cli([...args, '--after', String(ids[19]), '--limit', '2', '--json'], env);
      assert.equal(page.status, 0, page.stderr);
      assert.deepEqual(JSON.parse(page.stdout).data.items.map(row => row.id), ids.slice(20, 22));
    });
  });
  it('rejects obsolete and conflicting flags and reports WRITE_FAILED in text and JSON', () => {
    withAbsorbed(({ tmpDir, env, args, ids }) => {
      for (const invalid of [ ['--offset','0'], ['--max-bytes','2048'], ['--limit','0'], ['--limit','101'], ['--out',path.join(tmpDir,'no-id')], ['--summary','--id',String(ids[0])], ['--id',String(ids[0]),'--limit','1'] ]) {
        const result = cli([...args, ...invalid, '--json'], env);
        assert.equal(result.status, 1); assert.equal(JSON.parse(result.stdout).error.code, 'INVALID_ARGS');
      }
      for (const json of [false, true]) {
        const out = path.join(tmpDir, 'missing', `export-${json}`);
        const result = cli([...args, '--id', String(ids[0]), '--out', out, ...(json ? ['--json'] : [])], env);
        assert.equal(result.status, 1);
        if (json) { assert.equal(JSON.parse(result.stdout).error.code, 'WRITE_FAILED'); assert.equal(result.stderr, ''); }
        else { assert.equal(result.stdout, ''); assert.match(result.stderr, /Error \[WRITE_FAILED\]/); }
        assert.equal(fs.existsSync(out), false);
      }
    });
  });
});
