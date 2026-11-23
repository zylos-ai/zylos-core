import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrateDatabase } from '../sqlite-schema.js';
import * as c4Schema from '../c4-schema.js';

const DB_CLI_PATH = fileURLToPath(new URL('../c4-db.js', import.meta.url));
const RECEIVE_PATH = fileURLToPath(new URL('../c4-receive.js', import.meta.url));

function dbCli(args, env = {}) {
  return spawnSync(process.execPath, [DB_CLI_PATH, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
}

function receive(args, env = {}) {
  return spawnSync(process.execPath, [RECEIVE_PATH, ...args], {
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
      const file = path.join(tmpDir, 'comm-bridge', 'c4.db');
      const before = fs.readFileSync(file);
      // An ordinary read reports the required upgrade and leaves the layout alone.
      const refused = dbCli(['recent', '10'], env);
      assert.notEqual(refused.status, 0);
      assert.match(refused.stderr, /SCHEMA_UPGRADE_REQUIRED/);
      assert.ok(fs.readFileSync(file).equals(before), `${file} changed`);
      // The explicit 0→1 migration runs once before reads.
      const upgrade = new Database(file);
      migrateDatabase(upgrade, c4Schema, { strict: false });
      upgrade.close();
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

describe('group query CLI', () => {
  it('returns queue and filtered group envelopes through the actual CLI', () => {
    withTmpDir(({ tmpDir, env }) => {
      const inserted = dbCli(['insert', 'in', 'system', 'null', 'hello', '--json'], env);
      assert.equal(inserted.status, 0, inserted.stderr);
      const queues = dbCli(['group-queues', '--json'], env);
      assert.equal(queues.status, 0, queues.stderr);
      const summary = JSON.parse(queues.stdout);
      assert.equal(summary.ok, true);
      assert.equal(summary.data.groups[0].sessionGroup, 'origin');
      assert.equal(summary.data.groups[0].pending.count, 1);
      assert.equal(summary.data.globalFence, null);
      const text = dbCli(['group-queues'], env);
      assert.equal(text.status, 0); assert.deepEqual(JSON.parse(text.stdout), summary.data);
      const active = dbCli(['groups', '--active-since', '0', '--json'], env);
      assert.equal(active.status, 0, active.stderr);
      assert.equal(JSON.parse(active.stdout).data.groups.length, 1);
      assert.equal(JSON.parse(active.stdout).data.hasOlder, false);
      const search = dbCli(['groups', '--key-match', 'ORIG', '--json'], env);
      assert.equal(search.status, 0); assert.equal(JSON.parse(search.stdout).data[0].sessionGroup, 'origin');
      // A labelled preview carries its stored start only with --raw.
      assert.equal(dbCli(['insert', 'in', 'system', 'null', '[Report bot] daily\nline two', '--json'], env).status, 0);
      const plain = JSON.parse(dbCli(['groups', '--key-match', 'origin', '--json'], env).stdout).data[0].preview;
      assert.equal(plain.message, 'daily'); assert.equal(Object.hasOwn(plain, 'messageRaw'), false);
      const raw = dbCli(['groups', '--key-match', 'origin', '--raw', '--json'], env);
      assert.equal(raw.status, 0, raw.stderr);
      assert.equal(JSON.parse(raw.stdout).data[0].preview.messageRaw, '[Report bot] daily\nline two');
      // A key search lists the group whose key equals the search (same letter case) first, ahead of newer groups
      // whose keys contain it in any case, so one group is read with --limit 1.
      fs.mkdirSync(path.join(tmpDir, '.claude', 'skills', 'telegram'), { recursive: true });
      for (const name of ['Ab', 'ab_1']) assert.equal(dbCli(['insert', 'in', 'telegram', 'null', 'hi', '--session-group', name, '--json'], env).status, 0);
      const keys = args => JSON.parse(dbCli(['groups', '--key-match', ...args, '--json'], env).stdout).data.map(row => row.sessionGroup);
      assert.deepEqual(keys(['telegram:ab', '--limit', '5']), ['telegram:ab_1', 'telegram:Ab'], 'other groups stay newest first');
      assert.deepEqual(keys(['telegram:Ab', '--limit', '1']), ['telegram:Ab']);
      assert.match(dbCli(['--help'], env).stdout, /group-queues/);
      assert.match(dbCli(['--help'], env).stdout, /active-since/);
      assert.match(dbCli(['--help'], env).stdout, /--raw/);
    });
  });
});
