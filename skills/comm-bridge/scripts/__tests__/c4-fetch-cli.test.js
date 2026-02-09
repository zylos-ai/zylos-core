import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI_PATH = fileURLToPath(new URL('../c4-fetch.js', import.meta.url));
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-fetch-cli-'));
  const env = { ZYLOS_DIR: tmpDir };
  // Warm up DB
  checkpoint(['latest'], env);
  try {
    return fn({ tmpDir, env });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// -- --unsummarized --

describe('c4-fetch --unsummarized', () => {
  it('reports no unsummarized conversations on fresh DB', () => {
    withTmpDir(({ env }) => {
      const { stdout, status } = cli(['--unsummarized'], env);
      assert.equal(status, 0);
      assert.ok(stdout.includes('No unsummarized conversations'));
    });
  });

  it('fetches unsummarized conversations', () => {
    withTmpDir(({ env }) => {
      receive(['--channel', 'system', '--no-reply', '--content', 'msg1'], env);
      receive(['--channel', 'system', '--no-reply', '--content', 'msg2'], env);

      const { stdout, status } = cli(['--unsummarized'], env);
      assert.equal(status, 0);
      assert.ok(stdout.includes('Unsummarized Range'));
      assert.ok(stdout.includes('count=2'));
      assert.ok(stdout.includes('msg1'));
      assert.ok(stdout.includes('msg2'));
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
      assert.ok(stderr.includes('Usage'));
    });
  });
});
