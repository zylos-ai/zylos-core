import Database from 'better-sqlite3';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI_PATH = fileURLToPath(new URL('../c4-checkpoint.js', import.meta.url));

function cli(args, env = {}) {
  const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
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
  const env = { ZYLOS_DIR: tmpDir, HOME: tmpDir };
  // Warm up: initialize DB so subsequent calls have clean stdout.
  cli(['latest'], env);
  const database = new Database(path.join(tmpDir, 'comm-bridge/c4.db'));
  for (let i=1; i<=30; i++) database.prepare("INSERT INTO conversations(direction,channel,content,status,session_group) VALUES('out','system',?,'delivered','origin')").run(`seed${i}`);
  database.close();
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

});

// -- create validation --

// -- list --

// -- latest --

// -- unknown command --

// -- help --
