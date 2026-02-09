import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI_PATH = fileURLToPath(new URL('../c4-session-init.js', import.meta.url));
const RECEIVE_PATH = fileURLToPath(new URL('../c4-receive.js', import.meta.url));
const CHECKPOINT_PATH = fileURLToPath(new URL('../c4-checkpoint.js', import.meta.url));

function cli(args, env = {}) {
  const result = spawnSync('node', [CLI_PATH, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

function receive(args, env = {}) {
  return spawnSync('node', [RECEIVE_PATH, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
}

function checkpoint(args, env = {}) {
  return spawnSync('node', [CHECKPOINT_PATH, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
}

function withTmpDir(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-session-init-'));
  const env = { ZYLOS_DIR: tmpDir };
  // Warm up DB
  checkpoint(['latest'], env);
  try {
    return fn({ tmpDir, env });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// -- basic behavior --

describe('c4-session-init', () => {
  it('reports no new conversations on fresh DB', () => {
    withTmpDir(({ env }) => {
      const { stdout, status } = cli([], env);
      assert.equal(status, 0);
      assert.ok(stdout.includes('No new conversations since last checkpoint'));
    });
  });

  it('outputs last checkpoint summary', () => {
    withTmpDir(({ env }) => {
      receive(['--channel', 'system', '--no-reply', '--content', 'msg1'], env);
      checkpoint(['create', '1', '--summary', 'Synced first batch'], env);
      receive(['--channel', 'system', '--no-reply', '--content', 'msg2'], env);

      const { stdout, status } = cli([], env);
      assert.equal(status, 0);
      assert.ok(stdout.includes('Synced first batch'));
      assert.ok(stdout.includes('msg2'));
    });
  });

  it('shows recent conversations when under threshold', () => {
    withTmpDir(({ env }) => {
      for (let i = 1; i <= 3; i++) {
        receive(['--channel', 'system', '--no-reply', '--content', `msg${i}`], env);
      }

      const { stdout, status } = cli([], env);
      assert.equal(status, 0);
      assert.ok(stdout.includes('msg1'));
      assert.ok(stdout.includes('msg2'));
      assert.ok(stdout.includes('msg3'));
      // Should NOT trigger Memory Sync instruction
      assert.ok(!stdout.includes('Action Required'));
    });
  });

  it('triggers Memory Sync instruction when over threshold', () => {
    withTmpDir(({ env }) => {
      // CHECKPOINT_THRESHOLD is 30; insert 31 messages
      for (let i = 1; i <= 31; i++) {
        receive(['--channel', 'system', '--no-reply', '--content', `msg${i}`], env);
      }

      const { stdout, status } = cli([], env);
      assert.equal(status, 0);
      assert.ok(stdout.includes('Action Required'));
      assert.ok(stdout.includes('zylos-memory'));
      // Should show limited conversations (SESSION_INIT_RECENT_COUNT = 6)
      assert.ok(stdout.includes('msg31'));
      assert.ok(stdout.includes('msg26'));
      // msg1 should NOT be included (limited to recent)
      assert.ok(!stdout.includes('[Recent Conversations]\nmsg1') && !stdout.match(/IN \(system\):\nmsg1\n/));
    });
  });
});
