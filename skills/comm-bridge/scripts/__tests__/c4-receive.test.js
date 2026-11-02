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

function readCooldownRows(tmpDir) {
  const db = openDb(tmpDir);
  const rows = db.prepare(`
    SELECT cooldown_key, channel, endpoint, status_type, reason, last_notified_at, expires_at
    FROM status_notice_cooldowns
    ORDER BY cooldown_key ASC
  `).all();
  db.close();
  return rows;
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

function createBlockingAppendChannelSendScript(tmpDir, channel) {
  const scriptDir = path.join(tmpDir, '.claude', 'skills', channel, 'scripts');
  fs.mkdirSync(scriptDir, { recursive: true });
  fs.writeFileSync(path.join(scriptDir, 'send.js'), `
import fs from 'node:fs';
import path from 'node:path';
const outPath = path.join(process.env.ZYLOS_DIR, '${channel}-send.jsonl');
const startedPath = path.join(process.env.ZYLOS_DIR, '${channel}-send-started');
const releasePath = path.join(process.env.ZYLOS_DIR, '${channel}-send-release');
fs.writeFileSync(startedPath, String(process.pid));
const deadline = Date.now() + 5000;
while (!fs.existsSync(releasePath) && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 25));
}
if (!fs.existsSync(releasePath)) process.exit(9);
fs.appendFileSync(outPath, JSON.stringify({ args: process.argv.slice(2), pid: process.pid }) + '\\n');
`);
}

async function waitForFile(filePath, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${filePath}`);
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
  it('queues a message with --no-reply and --content', () => {
    withTmpDir(({ env }) => {
      const r = cliRaw(['--no-reply', '--content', 'hello world'], env);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /queued/);
    });
  });

  it('--json outputs { ok: true }', () => {
    withTmpDir(({ env }) => {
      const r = cliRaw(['--no-reply', '--json', '--content', 'hello json'], env);
      assert.equal(r.status, 0);
      const out = parseJsonStdout(r.stdout);
      assert.equal(out.ok, true);
      assert.equal(out.action, 'queued');
      assert.equal(typeof out.id, 'number');
    });
  });

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

  it('queues with a real channel when skill dir exists', () => {
    withTmpDir(({ tmpDir, env }) => {
      fs.mkdirSync(path.join(tmpDir, '.claude', 'skills', 'test-channel'), { recursive: true });
      const r = cliRaw(['--channel', 'test-channel', '--json', '--content', 'chan msg'], env);
      assert.equal(r.status, 0);
      const out = parseJsonStdout(r.stdout);
      assert.equal(out.ok, true);

      const db = openDb(tmpDir);
      const row = db.prepare('SELECT * FROM conversations WHERE id = ?').get(Number(out.id));
      db.close();
      assert.equal(row.channel, 'test-channel');
      assert.equal(row.content, 'chan msg');
      assert.ok(!row.content.includes('reply via'), 'stored content should not contain reply via suffix');
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

  it('accepts --block-queue-until-idle', () => {
    withTmpDir(({ tmpDir, env }) => {
      const r = cliRaw(['--no-reply', '--json', '--block-queue-until-idle', '--content', 'idle flag'], env);
      assert.equal(r.status, 0);
      const out = parseJsonStdout(r.stdout);

      const db = openDb(tmpDir);
      const row = db.prepare('SELECT require_idle FROM conversations WHERE id = ?').get(Number(out.id));
      db.close();

      assert.equal(row.require_idle, 1);
    });
  });

  it('still accepts legacy --require-idle', () => {
    withTmpDir(({ tmpDir, env }) => {
      const r = cliRaw(['--no-reply', '--json', '--require-idle', '--content', 'legacy idle flag'], env);
      assert.equal(r.status, 0);
      const out = parseJsonStdout(r.stdout);

      const db = openDb(tmpDir);
      const row = db.prepare('SELECT require_idle FROM conversations WHERE id = ?').get(Number(out.id));
      db.close();

      assert.equal(row.require_idle, 1);
    });
  });
});

// ---------------------------------------------------------------------------
// --no-reply
// ---------------------------------------------------------------------------
describe('c4-receive --no-reply', () => {
  it('auto-assigns system channel when --channel is omitted', () => {
    withTmpDir(({ tmpDir, env }) => {
      const r = cliRaw(['--no-reply', '--json', '--content', 'sys msg'], env);
      assert.equal(r.status, 0);
      const out = parseJsonStdout(r.stdout);

      const db = openDb(tmpDir);
      const row = db.prepare('SELECT * FROM conversations WHERE id = ?').get(Number(out.id));
      db.close();
      assert.equal(row.channel, 'system');
    });
  });

  it('content does not contain "reply via" suffix', () => {
    withTmpDir(({ tmpDir, env }) => {
      const r = cliRaw(['--no-reply', '--json', '--content', 'no suffix'], env);
      assert.equal(r.status, 0);
      const out = parseJsonStdout(r.stdout);

      const db = openDb(tmpDir);
      const row = db.prepare('SELECT * FROM conversations WHERE id = ?').get(Number(out.id));
      db.close();
      assert.ok(!row.content.includes('reply via'), 'should not contain reply via suffix');
    });
  });

  it('does not store endpoint when --no-reply is set', () => {
    withTmpDir(({ tmpDir, env }) => {
      fs.mkdirSync(path.join(tmpDir, '.claude', 'skills', 'test-channel'), { recursive: true });
      const r = cliRaw([
        '--channel', 'test-channel',
        '--endpoint', 'ep1',
        '--no-reply',
        '--json',
        '--content', 'no target'
      ], env);
      assert.equal(r.status, 0);
      const out = parseJsonStdout(r.stdout);

      const db = openDb(tmpDir);
      const row = db.prepare('SELECT endpoint_id, content FROM conversations WHERE id = ?').get(Number(out.id));
      db.close();

      assert.equal(row.endpoint_id, null);
      assert.equal(row.content, 'no target');
    });
  });
});

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------
describe('c4-receive validation', () => {
  it('errors when --channel is missing and --no-reply is not set', () => {
    withTmpDir(({ env }) => {
      const r = cliRaw(['--json', '--content', 'fail'], env);
      assert.equal(r.status, 1);
      const out = parseJsonStdout(r.stdout);
      assert.equal(out.ok, false);
      assert.equal(out.error.code, 'INVALID_ARGS');
    });
  });

  it('errors when --content is missing', () => {
    withTmpDir(({ env }) => {
      const r = cliRaw(['--no-reply', '--json'], env);
      assert.equal(r.status, 1);
      const out = parseJsonStdout(r.stdout);
      assert.equal(out.ok, false);
      assert.equal(out.error.code, 'INVALID_ARGS');
    });
  });

  it('errors on invalid --priority', () => {
    withTmpDir(({ env }) => {
      const r = cliRaw(['--no-reply', '--json', '--priority', '5', '--content', 'x'], env);
      assert.equal(r.status, 1);
      const out = parseJsonStdout(r.stdout);
      assert.equal(out.ok, false);
      assert.equal(out.error.code, 'INVALID_ARGS');
      assert.match(out.error.message, /priority/i);
    });
  });

  it('errors when channel skill directory does not exist', () => {
    withTmpDir(({ env }) => {
      const r = cliRaw(['--channel', 'nonexistent', '--json', '--content', 'x'], env);
      assert.equal(r.status, 1);
      const out = parseJsonStdout(r.stdout);
      assert.equal(out.ok, false);
      assert.equal(out.error.code, 'INVALID_ARGS');
      assert.match(out.error.message, /channel/i);
    });
  });
});

// ---------------------------------------------------------------------------
// health gating (--json)
// ---------------------------------------------------------------------------
describe('c4-receive health gating', () => {
  it('passes when health is ok', () => {
    withTmpDir(({ tmpDir, env }) => {
      const dataDir = path.join(tmpDir, 'comm-bridge');
      fs.mkdirSync(dataDir, { recursive: true });
      writeRuntimeHealth(tmpDir, 'ok');

      const r = cliRaw(['--no-reply', '--json', '--content', 'healthy msg'], env);
      assert.equal(r.status, 0);
      const out = parseJsonStdout(r.stdout);
      assert.equal(out.ok, true);
    });
  });

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

  it('fallback normalizes legacy unhealthy status and exits zero', () => {
    withTmpDir(({ tmpDir, env }) => {
      writeRuntimeHealth(tmpDir, 'down');
      createChannelSendScript(tmpDir, 'test-chan');

      const r = cliRaw(['--channel', 'test-chan', '--endpoint', 'ep1', '--json', '--content', 'down msg'], env);
      assert.equal(r.status, 0);
      const out = parseJsonStdout(r.stdout);
      assert.equal(out.ok, true);
      assert.equal(out.action, 'delivered');

      const sent = JSON.parse(fs.readFileSync(path.join(tmpDir, 'test-chan-send.json'), 'utf8'));
      assert.equal(sent.args[0], 'ep1');
      assert.match(sent.args[1], /当前服务暂时不可用/);

      const db = openDb(tmpDir);
      const inbound = db.prepare("SELECT status, content FROM conversations WHERE direction = 'in'").get();
      const outbound = db.prepare("SELECT status, content FROM conversations WHERE direction = 'out'").get();
      db.close();

      assert.equal(inbound.status, 'failed');
      assert.ok(inbound.content.includes('down msg'));
      assert.ok(!inbound.content.includes('reply via'));
      assert.ok(outbound.content.includes('当前服务暂时不可用'));
    });
  });

  it('returns an error if unhealthy status delivery fails', () => {
    withTmpDir(({ tmpDir, env }) => {
      writeRuntimeHealth(tmpDir, 'down');
      createChannelSendScript(tmpDir, 'test-chan', { exitCode: 7 });

      const r = cliRaw(['--channel', 'test-chan', '--endpoint', 'ep1', '--json', '--content', 'down msg'], env);
      assert.equal(r.status, 1);
      const out = parseJsonStdout(r.stdout);
      assert.equal(out.ok, false);
      assert.equal(out.error.code, 'UNHEALTHY_NOTIFY_UNCERTAIN');
    });
  });

  it('does not write pending-channels.jsonl on fallback unhealthy route', () => {
    withTmpDir(({ tmpDir, env }) => {
      writeRuntimeHealth(tmpDir, 'down');
      createChannelSendScript(tmpDir, 'test-chan');

      cliRaw(['--channel', 'test-chan', '--endpoint', 'ep1', '--json', '--content', 'x'], env);
      const pendingPath = path.join(tmpDir, 'activity-monitor', 'pending-channels.jsonl');
      assert.equal(fs.existsSync(pendingPath), false);
    });
  });

  it('fallback suppresses repeated status notices by normalized endpoint and public health', () => {
    withTmpDir(({ tmpDir, env }) => {
      writeRuntimeHealth(tmpDir, 'down');
      createChannelSendScript(tmpDir, 'test-chan');

      const first = cliRaw([
        '--channel', 'test-chan',
        '--endpoint', 'oc_123|type:group|root:om_root|parent:om_a|msg:om_a',
        '--json',
        '--content', 'first'
      ], env);
      assert.equal(first.status, 0);
      assert.equal(parseJsonStdout(first.stdout).action, 'delivered');

      const second = cliRaw([
        '--channel', 'test-chan',
        '--endpoint', 'oc_123|type:group|root:om_root|parent:om_b|msg:om_b',
        '--json',
        '--content', 'second'
      ], env);
      assert.equal(second.status, 0);
      const out = parseJsonStdout(second.stdout);
      assert.equal(out.action, 'suppressed');

      const entries = readCooldownRows(tmpDir);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].endpoint, 'oc_123|root:om_root|type:group');
      assert.equal(entries[0].status_type, 'unavailable');
      assert.equal(entries[0].reason, 'runtime_unavailable');
      assert.equal(fs.existsSync(path.join(tmpDir, 'activity-monitor', 'status-notice-cooldowns.json')), false);

      const db = openDb(tmpDir);
      const inboundCount = db.prepare("SELECT count(*) AS count FROM conversations WHERE direction = 'in'").get();
      const outboundCount = db.prepare("SELECT count(*) AS count FROM conversations WHERE direction = 'out'").get();
      const suppressed = db.prepare("SELECT content, delivery_action FROM conversations WHERE id = ?").get(Number(out.id));
      db.close();

      assert.equal(inboundCount.count, 2);
      assert.equal(outboundCount.count, 1);
      assert.match(suppressed.content, /Status notification suppressed by cooldown/);
      assert.equal(suppressed.delivery_action, 'suppressed');
    });
  });

  it('fallback reserves status notice cooldown before sending so concurrent receives suppress duplicates', async () => {
    await withTmpDirAsync(async ({ tmpDir, env }) => {
      writeRuntimeHealth(tmpDir, 'down');
      createBlockingAppendChannelSendScript(tmpDir, 'test-chan');

      const argsA = [
        '--channel', 'test-chan',
        '--endpoint', 'oc_123|type:group|root:om_root|parent:om_a|msg:om_a',
        '--json',
        '--content', 'first concurrent'
      ];
      const argsB = [
        '--channel', 'test-chan',
        '--endpoint', 'oc_123|type:group|root:om_root|parent:om_b|msg:om_b',
        '--json',
        '--content', 'second concurrent'
      ];

      const firstReceive = cliRawAsync(argsA, env);
      await waitForFile(path.join(tmpDir, 'test-chan-send-started'));
      const secondResult = await cliRawAsync(argsB, env);
      fs.writeFileSync(path.join(tmpDir, 'test-chan-send-release'), 'ok');
      const firstResult = await firstReceive;
      const results = [firstResult, secondResult];

      assert.deepEqual(results.map((r) => r.status), [0, 0]);
      const actions = results.map((r) => parseJsonStdout(r.stdout).action).sort();
      assert.deepEqual(actions, ['delivered', 'suppressed']);

      const sendLog = fs.readFileSync(path.join(tmpDir, 'test-chan-send.jsonl'), 'utf8').trim().split('\n');
      assert.equal(sendLog.length, 1);

      const db = openDb(tmpDir);
      const inboundCount = db.prepare("SELECT count(*) AS count FROM conversations WHERE direction = 'in'").get();
      const outboundCount = db.prepare("SELECT count(*) AS count FROM conversations WHERE direction = 'out'").get();
      const suppressedCount = db.prepare("SELECT count(*) AS count FROM conversations WHERE content LIKE '%Status notification suppressed by cooldown%'").get();
      const suppressedActionCount = db.prepare("SELECT count(*) AS count FROM conversations WHERE delivery_action = 'suppressed'").get();
      db.close();

      assert.equal(inboundCount.count, 2);
      assert.equal(outboundCount.count, 1);
      assert.equal(suppressedCount.count, 1);
      assert.equal(suppressedActionCount.count, 1);
    });
  });

  it('prunes expired status notice cooldown entries when recording a notification', () => {
    withTmpDir(({ tmpDir, env }) => {
      const now = Math.floor(Date.now() / 1000);
      const init = cliRaw(['--no-reply', '--json', '--content', 'init db'], env);
      assert.equal(init.status, 0);
      writeRuntimeHealth(tmpDir, 'down');
      createChannelSendScript(tmpDir, 'test-chan');
      const db = openDb(tmpDir);
      const insertCooldown = db.prepare(`
        INSERT INTO status_notice_cooldowns (
          cooldown_key, channel, endpoint, status_type, reason,
          last_notified_at, expires_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insertCooldown.run('old::ep::unavailable::old', 'old', 'ep', 'unavailable', 'old', now - 9999, now - 1, now - 9999);
      insertCooldown.run('recent::ep::unavailable::recent', 'recent', 'ep', 'unavailable', 'recent', now, now + 600, now);
      db.close();

      const r = cliRaw(['--channel', 'test-chan', '--endpoint', 'ep1', '--json', '--content', 'new notice'], env);
      assert.equal(r.status, 0);
      assert.equal(parseJsonStdout(r.stdout).action, 'delivered');

      const cooldowns = readCooldownRows(tmpDir);
      assert.equal(cooldowns.some((row) => row.cooldown_key === 'old::ep::unavailable::old'), false);
      assert.equal(cooldowns.some((row) => row.cooldown_key === 'recent::ep::unavailable::recent'), true);
      assert.equal(cooldowns.some((row) => row.channel === 'test-chan' && row.endpoint === 'ep1' && row.status_type === 'unavailable'), true);
      assert.equal(fs.existsSync(path.join(tmpDir, 'activity-monitor', 'status-notice-cooldowns.json')), false);
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

  it('uses router userMessage for unhealthy delivery', async () => {
    await withTmpDirAsync(async ({ tmpDir, env }) => {
      createChannelSendScript(tmpDir, 'test-chan');
      await withRouteServer(tmpDir, (request) => ({
        version: 2, type: 'route', runtime: 'claude', transitionHold: false,
        requestId: request.requestId,
        recovered: false,
        health: 'unavailable',
        reason: 'heartbeat_timeout',
        userMessage: 'router says unavailable'
      }), async () => {
        const r = await cliRawAsync(['--channel', 'test-chan', '--endpoint', 'ep1', '--json', '--content', 'blocked msg'], env);
        assert.equal(r.status, 0);
        const out = parseJsonStdout(r.stdout);
        assert.equal(out.action, 'delivered');

        const sent = JSON.parse(fs.readFileSync(path.join(tmpDir, 'test-chan-send.json'), 'utf8'));
        assert.equal(sent.args[1], 'router says unavailable');

        const db = openDb(tmpDir);
        const inbound = db.prepare("SELECT status, content FROM conversations WHERE direction = 'in'").get();
        db.close();
        assert.equal(inbound.status, 'failed');
        assert.ok(inbound.content.includes('blocked msg'));
      });
    });
  });

  it('suppresses repeated router unhealthy status notices', async () => {
    await withTmpDirAsync(async ({ tmpDir, env }) => {
      createChannelSendScript(tmpDir, 'test-chan');
      await withRouteServer(tmpDir, (request) => ({
        version: 2, type: 'route', runtime: 'claude', transitionHold: false,
        requestId: request.requestId,
        recovered: false,
        health: 'unavailable',
        reason: 'heartbeat_timeout',
        userMessage: 'router says unavailable'
      }), async () => {
        const first = await cliRawAsync([
          '--channel', 'test-chan',
          '--endpoint', 'oc_123|type:group|root:om_root|parent:om_a|msg:om_a',
          '--json',
          '--content', 'first'
        ], env);
        assert.equal(first.status, 0);
        assert.equal(parseJsonStdout(first.stdout).action, 'delivered');

        const second = await cliRawAsync([
          '--channel', 'test-chan',
          '--endpoint', 'oc_123|type:group|root:om_root|parent:om_b|msg:om_b',
          '--json',
          '--content', 'second'
        ], env);
        assert.equal(second.status, 0);
        const out = parseJsonStdout(second.stdout);
        assert.equal(out.action, 'suppressed');

        const entries = readCooldownRows(tmpDir);
        assert.equal(entries.length, 1);
        assert.equal(entries[0].endpoint, 'oc_123|root:om_root|type:group');
        assert.equal(entries[0].status_type, 'unavailable');
        assert.equal(entries[0].reason, 'heartbeat_timeout');

        const db = openDb(tmpDir);
        const outboundCount = db.prepare("SELECT count(*) AS count FROM conversations WHERE direction = 'out'").get();
        const suppressed = db.prepare("SELECT content, delivery_action FROM conversations WHERE id = ?").get(Number(out.id));
        db.close();

        assert.equal(outboundCount.count, 1);
        assert.match(suppressed.content, /Status notification suppressed by cooldown/);
        assert.equal(suppressed.delivery_action, 'suppressed');
      });
    });
  });

  it('accepts unhealthy no-reply router decisions without userMessage', async () => {
    await withTmpDirAsync(async ({ tmpDir, env }) => {
      await withRouteServer(tmpDir, (request) => ({
        version: 2, type: 'route', runtime: 'claude', transitionHold: false,
        requestId: request.requestId,
        recovered: false,
        health: 'unavailable',
        reason: 'heartbeat_timeout'
      }), async () => {
        const r = await cliRawAsync(['--no-reply', '--json', '--content', 'silent blocked msg'], env);
        assert.equal(r.status, 0);
        const out = parseJsonStdout(r.stdout);
        assert.equal(out.action, 'delivered');

        const db = openDb(tmpDir);
        const inbound = db.prepare("SELECT status, content FROM conversations WHERE direction = 'in'").get();
        const outboundCount = db.prepare("SELECT count(*) AS count FROM conversations WHERE direction = 'out'").get();
        db.close();
        assert.equal(inbound.status, 'failed');
        assert.equal(outboundCount.count, 0);
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

  it('passes when status file contains malformed JSON', () => {
    withTmpDir(({ tmpDir, env }) => {
      const dataDir = path.join(tmpDir, 'comm-bridge');
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'activity-monitor', 'agent-status.json'), '{broken');

      const r = cliRaw(['--no-reply', '--json', '--content', 'bad json'], env);
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

function cliAt(scriptPath, args, env) {
  const result = spawnSync('node', [scriptPath, ...args], { env: { ...process.env, ...env }, encoding: 'utf8' });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
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
  // Boundary: the manifest lists exactly the options this receiver handles;
  // a missing entry would silently turn a real option into an ignored one.
  it('declares every option the receiver handles', () => {
    assert.deepEqual(Object.keys(manifest.options).sort(), Object.keys(samples).sort());
  });
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

  // Boundary: a declared value option is parsed rather than ignored, so its
  // own validation still applies. Run for manifest or core-source changes.
  it('validates a declared --core-source value instead of ignoring it', () => {
    withTmpDir(({ tmpDir, env }) => {
      const r = cliRaw(['--no-reply', '--json', '--core-source', 'unknown-source', '--content', 'x'], env);
      assert.equal(r.status, 1);
      assert.deepEqual(ignoredOptions(r.stderr), []);
      const out = parseJsonStdout(r.stdout);
      assert.equal(out.error.code, 'INVALID_ARGS');
      assert.equal(out.error.message, 'Unknown --core-source');
      assert.equal(fs.existsSync(path.join(tmpDir, 'comm-bridge', 'c4.db')), false);
    });
  });

  // Boundary: an incomplete installation must fail before opening a message
  // database. Run for manifest loading/validation changes; unrelated routing
  // changes may skip. Only fixture JSON changes; runtime JavaScript is copied
  // unchanged.
  const invalidManifests = [
    { name: 'missing', data: undefined },
    { name: 'unreadable', data: '{}', unreadable: true },
    { name: 'invalid JSON', data: '{' },
    { name: 'null root', data: 'null' },
    { name: 'missing options', data: '{}' },
    { name: 'array options', data: '{"options":[]}' },
    { name: 'option name without double dash', data: '{"options":{"content":{"takesValue":true}}}' },
    { name: 'null option', data: '{"options":{"--content":null}}' },
    { name: 'missing takesValue', data: '{"options":{"--content":{}}}' },
    { name: 'non-boolean takesValue', data: '{"options":{"--content":{"takesValue":"true"}}}' },
  ];
  for (const fixture of invalidManifests) {
    for (const json of [false, true]) {
      it(`rejects ${fixture.name} manifest before database access (${json ? 'JSON' : 'plain'})`, () => {
        withTmpDir(({ tmpDir, env }) => {
          const skillDir = path.join(tmpDir, 'installation', 'comm-bridge');
          const scriptsDir = path.join(skillDir, 'scripts');
          fs.cpSync(path.dirname(CLI_PATH), scriptsDir, {
            recursive: true,
            filter: (source) => path.basename(source) !== '__tests__' && path.basename(source) !== 'c4-receive-options.json',
          });
          fs.symlinkSync(fileURLToPath(new URL('../../node_modules', import.meta.url)), path.join(skillDir, 'node_modules'), 'dir');
          const manifestPath = path.join(scriptsDir, 'c4-receive-options.json');
          if (fixture.data !== undefined) fs.writeFileSync(manifestPath, fixture.data);
          if (fixture.unreadable) fs.chmodSync(manifestPath, 0o000);
          try {
            // The copied skill must resolve this checkout's Core, never an installed one.
            const result = cliAt(path.join(scriptsDir, 'c4-receive.js'),
              ['--no-reply', '--content', 'must not queue', ...(json ? ['--json'] : [])],
              { ...env, ZYLOS_PACKAGE_ROOT: fileURLToPath(new URL('../../../../', import.meta.url)) });
            assert.equal(result.status, 1);
            if (json) {
              const output = parseJsonStdout(result.stdout);
              assert.equal(output.ok, false);
              assert.equal(output.error.code, 'INTERNAL_ERROR');
              assert.match(output.error.message, /^failed to load c4-receive options:/);
            } else {
              assert.equal(result.stdout, '');
              assert.match(result.stderr, /Error \[INTERNAL_ERROR\]: failed to load c4-receive options:/);
            }
            assert.equal(fs.existsSync(path.join(tmpDir, 'comm-bridge', 'c4.db')), false);
          } finally {
            if (fixture.unreadable) fs.chmodSync(manifestPath, 0o600);
          }
        });
      });
    }
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

  // Boundary: an unknown switch cannot consume the next known option.
  it('keeps a known content option immediately after an unknown switch', () => {
    withTmpDir(({ tmpDir, env }) => {
      const r = cliRaw(['--no-reply', '--json', '--some-flag', '--content', 'known content'], env);
      assert.equal(r.status, 0, r.stderr);
      const out = parseJsonStdout(r.stdout);
      assert.equal(out.ok, true);
      assert.deepEqual(ignoredOptions(r.stderr), ['Ignored unknown option: --some-flag']);
      const db = openDb(tmpDir);
      try {
        assert.equal(db.prepare('SELECT content FROM conversations WHERE id = ?').get(out.id).content, 'known content');
      } finally {
        db.close();
      }
    });
  });

  // Boundary: an unknown final token has no value to consume.
  it('ignores an unknown option at the end of the arguments', () => {
    withTmpDir(({ env }) => {
      const r = cliRaw(['--no-reply', '--json', '--content', 'tail content', '--future-switch'], env);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(parseJsonStdout(r.stdout).ok, true);
      assert.deepEqual(ignoredOptions(r.stderr), ['Ignored unknown option: --future-switch']);
    });
  });

  // Boundary: each ignored option reports only its name, including inline values.
  it('reports each unknown name without separate or inline values', () => {
    withTmpDir(({ env }) => {
      const r = cliRaw(['--no-reply', '--json', '--first', 'private-value',
        '--inline=inline-private=more', 'second-private', '--last', '--content', 'visible'], env);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(parseJsonStdout(r.stdout).ok, true);
      assert.deepEqual(ignoredOptions(r.stderr), ['Ignored unknown option: --first',
        'Ignored unknown option: --inline', 'Ignored unknown option: --last']);
      for (const value of ['private-value', 'inline-private', 'more', 'second-private']) {
        assert.equal(r.stderr.includes(value), false);
      }
    });
  });

  // Boundary: only a '--' prefix prevents a following value from being skipped.
  for (const value of ['-x', '']) {
    it(`skips a following non-double-dash value: ${JSON.stringify(value)}`, () => {
      withTmpDir(({ env }) => {
        const r = cliRaw(['--no-reply', '--json', '--future', value, '--content', 'visible'], env);
        assert.equal(r.status, 0, r.stderr);
        assert.equal(parseJsonStdout(r.stdout).ok, true);
        assert.deepEqual(ignoredOptions(r.stderr), ['Ignored unknown option: --future']);
      });
    });
  }

  // Boundary: at most one unknown-option value is skipped; other bare words fail.
  for (const extra of [['stray'], ['--future', 'value', 'stray']]) {
    it(`rejects an unconsumed extra word: ${extra.join(' ')}`, () => {
      withTmpDir(({ tmpDir, env }) => {
        const r = cliRaw(['--no-reply', '--json', '--content', 'visible', ...extra], env);
        assert.equal(r.status, 1);
        const out = parseJsonStdout(r.stdout);
        assert.equal(out.error.code, 'INVALID_ARGS');
        assert.equal(out.error.message, 'Unexpected argument: stray');
        assert.deepEqual(ignoredOptions(r.stderr), extra.length === 1 ? [] : ['Ignored unknown option: --future']);
        assert.equal(fs.existsSync(path.join(tmpDir, 'comm-bridge', 'c4.db')), false);
      });
    });
  }

  // Boundary: known value-taking options still consume the next token.
  it('stores a double-dash content value without treating it as an option', () => {
    withTmpDir(({ tmpDir, env }) => {
      const r = cliRaw(['--no-reply', '--json', '--content', '--future-content'], env);
      assert.equal(r.status, 0, r.stderr);
      const out = parseJsonStdout(r.stdout);
      assert.deepEqual(ignoredOptions(r.stderr), []);
      const db = openDb(tmpDir);
      try {
        assert.equal(db.prepare('SELECT content FROM conversations WHERE id = ?').get(out.id).content, '--future-content');
      } finally {
        db.close();
      }
    });
  });

  // Boundary: ignored forward arguments cannot bypass known validation.
  for (const { args, message } of [
    { args: ['--no-reply', '--priority', '5', '--content', 'x'], message: '--priority must be an integer 1, 2, or 3' },
    { args: ['--no-reply'], message: '--content is required' },
    { args: ['--content', 'x'], message: '--channel is required unless --no-reply is set' },
  ]) {
    it(`preserves known validation after ignoring an option: ${message}`, () => {
      withTmpDir(({ tmpDir, env }) => {
        const r = cliRaw(['--json', '--future-group', 'team', ...args], env);
        assert.equal(r.status, 1);
        const out = parseJsonStdout(r.stdout);
        assert.equal(out.error.code, 'INVALID_ARGS');
        assert.equal(out.error.message, message);
        assert.deepEqual(ignoredOptions(r.stderr), ['Ignored unknown option: --future-group']);
        assert.equal(fs.existsSync(path.join(tmpDir, 'comm-bridge', 'c4.db')), false);
      });
    });
  }
});
