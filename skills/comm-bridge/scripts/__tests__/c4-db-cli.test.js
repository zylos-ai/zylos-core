import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DB_CLI_PATH = fileURLToPath(new URL('../c4-db.js', import.meta.url));
const RECEIVE_PATH = fileURLToPath(new URL('../c4-receive.js', import.meta.url));

function dbCli(args, env = {}) {
  return spawnSync('node', [DB_CLI_PATH, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
}

function receive(args, env = {}) {
  return spawnSync('node', [RECEIVE_PATH, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
}

function withTmpDir(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-db-cli-'));
  const env = { ZYLOS_DIR: tmpDir };
  try {
    return fn({ tmpDir, env });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe('c4-db recent', () => {
  it('returns the latest N conversations in chronological order', () => {
    withTmpDir(({ env }) => {
      for (let i = 1; i <= 4; i++) {
        const result = receive(['--channel', 'system', '--no-reply', '--content', `msg${i}`], env);
        assert.equal(result.status, 0);
      }

      const { stdout, status } = dbCli(['recent', '3'], env);
      assert.equal(status, 0);

      const rows = JSON.parse(stdout);
      assert.equal(rows.length, 3);
      assert.deepEqual(rows.map(row => row.content), ['msg2', 'msg3', 'msg4']);
      assert.deepEqual(rows.map(row => row.id), [2, 3, 4]);
    });
  });
});

describe('void channel migration (#689)', () => {
  it('re-tags legacy web-console session-handoff rows to the void channel', () => {
    withTmpDir(({ tmpDir, env }) => {
      // Use the released initial layout rather than downgrading the version tag
      // of a database that already contains later migration tables.
      fs.mkdirSync(path.join(tmpDir, 'comm-bridge'), { recursive: true });
      const legacy = new Database(path.join(tmpDir, 'comm-bridge', 'c4.db'));
      legacy.exec(fs.readFileSync(new URL('../../init-db.sql', import.meta.url), 'utf8'));
      const insert = legacy.prepare('INSERT INTO conversations(direction,channel,endpoint_id,content) VALUES (?,?,?,?)');
      insert.run('out', 'web-console', 'session-handoff', 'handoff note');
      insert.run('out', 'web-console', 'console', 'normal console message');
      insert.run('out', 'telegram', 'session-handoff', 'not a web-console row');
      legacy.close();
      // The explicit 0→1 migration runs once before reads.
      const { stdout, status } = dbCli(['recent', '10'], env);
      assert.equal(status, 0);

      const rows = JSON.parse(stdout);
      const byContent = (content) => rows.find((row) => row.content === content);

      assert.equal(byContent('handoff note').channel, 'void');
      assert.equal(byContent('handoff note').endpoint_id, 'session-handoff');
      assert.equal(byContent('normal console message').channel, 'web-console');
      assert.equal(byContent('not a web-console row').channel, 'telegram');
    });
  });
});

describe('c4-db range-info (#775)', () => {
  // Rows with explicit ids. Timestamps run against id order and there are id
  // gaps, so only an id-ordered query gives the expected values.
  function insertRows(tmpDir, ids) {
    const db = new Database(path.join(tmpDir, 'comm-bridge', 'c4.db'));
    try {
      const insert = db.prepare(
        "INSERT INTO conversations(id, timestamp, direction, channel, content) VALUES (?, ?, 'in', 'system', ?)"
      );
      ids.forEach((id, i) => insert.run(id, `2026-01-01 00:00:${String(59 - i).padStart(2, '0')}`, `msg${id}`));
    } finally {
      db.close();
    }
  }

  function rangeInfo(args, env) {
    const { stdout, stderr, status } = dbCli(['range-info', ...args], env);
    assert.equal(status, 0, stderr);
    return JSON.parse(stdout);
  }

  function withRows(ids, fn) {
    withTmpDir(({ tmpDir, env }) => {
      assert.equal(dbCli(['init'], env).status, 0);
      insertRows(tmpDir, ids);
      fn({ env });
    });
  }

  it('reports latest id, count and the first id after the cursor', () => {
    withRows([1, 2, 3, 5, 8, 9], ({ env }) => {
      assert.deepEqual(rangeInfo(['--after', '2'], env), {
        latest_id: 9, after_id: 2, count: 4, begin_id: 3
      });
      assert.deepEqual(rangeInfo(['--after', '0'], env), {
        latest_id: 9, after_id: 0, count: 6, begin_id: 1
      });
    });
  });

  it('caps begin_id to the newest N rows by id with --limit', () => {
    withRows([1, 2, 3, 5, 8, 9], ({ env }) => {
      assert.deepEqual(rangeInfo(['--after', '1', '--limit', '3'], env), {
        latest_id: 9, after_id: 1, count: 5, begin_id: 5
      });
      // The flags may come in either order
      assert.deepEqual(rangeInfo(['--limit', '1', '--after', '1'], env), {
        latest_id: 9, after_id: 1, count: 5, begin_id: 9
      });
      // A limit at or above the count covers the whole range
      for (const limit of ['5', '50']) {
        assert.equal(rangeInfo(['--after', '1', '--limit', limit], env).begin_id, 2);
      }
    });
  });

  it('starts the range at the first existing id after a gap', () => {
    withRows([1, 2, 3, 5, 8, 9], ({ env }) => {
      assert.deepEqual(rangeInfo(['--after', '5'], env), {
        latest_id: 9, after_id: 5, count: 2, begin_id: 8
      });
      assert.equal(rangeInfo(['--after', '6'], env).begin_id, 8);
    });
  });

  it('reports an empty range when the cursor is at or past the latest id', () => {
    withRows([1, 2, 3], ({ env }) => {
      for (const after of ['3', '10']) {
        assert.deepEqual(rangeInfo(['--after', after, '--limit', '2'], env), {
          latest_id: 3, after_id: Number(after), count: 0, begin_id: null
        });
      }
    });
  });

  it('reports null ids on an empty database', () => {
    withTmpDir(({ env }) => {
      assert.deepEqual(rangeInfo(['--after', '0'], env), {
        latest_id: null, after_id: 0, count: 0, begin_id: null
      });
    });
  });

  it('rejects a missing or invalid --after and --limit', () => {
    withTmpDir(({ env }) => {
      const invalid = [
        [],
        ['--limit', '5'],
        ['--after'],
        ['--after', '-1'],
        ['--after', '1.5'],
        ['--after', 'abc'],
        ['--after', '99999999999999999999'],
        ['--after', '1', '--limit', '0'],
        ['--after', '1', '--limit', '-3'],
        ['--after', '1', '--limit', 'ten'],
        ['--after', '1', '--after', '2'],
        ['--after', '1', '--begin', '2'],
        ['5']
      ];
      for (const args of invalid) {
        const { stdout, stderr, status } = dbCli(['range-info', ...args], env);
        assert.equal(status, 1, `expected exit 1 for ${JSON.stringify(args)}`);
        assert.equal(stdout, '');
        assert.ok(stderr.includes('Usage: c4-db.js range-info --after <id> [--limit <N>]'));
      }
    });
  });
});
