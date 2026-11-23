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
  it('refuses origin sending into another component before delivery or recording', () => {
    withTmpDir(({ tmpDir, env }) => {
      const sentFile = setupMockChannel(tmpDir, 'mock-channel');
      const result = cli(['mock-channel', 'endpoint1', 'Hello!'], { ...env, ZYLOS_SESSION_GROUP: 'origin' });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /CROSS_SESSION_OUTBOUND/);
      assert.equal(fs.existsSync(sentFile), false);
      assert.deepEqual(dbRecent(env), []);
    });
  });
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

});

// -- validation --

// -- void channel (#689) --

// -- failed channel --

describe('c4-send failed channel', () => {

  it('reports failure when channel script exits non-zero', () => {
    withTmpDir(({ tmpDir, env }) => {
      const skillDir = path.join(tmpDir, '.claude', 'skills', 'bad-channel', 'scripts');
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'send.js'), 'process.exit(1);');

      const { stdout, status } = cli(['bad-channel', '--stdin'], env, 'Hello');
      assert.equal(status, 1);
      assert.ok(stdout.includes('Failed to send'));
    });
  });
});
