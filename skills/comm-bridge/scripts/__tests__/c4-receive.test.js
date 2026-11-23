import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { describe, it, after } from 'node:test';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { isolatedTmux, tmuxClientEnv } from '../../../../test/helpers/isolated-tmux.js';

const tmuxEnvironment = tmuxClientEnv(isolatedTmux({ after }));
function writeRuntimeHealth(root, health) {
  fs.mkdirSync(path.join(root, '.zylos'), { recursive: true });
  fs.writeFileSync(path.join(root, '.zylos', 'config.json'), JSON.stringify({ runtime: 'claude', session_mode: 'single' }));
  const dir = path.join(root, 'activity-monitor', 'runtime-health'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'claude.json'), JSON.stringify({ v: 1, runtime: 'claude', health,
    reason: health === 'ok' ? '' : 'unavailable', updatedAt: 1, hook: {}, unavailableSince: 0, cooldownUntil: 0,
    recoveringStartedAt: 0, lastUserMessageRecoveryAt: 0, restartFailureCount: 0, lastRecoveryAt: 0,
    lastDownCheckAt: 0, rateLimitResetTime: '' }));
}

const CLI_PATH = fileURLToPath(new URL('../c4-receive.js', import.meta.url));

function cliRaw(args, env = {}) {
  const result = spawnSync('node', [CLI_PATH, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

function cliRawAsync(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [CLI_PATH, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', status => resolve({ stdout, stderr, status }));
  });
}

function withTmpDir(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-receive-'));
  fs.mkdirSync(path.join(tmpDir, 'activity-monitor'), { recursive: true });
  const env = { ...tmuxEnvironment, ZYLOS_DIR: tmpDir };
  try {
    return fn({ tmpDir, env });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function withTmpDirAsync(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-receive-'));
  fs.mkdirSync(path.join(tmpDir, 'activity-monitor'), { recursive: true });
  const env = { ...tmuxEnvironment, ZYLOS_DIR: tmpDir };
  try {
    return await fn({ tmpDir, env });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function openDb(tmpDir) {
  return new Database(path.join(tmpDir, 'comm-bridge', 'c4.db'));
}

function createChannelSendScript(tmpDir, channel, { exitCode = 0 } = {}) {
  const scriptDir = path.join(tmpDir, '.claude', 'skills', channel, 'scripts');
  fs.mkdirSync(scriptDir, { recursive: true });
  fs.writeFileSync(path.join(scriptDir, 'send.js'), `
import fs from 'node:fs';
import path from 'node:path';
const outPath = path.join(process.env.ZYLOS_DIR, '${channel}-send.json');
fs.writeFileSync(outPath, JSON.stringify({ args: process.argv.slice(2) }));
process.exit(${exitCode});
`);
}

async function withRouteServer(tmpDir, handler, fn) {
  const socketPath = path.join(tmpDir, 'activity-monitor', 'am.sock');
  await fs.promises.rm(socketPath, { force: true });
  const server = net.createServer((socket) => {
    let data = '';
    socket.on('data', (chunk) => {
      data += chunk;
      if (!data.includes('\n')) return;
      const request = JSON.parse(data.slice(0, data.indexOf('\n')));
      const response = handler(request);
      socket.write(`${JSON.stringify(response)}\n`);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  try {
    return await fn();
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.promises.rm(socketPath, { force: true });
  }
}

/**
 * Parse JSON from the CLI stdout. The DB init log line ("[C4-DB] Database initialized")
 * may precede the JSON line, so we find the last line that starts with '{'.
 */
function parseJsonStdout(stdout) {
  const lines = stdout.trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith('{')) {
      return JSON.parse(lines[i]);
    }
  }
  throw new Error(`No JSON found in stdout: ${stdout}`);
}

// ---------------------------------------------------------------------------
// basic intake
// ---------------------------------------------------------------------------
describe('c4-receive basic intake', () => {

  it('inserts a record into the conversations table', () => {
    withTmpDir(({ tmpDir, env }) => {
      const r = cliRaw(['--no-reply', '--json', '--content', 'db check'], env);
      assert.equal(r.status, 0);
      const out = parseJsonStdout(r.stdout);

      const db = openDb(tmpDir);
      const row = db.prepare('SELECT * FROM conversations WHERE id = ?').get(Number(out.id));
      db.close();

      assert.ok(row, 'row should exist in DB');
      assert.equal(row.direction, 'in');
      assert.equal(row.status, 'pending');
      assert.equal(row.priority, 3);
      assert.ok(row.content.includes('db check'));
    });
  });

  it('stores long inbound content in full without writing an attachment preview', () => {
    withTmpDir(({ tmpDir, env }) => {
      fs.mkdirSync(path.join(tmpDir, '.claude', 'skills', 'test-channel'), { recursive: true });
      const longContent = 'x'.repeat(3000);
      const r = cliRaw(['--channel', 'test-channel', '--endpoint', 'ep1', '--json', '--content', longContent], env);
      assert.equal(r.status, 0);
      const out = parseJsonStdout(r.stdout);

      const db = openDb(tmpDir);
      const row = db.prepare('SELECT content FROM conversations WHERE id = ?').get(Number(out.id));
      db.close();

      assert.equal(row.content, longContent);
      assert.ok(!row.content.includes('[C4] ⚠️ TRUNCATED'));
      assert.equal(fs.existsSync(path.join(tmpDir, 'comm-bridge', 'attachments')), false);
    });
  });

});

// ---------------------------------------------------------------------------
// --no-reply
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// health gating (--json)
// ---------------------------------------------------------------------------
describe('c4-receive health gating', () => {

  it('fallback records rejected no-reply unhealthy messages failed without error', () => {
    withTmpDir(({ tmpDir, env }) => {
      writeRuntimeHealth(tmpDir, 'recovering');

      const r = cliRaw(['--no-reply', '--json', '--content', 'recovering msg'], env);
      assert.equal(r.status, 0);
      const out = parseJsonStdout(r.stdout);
      assert.equal(out.ok, true);
      assert.equal(out.action, 'delivered');

      const db = openDb(tmpDir);
      const row = db.prepare('SELECT status, content FROM conversations WHERE id = ?').get(Number(out.id));
      db.close();

      assert.equal(row.status, 'failed');
      assert.ok(row.content.includes('recovering msg'));
    });
  });

});

describe('c4-receive MessageRouter IPC route', () => {
  it('queues pending when router returns recovered=true', async () => {
    await withTmpDirAsync(async ({ tmpDir, env }) => {
      createChannelSendScript(tmpDir, 'test-chan');
      await withRouteServer(tmpDir, (request) => ({
        version: 2, type: 'route', runtime: 'claude', reason: 'ok', transitionHold: false, decision: 'pending',
        requestId: request.requestId,
        recovered: true,
        health: 'ok'
      }), async () => {
        const r = await cliRawAsync(['--channel', 'test-chan', '--endpoint', 'ep1', '--json', '--content', 'ok msg'], env);
        assert.equal(r.status, 0);
        const out = parseJsonStdout(r.stdout);
        assert.equal(out.action, 'queued');

        const db = openDb(tmpDir);
        const row = db.prepare('SELECT status, content FROM conversations WHERE id = ?').get(Number(out.id));
        db.close();
        assert.equal(row.status, 'pending');
        assert.equal(row.content, 'ok msg');
        assert.ok(!row.content.includes('reply via'));
      });
    });
  });

});

// ---------------------------------------------------------------------------
// fail-open
// ---------------------------------------------------------------------------
describe('c4-receive fail-open', () => {
  it('passes when status file is missing', () => {
    withTmpDir(({ env }) => {
      const r = cliRaw(['--no-reply', '--json', '--content', 'no status file'], env);
      assert.equal(r.status, 0);
      const out = parseJsonStdout(r.stdout);
      assert.equal(out.ok, true);
    });
  });

});

// ---------------------------------------------------------------------------
// Option manifest and forward-compatible unknown options
// ---------------------------------------------------------------------------
function ignoredOptions(stderr) {
  return stderr.split('\n').filter(line => line.startsWith('Ignored unknown option:'));
}

describe('c4-receive option manifest', () => {
  // Boundary: every declared option must have its real CLI effect, including
  // value consumption, both idle aliases, session groups and output mode. Run
  // for receiver or manifest changes; unrelated channel implementations may skip.
  const samples = {
    '--channel': { value: 'selected-channel', field: 'channel', expected: 'selected-channel' },
    '--endpoint': { value: 'selected-endpoint', field: 'endpoint_id', expected: 'selected-endpoint' },
    '--priority': { value: '2', field: 'priority', expected: 2 },
    '--no-reply': { field: 'channel', expected: 'system' },
    '--require-idle': { field: 'require_idle', expected: 1 },
    '--block-queue-until-idle': { field: 'require_idle', expected: 1 },
    '--json': {},
    '--content': { value: '--literal-content', field: 'content', expected: '--literal-content' },
    '--session-group': { value: 'team', field: 'session_group', expected: 'manifest-channel:team' },
    '--core-source': { value: 'scheduler', field: 'status', expected: 'pending' },
  };
  const manifest = JSON.parse(fs.readFileSync(new URL('../c4-receive-options.json', import.meta.url), 'utf8'));
  for (const name of Object.keys(manifest.options)) {
    it(`applies declared option ${name} through the real receiver`, () => {
      withTmpDir(({ tmpDir, env }) => {
        const sample = samples[name];
        assert.ok(sample, `add an observable CLI assertion for ${name}`);
        for (const channel of ['manifest-channel', 'selected-channel']) {
          fs.mkdirSync(path.join(tmpDir, '.claude', 'skills', channel), { recursive: true });
        }
        const args = [name];
        if (Object.hasOwn(sample, 'value')) args.push(sample.value);
        if (name !== '--channel' && name !== '--no-reply') args.push('--channel', 'manifest-channel');
        if (name !== '--content') args.push('--content', 'manifest content');
        const result = cliRaw(args, env);
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(ignoredOptions(result.stderr), []);
        if (name === '--json') {
          const output = parseJsonStdout(result.stdout);
          assert.equal(output.ok, true);
          assert.equal(output.action, 'queued');
          assert.equal(typeof output.id, 'number');
        } else {
          assert.match(result.stdout, /^\[C4\] Message queued \(id=\d+, action=queued\)\n$/);
        }
        const db = openDb(tmpDir);
        try {
          const rows = db.prepare('SELECT * FROM conversations').all();
          assert.equal(rows.length, 1);
          assert.equal(rows[0].status, 'pending');
          if (sample.field) assert.equal(rows[0][sample.field], sample.expected);
          if (name === '--no-reply') assert.equal(rows[0].endpoint_id, null);
        } finally { db.close(); }
      });
    });
  }

});

describe('c4-receive unknown option compatibility', () => {
  // Boundary: forward component arguments must not change persisted intake.
  // Run when receive parsing/storage changes; skip for unrelated send/dispatcher changes.
  it('stores the same stable fields with and without an unknown option', () => {
    withTmpDir(({ tmpDir, env }) => {
      fs.mkdirSync(path.join(tmpDir, '.claude', 'skills', 'test-channel'), { recursive: true });
      const args = ['--channel', 'test-channel', '--endpoint', 'compat-ep', '--priority', '2',
        '--require-idle', '--json', '--content', 'same inbound content'];
      const baseline = cliRaw(args, env);
      const forwarded = cliRaw(['--future-group', 'team', ...args], env);
      assert.equal(baseline.status, 0, baseline.stderr);
      assert.equal(forwarded.status, 0, forwarded.stderr);
      const first = parseJsonStdout(baseline.stdout);
      const second = parseJsonStdout(forwarded.stdout);
      assert.equal(first.ok, true);
      assert.equal(second.ok, true);
      assert.deepEqual(ignoredOptions(baseline.stderr), []);
      assert.deepEqual(ignoredOptions(forwarded.stderr), ['Ignored unknown option: --future-group']);
      const db = openDb(tmpDir);
      try {
        const rows = [first, second].map(({ id }) => db.prepare('SELECT * FROM conversations WHERE id = ?').get(id));
        assert.ok(rows.every(Boolean));
        const stable = rows.map(({ id, timestamp, ...fields }) => fields);
        assert.deepEqual(stable[1], stable[0]);
        assert.equal(stable[1].content, 'same inbound content');
        assert.equal(stable[1].endpoint_id, 'compat-ep');
        assert.equal(stable[1].require_idle, 1);
        assert.equal(stable[1].priority, 2);
        assert.equal(stable[1].session_group, 'test-channel');
      } finally {
        db.close();
      }
    });
  });

});
