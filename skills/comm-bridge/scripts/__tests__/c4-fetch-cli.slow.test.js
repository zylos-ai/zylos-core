// covers: skills/comm-bridge/scripts/c4-public-cli.js skills/comm-bridge/scripts/c4-fetch-format.js skills/comm-bridge/scripts/c4-fetch.js skills/comm-bridge/scripts/c4-db.js skills/comm-bridge/scripts/c4-checkpoint.js
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const CLI_PATH = fileURLToPath(new URL('../c4-fetch.js', import.meta.url));
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
    ...childOptions(env),
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
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

// -- --unsummarized --

describe('c4-fetch --unsummarized', () => {
  // Real CLI -> projected queries -> private SQLite/export files. Run when
  // export formatting change; skip unrelated changes.
  // withTmpDir and the official runner isolate and reclaim all child paths.
  it('exports complete Unicode text and JSON with byte parity', () => {
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
          assert.ok(!exported.stdout.includes(content.slice(0, 40)));
          const retry = cli([...args, '--out', out], env);
          assert.equal(retry.status, 1);
          assert.ok(fs.readFileSync(out).equals(bytes), 'Rejected overwrite preserves export bytes');
        }
      } finally { database.close(); }
    });
  });

});
