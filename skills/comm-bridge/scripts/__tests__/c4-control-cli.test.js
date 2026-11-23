import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI_PATH = fileURLToPath(new URL('../c4-control.js', import.meta.url));

function cliRaw(args, env = {}) {
  const result = spawnSync('node', [CLI_PATH, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

function withTmpDir(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-control-cli-'));
  const env = { ZYLOS_DIR: tmpDir };
  try {
    return fn({ tmpDir, env });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function parseControlId(stdout) {
  const match = stdout.match(/control (\d+)/);
  assert.ok(match, `expected control id in output: ${stdout}`);
  return match[1];
}

// -- enqueue --

describe('c4-control enqueue', () => {
  it('basic enqueue returns OK and id', () => {
    withTmpDir(({ env }) => {
      const { stdout, status } = cliRaw(['enqueue', '--content', 'hello world'], env);
      assert.equal(status, 0);
      assert.match(stdout, /OK: enqueued control \d+/);
    });
  });

});

// -- enqueue validation --

// -- get --

// -- ack --

describe('c4-control ack', () => {
  it('marks control as done', () => {
    withTmpDir(({ env }) => {
      const { stdout: enqOut } = cliRaw(['enqueue', '--content', 'ack test'], env);
      const id = parseControlId(enqOut);

      const { stdout, status } = cliRaw(['ack', '--id', id], env);
      assert.equal(status, 0);
      assert.ok(stdout.includes(`control ${id} marked as done`));
    });
  });

});

// -- help --
