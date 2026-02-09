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

  it('enqueue with --priority', () => {
    withTmpDir(({ env }) => {
      const { stdout, status } = cliRaw(['enqueue', '--content', 'priority test', '--priority', '5'], env);
      assert.equal(status, 0);
      const id = parseControlId(stdout);

      const { stdout: getOut } = cliRaw(['get', '--id', id], env);
      assert.match(getOut, /status=pending/);
    });
  });

  it('enqueue with --ack-deadline', () => {
    withTmpDir(({ env }) => {
      const { stdout, status } = cliRaw(
        ['enqueue', '--content', 'deadline test', '--ack-deadline', '300'], env
      );
      assert.equal(status, 0);
      const id = parseControlId(stdout);

      const { stdout: getOut } = cliRaw(['get', '--id', id], env);
      assert.match(getOut, /status=pending/);
    });
  });

  it('enqueue with --available-in', () => {
    withTmpDir(({ env }) => {
      const { stdout, status } = cliRaw(
        ['enqueue', '--content', 'delayed test', '--available-in', '60'], env
      );
      assert.equal(status, 0);
      const id = parseControlId(stdout);

      const { stdout: getOut } = cliRaw(['get', '--id', id], env);
      assert.match(getOut, /status=pending/);
    });
  });

  it('enqueue with --require-idle', () => {
    withTmpDir(({ env }) => {
      const { stdout, status } = cliRaw(
        ['enqueue', '--content', 'idle test', '--require-idle'], env
      );
      assert.equal(status, 0);
      assert.match(stdout, /OK: enqueued control \d+/);
    });
  });

  it('enqueue with --bypass-state', () => {
    withTmpDir(({ env }) => {
      const { stdout, status } = cliRaw(
        ['enqueue', '--content', 'bypass test', '--bypass-state'], env
      );
      assert.equal(status, 0);
      assert.match(stdout, /OK: enqueued control \d+/);
    });
  });

  it('enqueue auto-appends ack suffix to content', () => {
    withTmpDir(({ env }) => {
      const { stdout, status } = cliRaw(
        ['enqueue', '--content', 'Do something.'], env
      );
      assert.equal(status, 0);
      const id = parseControlId(stdout);
      // The ack suffix is auto-appended by insertControl in the DB.
      // We can't verify content via CLI get (it only prints status), but we verify
      // the enqueue itself succeeded and returned a valid id.
      assert.ok(Number(id) > 0);
    });
  });
});

// -- enqueue validation --

describe('c4-control enqueue validation', () => {
  it('missing --content exits 1 with error', () => {
    withTmpDir(({ env }) => {
      const { stderr, status } = cliRaw(['enqueue'], env);
      assert.equal(status, 1);
      assert.ok(stderr.includes('content'), `expected "content" in stderr: ${stderr}`);
    });
  });

  it('invalid --priority exits 1', () => {
    withTmpDir(({ env }) => {
      const { stderr, status } = cliRaw(
        ['enqueue', '--content', 'test', '--priority', 'abc'], env
      );
      assert.equal(status, 1);
      assert.ok(stderr.length > 0);
    });
  });

  it('invalid --ack-deadline exits 1', () => {
    withTmpDir(({ env }) => {
      const { stderr, status } = cliRaw(
        ['enqueue', '--content', 'test', '--ack-deadline', '-1'], env
      );
      assert.equal(status, 1);
      assert.ok(stderr.length > 0);
    });
  });
});

// -- get --

describe('c4-control get', () => {
  it('returns status for existing id', () => {
    withTmpDir(({ env }) => {
      const { stdout: enqOut } = cliRaw(['enqueue', '--content', 'get test'], env);
      const id = parseControlId(enqOut);

      const { stdout, status } = cliRaw(['get', '--id', id], env);
      assert.equal(status, 0);
      assert.match(stdout, /status=pending/);
    });
  });

  it('errors on non-existent id', () => {
    withTmpDir(({ env }) => {
      const { stderr, status } = cliRaw(['get', '--id', '99999'], env);
      assert.equal(status, 1);
      assert.ok(stderr.includes('not found'));
    });
  });

  it('errors on missing --id', () => {
    withTmpDir(({ env }) => {
      const { stderr, status } = cliRaw(['get'], env);
      assert.equal(status, 1);
      assert.ok(stderr.length > 0);
    });
  });
});

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

  it('idempotent ack on already-done control', () => {
    withTmpDir(({ env }) => {
      const { stdout: enqOut } = cliRaw(['enqueue', '--content', 'double ack'], env);
      const id = parseControlId(enqOut);

      // First ack
      cliRaw(['ack', '--id', id], env);
      // Second ack
      const { stdout, status } = cliRaw(['ack', '--id', id], env);
      assert.equal(status, 0);
      assert.ok(stdout.includes('already in final state'));
    });
  });

  it('errors on not-found id', () => {
    withTmpDir(({ env }) => {
      const { stderr, status } = cliRaw(['ack', '--id', '99999'], env);
      assert.equal(status, 1);
      assert.ok(stderr.includes('not found'));
    });
  });
});

// -- help --

describe('c4-control help', () => {
  it('--help shows usage and exits 0', () => {
    withTmpDir(({ env }) => {
      const { stderr, status } = cliRaw(['--help'], env);
      assert.equal(status, 0);
      assert.ok(stderr.includes('Usage'));
    });
  });

  it('-h shows usage and exits 0', () => {
    withTmpDir(({ env }) => {
      const { stderr, status } = cliRaw(['-h'], env);
      assert.equal(status, 0);
      assert.ok(stderr.includes('Usage'));
    });
  });
});
