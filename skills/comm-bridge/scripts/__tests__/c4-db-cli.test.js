import assert from 'node:assert/strict';
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
