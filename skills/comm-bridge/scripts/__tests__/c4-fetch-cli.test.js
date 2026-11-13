import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { verifyBatchReceipt } from '../c4-sync-batch.js';

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

// -- --origin-sync --out --

describe('c4-fetch --origin-sync --out', () => {
  // Real CLI -> Origin snapshot reads -> private SQLite/export files. Run when
  // Origin reads, export writing or receipts change; skip unrelated changes.
  // withTmpDir and the official runner isolate and reclaim all child paths.
  it('exports both Origin reads with byte parity, absolute paths and receipts', () => {
    withTmpDir(({ tmpDir, env }) => {
      const database = new Database(path.join(tmpDir, 'comm-bridge', 'c4.db'));
      const insert = database.prepare("INSERT INTO conversations(direction,channel,content,status,session_group) VALUES('out','system',?,?,'foo')");
      try {
        const long = 'L'.repeat(17 * 1024) + '\u4e2d\ud83c\udf0d';
        for (const text of ['one', 'two', long, 'four']) insert.run(text, 'delivered');
        insert.run('pending outbound', 'pending');
        database.prepare("INSERT INTO conversations(direction,channel,content,status,session_group) VALUES('out','system','foreign','delivered','bar')").run();
        assert.equal(checkpoint(['create', '2', '--group', 'foo', '--summary', 'summary ' + long], env).status, 0);
        const cp = database.prepare("SELECT id FROM checkpoints WHERE session_group='foo'").get().id;
        for (const format of [[], ['--json']]) {
          const reads = [['summaries', ['--summaries-only']], ['raw', ['--raw-only', '--after', '2', '--limit', '2']]];
          for (const [name, mode] of reads) {
            const args = ['--origin-sync', '--group', 'foo', ...mode, ...format];
            const direct = cli(args, env);
            assert.equal(direct.status, 0, direct.stderr);
            const relative = `${name}${format.length ? '.json' : '.txt'}`;
            const exported = cli([...args, '--out', relative], env);
            assert.equal(exported.status, 0, exported.stderr);
            const metadata = format.length ? JSON.parse(exported.stdout).data : JSON.parse(exported.stdout);
            assert.equal(metadata.path, path.join(env.ZYLOS_DIR, relative));
            const bytes = fs.readFileSync(metadata.path);
            assert.ok(bytes.equals(Buffer.from(direct.stdout)), `${name} export bytes equal direct stdout`);
            assert.equal(fs.statSync(metadata.path).mode & 0o777, 0o600);
            assert.equal(metadata.bytes, bytes.length);
            assert.equal(metadata.sha256, createHash('sha256').update(bytes).digest('hex'));
            assert.ok(!exported.stdout.includes('L'.repeat(64)), 'stdout carries metadata only');
            if (name === 'summaries') {
              assert.deepEqual([metadata.count, metadata.firstId, metadata.lastId], [1, cp, cp]);
              assert.deepEqual(Object.keys(metadata.receipt).sort(), ['after', 'count', 'coverageEnd', 'end', 'scope', 'sha256']);
              assert.deepEqual([metadata.receipt.scope, metadata.receipt.after, metadata.receipt.end, metadata.receipt.coverageEnd, metadata.receipt.count], ['foo', 0, cp, 2, 1]);
            } else {
              // A limited read ends at its last returned row, not at the frontier.
              assert.deepEqual([metadata.count, metadata.firstId, metadata.lastId], [2, 3, 4]);
              assert.deepEqual(Object.keys(metadata.receipt).sort(), ['after', 'count', 'end', 'scope', 'sha256']);
              assert.deepEqual([metadata.receipt.after, metadata.receipt.end, metadata.receipt.count], [2, 4, 2]);
            }
            const retry = cli([...args, '--out', relative], env);
            assert.equal(retry.status, 1);
            assert.ok(fs.readFileSync(metadata.path).equals(bytes), 'Rejected overwrite preserves export bytes');
          }
        }
        // A complete raw read includes the non-delivered outbound row and ends at the snapshot bound.
        const complete = JSON.parse(cli(['--origin-sync', '--group', 'foo', '--raw-only', '--after', '2', '--out', 'complete.json', '--json'], env).stdout).data;
        assert.deepEqual([complete.count, complete.firstId, complete.lastId, complete.receipt.end], [3, 3, 5, 5]);
        const combined = cli(['--origin-sync', '--group', 'foo', '--out', 'combined.json'], env);
        assert.equal(combined.status, 1);
        assert.match(combined.stderr, /out requires --summaries-only or --raw-only/);
        assert.equal(fs.existsSync(path.join(env.ZYLOS_DIR, 'combined.json')), false);
        const unsummarized = cli(['--unsummarized', '--group', 'foo', '--out', 'relative-batch', '--json'], env);
        assert.equal(unsummarized.status, 0, unsummarized.stderr);
        assert.equal(JSON.parse(unsummarized.stdout).data.path, path.join(env.ZYLOS_DIR, 'relative-batch'));
      } finally { database.close(); }
    });
  });
});

// -- --unsummarized --

