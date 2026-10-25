import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI_PATH = fileURLToPath(new URL('../c4-session-init.js', import.meta.url));
const CHECKPOINT_PATH = fileURLToPath(new URL('../c4-checkpoint.js', import.meta.url));

function cli(args, env = {}) {
  const result = spawnSync('node', [CLI_PATH, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

function receive(args, env = {}) {
  const value = name => args[args.indexOf(name) + 1];
  const channel = value('--channel'), content = value('--content');
  const endpoint = args.includes('--no-reply') || !args.includes('--endpoint') ? null : value('--endpoint');
  const delivered = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const db = await import(${JSON.stringify(new URL('../c4-db.js', import.meta.url).href)});
    const {createStore} = await import(${JSON.stringify(new URL('../c4-v2-store.js', import.meta.url).href)});
    const store = createStore(db.getDb(), {validateComponent:()=>true});
    const row = store.insertConversation('in', ${JSON.stringify(channel)}, ${JSON.stringify(endpoint)}, ${JSON.stringify(content)}, {});
    store.claimConversation(row.id); store.markDelivered(row.id, {sessionId:'fixture'});
    db.close();
  `], { env: { ...process.env, ...env }, encoding: 'utf8' });
  assert.equal(delivered.status, 0, delivered.stderr);
  return delivered;
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
      assert.ok(stdout.includes('read-work-memory.js'));
      assert.ok(stdout.includes('handoff.md'));
      assert.ok(!stdout.includes('ACTION REQUIRED'));
    });
  });

  it('loads delivered tail after coverage without checkpoint summary', () => {
    withTmpDir(({ env }) => {
      receive(['--channel', 'system', '--no-reply', '--content', 'msg1'], env);
      checkpoint(['create', '1', '--summary', 'Synced first batch'], env);
      receive(['--channel', 'system', '--no-reply', '--content', 'msg2'], env);

      const { stdout, status } = cli([], env);
      assert.equal(status, 0);
      assert.ok(!stdout.includes('CHECKPOINT SUMMARY'));
      assert.ok(!stdout.includes('Synced first batch'));
      assert.ok(stdout.includes('msg2'));
    });
  });

  it('does not inject an empty checkpoint fallback', () => {
    withTmpDir(({ env }) => {
      receive(['--channel', 'system', '--no-reply', '--content', 'msg1'], env);
      // Checkpoint created without --summary → summary is null.
      checkpoint(['create', '1'], env);
      receive(['--channel', 'system', '--no-reply', '--content', 'msg2'], env);

      const { stdout, status } = cli([], env);
      assert.equal(status, 0);
      assert.ok(!stdout.includes('=== LAST CHECKPOINT ==='));
      assert.ok(!stdout.includes('no summary'));
      assert.ok(!stdout.includes('=== LAST CHECKPOINT SUMMARY ==='));
    });
  });

  it('shows recent conversations when under threshold', () => {
    withTmpDir(({ env }) => {
      for (let i = 1; i <= 3; i++) {
        receive(['--channel', 'system', '--no-reply', '--content', `msg${i}`], env);
      }

      const { stdout, status } = cli([], env);
      assert.equal(status, 0);
      assert.ok(stdout.includes('=== RECENT CONVERSATIONS ==='));
      assert.ok(stdout.includes('=== END RECENT CONVERSATIONS ==='));
      assert.ok(stdout.includes('msg1'));
      assert.ok(stdout.includes('msg2'));
      assert.ok(stdout.includes('msg3'));
      // Should NOT trigger Memory Sync instruction
      assert.ok(!stdout.includes('ACTION REQUIRED'));
    });
  });

  it('adds reply routing for inbound endpoint messages', () => {
    withTmpDir(({ tmpDir, env }) => {
      fs.mkdirSync(path.join(tmpDir, '.claude', 'skills', 'telegram'), { recursive: true });
      receive(['--channel', 'telegram', '--endpoint', '123', '--content', 'hello'], env);

      const { stdout, status } = cli([], env);
      assert.equal(status, 0);
      assert.ok(stdout.includes('hello ---- reply via: node'));
      assert.ok(stdout.includes('"telegram" "123"'));
    });
  });

  it('does not add reply routing for no-reply messages', () => {
    withTmpDir(({ env }) => {
      receive(['--channel', 'system', '--no-reply', '--content', 'system note'], env);

      const { stdout, status } = cli([], env);
      assert.equal(status, 0);
      assert.ok(stdout.includes('system note'));
      assert.ok(!stdout.includes('reply via:'));
    });
  });

  it('does not add reply routing for no-reply messages even when endpoint was provided', () => {
    withTmpDir(({ tmpDir, env }) => {
      fs.mkdirSync(path.join(tmpDir, '.claude', 'skills', 'telegram'), { recursive: true });
      receive(['--channel', 'telegram', '--endpoint', '123', '--no-reply', '--content', 'no callback'], env);

      const { stdout, status } = cli([], env);
      assert.equal(status, 0);
      assert.ok(stdout.includes('no callback'));
      assert.ok(!stdout.includes('reply via:'));
    });
  });

  it('does not duplicate legacy stored reply routing', () => {
    withTmpDir(({ tmpDir, env }) => {
      fs.mkdirSync(path.join(tmpDir, '.claude', 'skills', 'telegram'), { recursive: true });
      receive([
        '--channel', 'telegram',
        '--endpoint', '123',
        '--content', 'legacy ---- reply via: node /tmp/c4-send.js "telegram" "123"'
      ], env);

      const { stdout, status } = cli([], env);
      assert.equal(status, 0);
      assert.equal((stdout.match(/reply via:/g) || []).length, 1);
    });
  });

  it('limits the delivered tail to six without triggering Memory Sync', () => {
    withTmpDir(({ env }) => {
      // CHECKPOINT_THRESHOLD is 15; insert 31 messages (well over threshold)
      for (let i = 1; i <= 31; i++) {
        receive(['--channel', 'system', '--no-reply', '--content', `msg${i}`], env);
      }

      const { stdout, status } = cli([], env);
      assert.equal(status, 0);
      assert.ok(!stdout.includes('=== ACTION REQUIRED ==='));
      assert.ok(stdout.includes('read-work-memory.js'));
      // Should show limited conversations (SESSION_INIT_RECENT_COUNT = 6)
      assert.ok(stdout.includes('msg31'));
      assert.ok(stdout.includes('msg26'));
      // msg1 should NOT be included (limited to recent)
      assert.ok(!stdout.match(/IN \(system\):\nmsg1\n/));
    });
  });
});
