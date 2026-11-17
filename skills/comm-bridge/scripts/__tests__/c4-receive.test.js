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
    encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 65536
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
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 65536) child.kill('SIGKILL'); });
    child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 65536) child.kill('SIGKILL'); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', status => { clearTimeout(timer); resolve({ stdout, stderr, status }); });
  });
}

function privateEnvironment(tmpDir) {
  for (const name of ['home', 'pm2', 'tmp']) fs.mkdirSync(path.join(tmpDir, name));
  const env = { ...tmuxEnvironment, HOME: path.join(tmpDir, 'home'), ZYLOS_DIR: tmpDir,
    PM2_HOME: path.join(tmpDir, 'pm2'), TMPDIR: path.join(tmpDir, 'tmp') };
  for (const key of ['HOME', 'PM2_HOME', 'TMPDIR']) assert.ok(env[key].startsWith(tmpDir + path.sep));
  assert.ok(env.TMUX.startsWith(env.TMUX_TMPDIR + path.sep));
  return env;
}

function withTmpDir(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-receive-'));
  fs.mkdirSync(path.join(tmpDir, 'activity-monitor'), { recursive: true });
  const env = privateEnvironment(tmpDir);
  try {
    return fn({ tmpDir, env });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function withTmpDirAsync(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-receive-'));
  fs.mkdirSync(path.join(tmpDir, 'activity-monitor'), { recursive: true });
  const env = privateEnvironment(tmpDir);
  try {
    return await fn({ tmpDir, env });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function openDb(tmpDir) {
  const filename = path.join(tmpDir, 'comm-bridge', 'c4.db');
  const db = new Database(filename);
  assert.equal(db.pragma('database_list').find(row => row.name === 'main').file, filename);
  return db;
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
// Real receive CLI and private IPC/file-health boundary. Run for terminal entry
// routing changes; skip unrelated UI. Each fixture proves private environment
// paths and SQLite; channel recorders never contact an external account.
describe('c4-receive health gating', () => {
  for (const health of ['recovering', 'down']) for (const noReply of [false, true]) {
    it(`defers ${health} terminal failure to owner notification with no-reply ${noReply}`, () => {
      withTmpDir(({ tmpDir, env }) => {
        writeRuntimeHealth(tmpDir, health);
        createChannelSendScript(tmpDir, 'test-chan', { exitCode: 7 });
        const r = cliRaw(['--channel', 'test-chan', '--endpoint', 'ep1', '--json',
          ...(noReply ? ['--no-reply'] : []), '--content', 'PRIVATE rejected body'], env);
        assert.equal(r.status, 0, r.stderr);
        const result = parseJsonStdout(r.stdout);
        assert.equal(result.action, 'failed');
        const db = openDb(tmpDir);
        try {
          const row = db.prepare('SELECT * FROM conversations WHERE id=?').get(result.id);
          assert.equal(row.status, 'failed'); assert.equal(row.content, 'PRIVATE rejected body');
          const notification = db.prepare('SELECT * FROM failure_receipts WHERE conversation_id=?').get(result.id);
          assert.equal(notification.reason, 'runtime_unavailable'); assert.equal(notification.state, 'pending');
          assert.equal(db.prepare("SELECT count(*) n FROM conversations WHERE direction='out'").get().n, 0);
          assert.equal(db.prepare('SELECT count(*) n FROM status_notice_cooldowns').get().n, 0);
        } finally { db.close(); }
        assert.equal(fs.existsSync(path.join(tmpDir, 'test-chan-send.json')), false);
        assert.equal(fs.existsSync(path.join(tmpDir, 'activity-monitor', 'pending-channels.jsonl')), false);
      });
    });
  }
});

describe('c4-receive MessageRouter IPC route', () => {
  it('queues pending when router returns recovered=true', async () => {
    await withTmpDirAsync(async ({ tmpDir, env }) => {
      createChannelSendScript(tmpDir, 'test-chan');
      await withRouteServer(tmpDir, request => ({ version: 2, type: 'route', runtime: 'claude',
        requestId: request.requestId, transitionHold: false, decision: 'pending', recovered: true,
        health: 'ok', reason: 'ok' }), async () => {
        const r = await cliRawAsync(['--channel', 'test-chan', '--endpoint', 'ep1', '--json', '--content', 'ok msg'], env);
        assert.equal(r.status, 0, r.stderr);
        const result = parseJsonStdout(r.stdout); assert.equal(result.action, 'queued');
        const db = openDb(tmpDir);
        try {
          assert.equal(db.prepare('SELECT status FROM conversations WHERE id=?').get(result.id).status, 'pending');
          assert.equal(db.prepare('SELECT count(*) n FROM failure_receipts').get().n, 0);
        } finally { db.close(); }
      });
    });
  });

  for (const noReply of [false, true]) {
    it(`persists rejected IPC input without forwarding router userMessage with no-reply ${noReply}`, async () => {
      await withTmpDirAsync(async ({ tmpDir, env }) => {
        createChannelSendScript(tmpDir, 'test-chan');
        await withRouteServer(tmpDir, request => ({ version: 2, type: 'route', runtime: 'claude',
          requestId: request.requestId, transitionHold: false, recovered: false, health: 'unavailable',
          reason: 'PRIVATE arbitrary reason', userMessage: 'PRIVATE arbitrary exception' }), async () => {
          const args = ['--channel', 'test-chan', '--endpoint', 'ep1', '--json',
            ...(noReply ? ['--no-reply'] : []), '--content', 'PRIVATE input'];
          const results = await Promise.all([cliRawAsync(args, env), cliRawAsync(args, env)]);
          const db = openDb(tmpDir);
          try {
            for (const r of results) {
              assert.equal(r.status, 0, r.stderr);
              const result = parseJsonStdout(r.stdout); assert.equal(result.action, 'failed');
              const notification = db.prepare('SELECT reason,state FROM failure_receipts WHERE conversation_id=?').get(result.id);
              assert.equal(notification.reason, 'runtime_unavailable'); assert.equal(notification.state, 'pending');
            }
            assert.equal(db.prepare("SELECT count(*) n FROM conversations WHERE direction='out'").get().n, 0);
            assert.equal(db.prepare('SELECT count(*) n FROM status_notice_cooldowns').get().n, 0);
          } finally { db.close(); }
          assert.equal(fs.existsSync(path.join(tmpDir, 'test-chan-send.json')), false);
        });
      });
    });
  }
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