describe('c4-fetch --unsummarized', () => {
  // Real CLI -> projected queries -> private SQLite/export files. Run when
  // export formatting or receipt boundaries change; skip unrelated changes.
  // withTmpDir and the official runner isolate and reclaim all child paths.
  it('exports complete Unicode text and JSON with byte parity and a verifiable receipt', () => {
    withTmpDir(({ tmpDir, env }) => {
      const database = new Database(path.join(tmpDir, 'comm-bridge', 'c4.db'));
      const content = '\u4e2d\u6587\ud83c\udf0d\n'.repeat(15000);
      database.prepare("INSERT INTO conversations(direction,channel,content,status,session_group) VALUES('out','system',?,'delivered','foo')").run(content);
      database.prepare("INSERT INTO conversations(direction,channel,content,status,session_group) VALUES('out','system','foreign','delivered','bar')").run();
      try {
        for (const format of [[], ['--json']]) {
          const args = ['--unsummarized', '--group', 'foo', ...format];
          const direct = cli(args, env);
          assert.equal(direct.status, 0, direct.stderr);
          const out = path.join(tmpDir, format.length ? 'batch.json' : 'batch.txt');
          const exported = cli([...args, '--out', out], env);
          assert.equal(exported.status, 0, exported.stderr);
          const metadata = format.length ? JSON.parse(exported.stdout).data : JSON.parse(exported.stdout);
          const bytes = fs.readFileSync(out);
          assert.ok(bytes.equals(Buffer.from(direct.stdout)), 'Export bytes equal direct stdout');
          assert.equal(fs.statSync(out).mode & 0o777, 0o600);
          assert.equal(metadata.bytes, bytes.length);
          assert.equal(metadata.sha256, createHash('sha256').update(bytes).digest('hex'));
          assert.equal(metadata.count, 1); assert.equal(metadata.firstId, 1); assert.equal(metadata.lastId, 1);
          assert.equal(metadata.batch.end, 1);
          assert.ok(!exported.stdout.includes(content.slice(0, 40)));
          const reader = { getConversationsByRange: (begin, end) => database.prepare('SELECT * FROM conversations WHERE id BETWEEN ? AND ?').all(begin, end) };
          assert.deepEqual(verifyBatchReceipt(metadata.batch, { scope: 'foo', end: 1, database: reader }), metadata.batch);
          const retry = cli([...args, '--out', out], env);
          assert.equal(retry.status, 1);
          assert.ok(fs.readFileSync(out).equals(bytes), 'Rejected overwrite preserves export bytes');
        }
      } finally { database.close(); }
    });
  });

  it('exports limited and empty batches using coverage and actual returned boundaries', () => {
    withTmpDir(({ tmpDir, env }) => {
      receive(['--channel', 'system', '--content', 'covered'], env);
      assert.equal(checkpoint(['create', '1', '--no-content'], env).status, 0);
      receive(['--channel', 'system', '--content', 'second'], env);
      receive(['--channel', 'system', '--content', 'third'], env);
      const result = cli(['--unsummarized', '--limit', '1', '--after', '0', '--out', path.join(tmpDir, 'limited'), '--json'], env);
      assert.equal(result.status, 0, result.stderr);
      const metadata = JSON.parse(result.stdout).data;
      assert.equal(metadata.batch.after, 1); assert.equal(metadata.batch.end, 2);
      const full = cli(['--unsummarized', '--limit', '2', '--out', path.join(tmpDir, 'two-rows'), '--json'], env);
      assert.equal(full.status, 0, full.stderr);
      const two = JSON.parse(full.stdout).data;
      assert.equal(two.count, 2); assert.equal(two.firstId, 2); assert.equal(two.lastId, 3);
      assert.equal(two.batch.after, 1); assert.equal(two.batch.end, 3);
      const empty = cli(['--unsummarized', '--after', '3', '--out', path.join(tmpDir, 'empty'), '--json'], env);
      assert.equal(empty.status, 0, empty.stderr);
      const receipt = JSON.parse(empty.stdout).data;
      assert.equal(receipt.count, 0); assert.equal(receipt.firstId, null); assert.equal(receipt.lastId, null);
      assert.equal(receipt.batch.after, 3); assert.equal(receipt.batch.end, 3);
    });
  });

  it('reads a long single-line export completely with bounded overlapping byte ranges', () => {
    withTmpDir(({ tmpDir, env }) => {
      const database = new Database(path.join(tmpDir, 'comm-bridge', 'c4.db'));
      try {
        const content = 'x'.repeat(120 * 1024) + '\u4e2d\u6587\ud83c\udf0d';
        database.prepare("INSERT INTO conversations(direction,channel,content,status,session_group) VALUES('out','system',?,'delivered','foo')").run(content);
        const out = path.join(tmpDir, 'long-line');
        const result = cli(['--unsummarized', '--group', 'foo', '--out', out, '--json'], env);
        assert.equal(result.status, 0, result.stderr);
        const metadata = JSON.parse(result.stdout).data;
        const chunks = [];
        for (let start = 0; start < metadata.bytes; start += 8188) {
          const read = spawnSync('dd', [`if=${out}`, 'bs=1', `skip=${start}`, 'count=8192', 'status=none'],
            { ...childOptions(env), encoding: null, maxBuffer: 16384 });
          assert.equal(read.status, 0, read.stderr?.toString());
          assert.equal(read.stdout.length, Math.min(8192, metadata.bytes - start));
          chunks.push(read.stdout.subarray(0, Math.min(8188, metadata.bytes - start)));
        }
        const reconstructed = Buffer.concat(chunks);
        assert.equal(reconstructed.length, metadata.bytes);
        assert.equal(createHash('sha256').update(reconstructed).digest('hex'), metadata.sha256);
        assert.ok(reconstructed.includes(Buffer.from(content)));
      } finally { database.close(); }
    });
  });

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
