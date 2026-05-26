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

function readCooldowns(tmpDir) {
  return JSON.parse(fs.readFileSync(path.join(tmpDir, 'activity-monitor', 'status-notice-cooldowns.json'), 'utf8'));
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
      assert.ok(inbound.content.includes('reply via'));
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

      const cooldowns = readCooldowns(tmpDir);
      const entries = Object.values(cooldowns);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].endpoint, 'oc_123|type:group|root:om_root');
      assert.equal(entries[0].status_type, 'unavailable');
      assert.equal(entries[0].reason, 'unavailable');

      const db = openDb(tmpDir);
      const inboundCount = db.prepare("SELECT count(*) AS count FROM conversations WHERE direction = 'in'").get();
      const outboundCount = db.prepare("SELECT count(*) AS count FROM conversations WHERE direction = 'out'").get();
      const suppressed = db.prepare("SELECT content FROM conversations WHERE id = ?").get(Number(out.id));
      db.close();

      assert.equal(inboundCount.count, 2);
      assert.equal(outboundCount.count, 1);
      assert.match(suppressed.content, /Status notification suppressed by cooldown/);
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
        assert.ok(row.content.includes('reply via'));
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

        const cooldowns = readCooldowns(tmpDir);
        const entries = Object.values(cooldowns);
        assert.equal(entries.length, 1);
        assert.equal(entries[0].endpoint, 'oc_123|type:group|root:om_root');
        assert.equal(entries[0].status_type, 'unavailable');
        assert.equal(entries[0].reason, 'heartbeat_timeout');

        const db = openDb(tmpDir);
        const outboundCount = db.prepare("SELECT count(*) AS count FROM conversations WHERE direction = 'out'").get();
        const suppressed = db.prepare("SELECT content FROM conversations WHERE id = ?").get(Number(out.id));
        db.close();

        assert.equal(outboundCount.count, 1);
        assert.match(suppressed.content, /Status notification suppressed by cooldown/);
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
