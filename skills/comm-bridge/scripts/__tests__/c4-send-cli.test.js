import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI_PATH = fileURLToPath(new URL('../c4-send.js', import.meta.url));
const DB_CLI_PATH = fileURLToPath(new URL('../c4-db.js', import.meta.url));

function cli(args, env = {}, input = undefined) {
  const result = spawnSync('node', [CLI_PATH, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 5000,
    ...(input !== undefined ? { input } : {})
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

function dbRecent(env, limit = 10) {
  const result = spawnSync('node', [DB_CLI_PATH, 'recent', String(limit)], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 5000
  });
  // Skip the "[C4-DB] Database initialized" banner printed on first open.
  const json = result.stdout.split('\n').filter((line) => !line.startsWith('[C4-DB]')).join('\n');
  return JSON.parse(json);
}

function withTmpDir(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-send-cli-'));
  const env = { ZYLOS_DIR: tmpDir };
  try {
    return fn({ tmpDir, env });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Create a mock channel with a send.js script that writes args to a file
 * and exits 0.
 */
function setupMockChannel(tmpDir, channelName) {
  const skillDir = path.join(tmpDir, '.claude', 'skills', channelName, 'scripts');
  fs.mkdirSync(skillDir, { recursive: true });

  const sentFile = path.join(tmpDir, `${channelName}-sent.json`);
  // Mock send.js: writes received args to a file
  fs.writeFileSync(path.join(skillDir, 'send.js'), `
    import fs from 'fs';
    const args = process.argv.slice(2);
    fs.writeFileSync('${sentFile.replace(/'/g, "\\'")}', JSON.stringify(args));
    process.exit(0);
  `);

  return sentFile;
}

// -- basic send --

describe('c4-send basic', () => {
  it('sends message via mock channel with endpoint', () => {
    withTmpDir(({ tmpDir, env }) => {
      const sentFile = setupMockChannel(tmpDir, 'mock-channel');

      const { stdout, status } = cli(['mock-channel', 'endpoint1', 'Hello!'], env);
      assert.equal(status, 0);
      assert.ok(stdout.includes('Message sent via mock-channel'));

      const sent = JSON.parse(fs.readFileSync(sentFile, 'utf8'));
      assert.deepEqual(sent, ['endpoint1', 'Hello!']);
    });
  });

  it('sends message via mock channel without endpoint (broadcast)', () => {
    withTmpDir(({ tmpDir, env }) => {
      const sentFile = setupMockChannel(tmpDir, 'mock-channel');

      const { stdout, status } = cli(['mock-channel', 'Hello broadcast!'], env);
      assert.equal(status, 0);
      assert.ok(stdout.includes('Message sent via mock-channel'));

      const sent = JSON.parse(fs.readFileSync(sentFile, 'utf8'));
      assert.deepEqual(sent, ['Hello broadcast!']);
    });
  });
});

// -- validation --

describe('c4-send validation', () => {
  it('errors with no arguments', () => {
    withTmpDir(({ env }) => {
      const { stdout, status } = cli([], env);
      assert.equal(status, 1);
      assert.ok(stdout.includes('Usage'));
    });
  });

  it('errors with only channel (no message)', () => {
    withTmpDir(({ env }) => {
      const { stdout, status } = cli(['telegram'], env);
      assert.equal(status, 1);
      assert.ok(stdout.includes('Usage'));
    });
  });

  it('errors when channel script not found', () => {
    withTmpDir(({ tmpDir, env }) => {
      // Create the channel directory but no send.js
      const skillDir = path.join(tmpDir, '.claude', 'skills', 'fake-channel');
      fs.mkdirSync(skillDir, { recursive: true });

      const { stderr, status } = cli(['fake-channel', 'Hello'], env);
      assert.equal(status, 1);
      assert.ok(stderr.includes('Channel script not found'));
    });
  });
});

// -- void channel (#689) --

describe('c4-send void channel', () => {
  it('records the message in c4.db and exits 0 without a skill directory', () => {
    withTmpDir(({ env }) => {
      const { stdout, status } = cli(['void', 'session-handoff', 'handoff summary'], env);
      assert.equal(status, 0);
      assert.ok(stdout.includes('recorded on void channel'));
      assert.ok(!stdout.includes('Message sent via'));

      const rows = dbRecent(env);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].direction, 'out');
      assert.equal(rows[0].channel, 'void');
      assert.equal(rows[0].endpoint_id, 'session-handoff');
      assert.equal(rows[0].content, 'handoff summary');
      assert.equal(rows[0].status, 'delivered');
    });
  });

  it('does not spawn a channel send script even if one exists', () => {
    withTmpDir(({ tmpDir, env }) => {
      const sentFile = setupMockChannel(tmpDir, 'void');

      const { status } = cli(['void', 'session-handoff', 'handoff summary'], env);
      assert.equal(status, 0);
      assert.ok(!fs.existsSync(sentFile), 'void must never dispatch to a send script');
    });
  });

  it('supports stdin/heredoc message input', () => {
    withTmpDir(({ env }) => {
      const message = 'multi-line handoff\nwith "quotes" and $vars';
      const { stdout, status } = cli(['void', 'session-handoff'], env, message);
      assert.equal(status, 0);
      assert.ok(stdout.includes('recorded on void channel'));

      const rows = dbRecent(env);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].channel, 'void');
      assert.equal(rows[0].content, message);
    });
  });

  it('rejects a void send without an endpoint', () => {
    withTmpDir(({ env }) => {
      // --stdin with a single arg is the only reachable no-endpoint form
      const { stderr, status } = cli(['void', '--stdin'], env, 'orphan message');
      assert.equal(status, 1);
      assert.ok(stderr.includes('Endpoint is required for the void channel'));

      const rows = dbRecent(env);
      assert.equal(rows.length, 0);
    });
  });
});

// -- failed channel --

describe('c4-send failed channel', () => {
  it('reports failure when channel script exits non-zero', () => {
    withTmpDir(({ tmpDir, env }) => {
      const skillDir = path.join(tmpDir, '.claude', 'skills', 'bad-channel', 'scripts');
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'send.js'), 'process.exit(1);');

      const { stdout, status } = cli(['bad-channel', 'Hello'], env);
      assert.equal(status, 1);
      assert.ok(stdout.includes('Failed to send'));
    });
  });
});
