import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI_PATH = fileURLToPath(new URL('../c4-checkpoint.js', import.meta.url));

function cli(args, env = {}) {
  const result = spawnSync('node', [CLI_PATH, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

/**
 * Create a fresh tmpDir and initialize the DB by running a harmless command.
 * This avoids "[C4-DB] Database initialized" polluting stdout in later calls.
 */
function withTmpDir(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-checkpoint-cli-'));
  const env = { ZYLOS_DIR: tmpDir };
  // Warm up: initialize DB so subsequent calls have clean stdout.
  cli(['latest'], env);
  try {
    return fn({ tmpDir, env });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// Note: init-db.sql inserts an "initial" checkpoint (id=1, summary='initial').
// All tests account for this seed record.

// -- create --

describe('c4-checkpoint create', () => {
  it('creates a checkpoint and prints result', () => {
    withTmpDir(({ env }) => {
      const { stdout, status } = cli(['create', '10', '--summary', 'First batch'], env);
      assert.equal(status, 0);
      assert.ok(stdout.includes('Checkpoint created:'));
      const json = JSON.parse(stdout.replace('Checkpoint created: ', ''));
      assert.equal(json.start_conversation_id, 1);
      assert.equal(json.end_conversation_id, 10);
    });
  });

  it('auto-computes start_conversation_id from previous checkpoint', () => {
    withTmpDir(({ env }) => {
      cli(['create', '10', '--summary', 'First'], env);
      const { stdout, status } = cli(['create', '25', '--summary', 'Second'], env);
      assert.equal(status, 0);
      const json = JSON.parse(stdout.replace('Checkpoint created: ', ''));
      assert.equal(json.start_conversation_id, 11);
      assert.equal(json.end_conversation_id, 25);
    });
  });

  it('creates checkpoint without --summary', () => {
    withTmpDir(({ env }) => {
      const { stdout, status } = cli(['create', '5'], env);
      assert.equal(status, 0);
      assert.ok(stdout.includes('Checkpoint created:'));
    });
  });
});

// -- create validation --

describe('c4-checkpoint create validation', () => {
  it('errors when end_conversation_id is missing', () => {
    withTmpDir(({ env }) => {
      const { stderr, status } = cli(['create'], env);
      assert.equal(status, 1);
      assert.ok(stderr.includes('end_conversation_id'));
    });
  });

  it('errors when end_conversation_id is not a number', () => {
    withTmpDir(({ env }) => {
      const { stderr, status } = cli(['create', 'abc'], env);
      assert.equal(status, 1);
      assert.ok(stderr.includes('number'));
    });
  });
});

// -- list --

describe('c4-checkpoint list', () => {
  it('returns seed checkpoint on fresh DB', () => {
    withTmpDir(({ env }) => {
      const { stdout, status } = cli(['list'], env);
      assert.equal(status, 0);
      const rows = JSON.parse(stdout);
      assert.ok(Array.isArray(rows));
      assert.equal(rows.length, 1);
      assert.equal(rows[0].summary, 'initial');
    });
  });

  it('lists checkpoints in reverse chronological order', () => {
    withTmpDir(({ env }) => {
      cli(['create', '10', '--summary', 'First'], env);
      cli(['create', '20', '--summary', 'Second'], env);
      cli(['create', '30', '--summary', 'Third'], env);

      const { stdout, status } = cli(['list'], env);
      assert.equal(status, 0);
      const rows = JSON.parse(stdout);
      // 3 created + 1 seed = 4
      assert.equal(rows.length, 4);
      assert.equal(rows[0].summary, 'Third');
      assert.equal(rows[1].summary, 'Second');
      assert.equal(rows[2].summary, 'First');
      assert.equal(rows[3].summary, 'initial');
    });
  });

  it('respects --limit', () => {
    withTmpDir(({ env }) => {
      cli(['create', '10', '--summary', 'First'], env);
      cli(['create', '20', '--summary', 'Second'], env);
      cli(['create', '30', '--summary', 'Third'], env);

      const { stdout, status } = cli(['list', '--limit', '2'], env);
      assert.equal(status, 0);
      const rows = JSON.parse(stdout);
      assert.equal(rows.length, 2);
      assert.equal(rows[0].summary, 'Third');
      assert.equal(rows[1].summary, 'Second');
    });
  });

  it('errors on invalid --limit', () => {
    withTmpDir(({ env }) => {
      const { stderr, status } = cli(['list', '--limit', '-1'], env);
      assert.equal(status, 1);
      assert.ok(stderr.includes('positive integer'));
    });
  });
});

// -- latest --

describe('c4-checkpoint latest', () => {
  it('returns the most recent checkpoint', () => {
    withTmpDir(({ env }) => {
      cli(['create', '10', '--summary', 'First'], env);
      cli(['create', '20', '--summary', 'Second'], env);

      const { stdout, status } = cli(['latest'], env);
      assert.equal(status, 0);
      const row = JSON.parse(stdout);
      assert.equal(row.summary, 'Second');
      assert.equal(row.end_conversation_id, 20);
    });
  });

  it('returns seed checkpoint on fresh DB', () => {
    withTmpDir(({ env }) => {
      const { stdout, status } = cli(['latest'], env);
      assert.equal(status, 0);
      const row = JSON.parse(stdout);
      assert.equal(row.summary, 'initial');
    });
  });
});

// -- unknown command --

describe('c4-checkpoint unknown command', () => {
  it('rejects unknown subcommand', () => {
    withTmpDir(({ env }) => {
      const { stderr, status } = cli(['foobar'], env);
      assert.equal(status, 1);
      assert.ok(stderr.includes('unknown command'));
    });
  });

  it('rejects bare number (no legacy fallback)', () => {
    withTmpDir(({ env }) => {
      const { stderr, status } = cli(['50'], env);
      assert.equal(status, 1);
      assert.ok(stderr.includes('unknown command'));
    });
  });
});

// -- help --

describe('c4-checkpoint help', () => {
  it('--help shows usage and exits 0', () => {
    withTmpDir(({ env }) => {
      const { stderr, status } = cli(['--help'], env);
      assert.equal(status, 0);
      assert.ok(stderr.includes('Usage'));
    });
  });

  it('-h shows usage and exits 0', () => {
    withTmpDir(({ env }) => {
      const { stderr, status } = cli(['-h'], env);
      assert.equal(status, 0);
      assert.ok(stderr.includes('Usage'));
    });
  });

  it('no arguments shows usage and exits 1', () => {
    withTmpDir(({ env }) => {
      const { stderr, status } = cli([], env);
      assert.equal(status, 1);
      assert.ok(stderr.includes('Usage'));
    });
  });
});
