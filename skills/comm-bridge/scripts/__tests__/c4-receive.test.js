import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

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
  const env = { ZYLOS_DIR: tmpDir };
  try {
    return fn({ tmpDir, env });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function withTmpDirAsync(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-receive-'));
  fs.mkdirSync(path.join(tmpDir, 'activity-monitor'), { recursive: true });
  const env = { ZYLOS_DIR: tmpDir };
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
      assert.ok(!row.content.includes('[C4] Full message'));
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
      fs.writeFileSync(path.join(tmpDir, 'activity-monitor', 'agent-status.json'), JSON.stringify({ health: 'ok' }));

      const r = cliRaw(['--no-reply', '--json', '--content', 'healthy msg'], env);
      assert.equal(r.status, 0);
      const out = parseJsonStdout(r.stdout);
      assert.equal(out.ok, true);
    });
  });

  it('fallback marks no-reply unhealthy messages delivered without error', () => {
    withTmpDir(({ tmpDir, env }) => {
      fs.writeFileSync(path.join(tmpDir, 'activity-monitor', 'agent-status.json'), JSON.stringify({ health: 'recovering' }));

      const r = cliRaw(['--no-reply', '--json', '--content', 'recovering msg'], env);
      assert.equal(r.status, 0);
      const out = parseJsonStdout(r.stdout);
      assert.equal(out.ok, true);
      assert.equal(out.action, 'delivered');

      const db = openDb(tmpDir);
      const row = db.prepare('SELECT status, content FROM conversations WHERE id = ?').get(Number(out.id));
      db.close();

      assert.equal(row.status, 'delivered');
      assert.ok(row.content.includes('recovering msg'));
    });
  });

  it('fallback normalizes legacy unhealthy status and exits zero', () => {
    withTmpDir(({ tmpDir, env }) => {
      fs.writeFileSync(path.join(tmpDir, 'activity-monitor', 'agent-status.json'), JSON.stringify({ health: 'down' }));
      createChannelSendScript(tmpDir, 'test-chan');

      const r = cliRaw(['--channel', 'test-chan', '--endpoint', 'ep1', '--json', '--content', 'down msg'], env);
      assert.equal(r.status, 0);
      const out = parseJsonStdout(r.stdout);
      assert.equal(out.ok, true);
      assert.equal(out.action, 'delivered');

      const sent = JSON.parse(fs.readFileSync(path.join(tmpDir, 'test-chan-send.json'), 'utf8'));
      assert.equal(sent.args[0], 'ep1');
      assert.match(sent.args[1], /temporarily unavailable/i);

      const db = openDb(tmpDir);
      const inbound = db.prepare("SELECT status, content FROM conversations WHERE direction = 'in'").get();
      const outbound = db.prepare("SELECT status, content FROM conversations WHERE direction = 'out'").get();
      db.close();

      assert.equal(inbound.status, 'delivered');
      assert.ok(inbound.content.includes('down msg'));
      assert.ok(!inbound.content.includes('reply via'));
      assert.ok(outbound.content.includes("I'm temporarily unavailable"));
    });
  });

  it('returns an error if unhealthy status delivery fails', () => {
    withTmpDir(({ tmpDir, env }) => {
      fs.writeFileSync(path.join(tmpDir, 'activity-monitor', 'agent-status.json'), JSON.stringify({ health: 'down' }));
      createChannelSendScript(tmpDir, 'test-chan', { exitCode: 7 });

      const r = cliRaw(['--channel', 'test-chan', '--endpoint', 'ep1', '--json', '--content', 'down msg'], env);
      assert.equal(r.status, 1);
      const out = parseJsonStdout(r.stdout);
      assert.equal(out.ok, false);
      assert.equal(out.error.code, 'UNHEALTHY_NOTIFY_FAILED');
    });
  });

  it('does not write pending-channels.jsonl on fallback unhealthy route', () => {
    withTmpDir(({ tmpDir, env }) => {
      fs.writeFileSync(path.join(tmpDir, 'activity-monitor', 'agent-status.json'), JSON.stringify({ health: 'down' }));
      createChannelSendScript(tmpDir, 'test-chan');

      cliRaw(['--channel', 'test-chan', '--endpoint', 'ep1', '--json', '--content', 'x'], env);
      const pendingPath = path.join(tmpDir, 'activity-monitor', 'pending-channels.jsonl');
      assert.equal(fs.existsSync(pendingPath), false);
    });
  });

  it('fallback suppresses repeated status notices by normalized endpoint and public health', () => {
    withTmpDir(({ tmpDir, env }) => {
      fs.writeFileSync(path.join(tmpDir, 'activity-monitor', 'agent-status.json'), JSON.stringify({ health: 'down' }));
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
      assert.equal(entries[0].endpoint, 'oc_123|type:group|root:om_root');
      assert.equal(entries[0].status_type, 'unavailable');
      assert.equal(entries[0].reason, 'unavailable');
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
      fs.writeFileSync(path.join(tmpDir, 'activity-monitor', 'agent-status.json'), JSON.stringify({ health: 'down' }));
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
      fs.writeFileSync(path.join(tmpDir, 'activity-monitor', 'agent-status.json'), JSON.stringify({ health: 'down' }));
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
      assert.equal(cooldowns.some((row) => row.cooldown_key === 'test-chan::ep1::unavailable::unavailable'), true);
      assert.equal(fs.existsSync(path.join(tmpDir, 'activity-monitor', 'status-notice-cooldowns.json')), false);
    });
  });
});

describe('c4-receive MessageRouter IPC route', () => {
  it('queues pending when router returns recovered=true', async () => {
    await withTmpDirAsync(async ({ tmpDir, env }) => {
      createChannelSendScript(tmpDir, 'test-chan');
      await withRouteServer(tmpDir, (request) => ({
        version: 1,
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
        version: 1,
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
        assert.equal(inbound.status, 'delivered');
        assert.ok(inbound.content.includes('blocked msg'));
      });
    });
  });

  it('suppresses repeated router unhealthy status notices', async () => {
    await withTmpDirAsync(async ({ tmpDir, env }) => {
      createChannelSendScript(tmpDir, 'test-chan');
      await withRouteServer(tmpDir, (request) => ({
        version: 1,
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
        assert.equal(entries[0].endpoint, 'oc_123|type:group|root:om_root');
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
        version: 1,
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
        assert.equal(inbound.status, 'delivered');
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
