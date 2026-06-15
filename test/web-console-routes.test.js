import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import Database from '../skills/web-console/node_modules/better-sqlite3/lib/index.js';
import WebSocket from '../skills/web-console/node_modules/ws/wrapper.mjs';

const SERVER_PATH = path.resolve('skills/web-console/scripts/server.js');
const SQLITE_MODULE = path.resolve('skills/web-console/node_modules/better-sqlite3/lib/index.js');

let ctx;

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function createDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      direction TEXT,
      channel TEXT,
      endpoint_id TEXT,
      content TEXT,
      timestamp TEXT
    );
  `);
  db.close();
}

function createFakeC4Receive(skillsDir, dbPath) {
  const scriptDir = path.join(skillsDir, 'comm-bridge', 'scripts');
  fs.mkdirSync(scriptDir, { recursive: true });
  fs.writeFileSync(path.join(scriptDir, 'c4-receive.js'), `
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from ${JSON.stringify(SQLITE_MODULE)};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
function arg(name) {
  const idx = args.indexOf(name);
  return idx === -1 ? null : args[idx + 1];
}
const channel = arg('--channel');
const endpoint = arg('--endpoint');
const content = arg('--content');
if (!channel || !content) process.exit(2);

const suffixBase = 'reply via: node ' + path.join(__dirname, 'c4-send.js') + ' "' + channel + '"';
const suffix = endpoint ? ' ---- ' + suffixBase + ' "' + endpoint + '"' : ' ---- ' + suffixBase;
const fullMessage = content + suffix;
let dbContent = fullMessage;
if (Buffer.byteLength(fullMessage, 'utf8') > 2048) {
  const msgId = 'test-' + Date.now();
  const dir = path.join(path.dirname(${JSON.stringify(dbPath)}), 'attachments', msgId);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'message.txt');
  fs.writeFileSync(filePath, fullMessage, 'utf8');
  dbContent = content.substring(0, 100) + '\\n\\n[C4] Full message at: ' + filePath + suffix;
}
const db = new Database(${JSON.stringify(dbPath)});
db.prepare('INSERT INTO conversations (direction, channel, endpoint_id, content, timestamp) VALUES (?, ?, ?, ?, ?)')
  .run('in', channel, endpoint, dbContent, new Date().toISOString());
db.close();
`);
  fs.writeFileSync(path.join(scriptDir, 'c4-send.js'), '');
}

async function startServer({ maxUploadMb = 20 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-routes-'));
  const dbPath = path.join(root, 'comm-bridge', 'c4.db');
  const skillsDir = path.join(root, 'skills');
  fs.mkdirSync(path.join(root, 'activity-monitor'), { recursive: true });
  fs.writeFileSync(path.join(root, '.env'), '');
  fs.writeFileSync(path.join(root, 'activity-monitor', 'agent-status.json'), '{"state":"idle"}');
  createDb(dbPath);
  createFakeC4Receive(skillsDir, dbPath);
  const port = await freePort();

  const child = spawn(process.execPath, [SERVER_PATH], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      ZYLOS_DIR: root,
      WEB_CONSOLE_SKILLS_DIR: skillsDir,
      WEB_CONSOLE_PORT: String(port),
      WEB_CONSOLE_BIND: '127.0.0.1',
      WEB_CONSOLE_MAX_UPLOAD_MB: String(maxUploadMb)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early: ${output}`);
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) return { root, dbPath, skillsDir, port, baseUrl, child };
    } catch {
      // Retry until server is listening.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  child.kill('SIGTERM');
  throw new Error(`server did not start: ${output}`);
}

function stopServer(active) {
  if (!active) return;
  active.child.kill('SIGTERM');
  fs.rmSync(active.root, { recursive: true, force: true });
}

function rows(dbPath) {
  const db = new Database(dbPath);
  const result = db.prepare('SELECT id, direction, channel, endpoint_id, content FROM conversations ORDER BY id ASC').all();
  db.close();
  return result;
}

async function uploadFile(active, { name = 'report.txt', type = 'text/plain', content = 'hello' } = {}) {
  const form = new FormData();
  form.append('file', new Blob([content], { type }), name);
  const res = await fetch(`${active.baseUrl}/api/upload`, { method: 'POST', body: form });
  return { res, body: await res.json() };
}

async function sendHttp(active, payload) {
  const res = await fetch(`${active.baseUrl}/api/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  return { res, body: await res.json() };
}

beforeEach(() => {
  ctx = null;
});

afterEach(() => {
  stopServer(ctx);
});

describe('web-console attachment routes', () => {
  test('POST /api/upload stores a UUID-named file and returns metadata', async () => {
    ctx = await startServer();
    const { res, body } = await uploadFile(ctx, { name: '../bad name.txt', content: 'abc' });

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      name: 'bad name.txt',
      size: 3,
      mime: 'text/plain',
      kind: 'file'
    });
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);

    const files = fs.readdirSync(path.join(ctx.root, 'web-console', 'media'));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^wc-.*-[0-9a-f]{8}\.txt$/);
  });

  test('POST /api/upload returns 413 for oversized files', async () => {
    ctx = await startServer({ maxUploadMb: 1 });
    const form = new FormData();
    form.append('file', new Blob(['x'.repeat(1024 * 1024 + 1)], { type: 'text/plain' }), 'large.txt');

    const res = await fetch(`${ctx.baseUrl}/api/upload`, { method: 'POST', body: form });
    const body = await res.json();

    expect(res.status).toBe(413);
    expect(body.error).toBe('upload_too_large');
  });

  test('HTTP attachment-only send queues verbatim annotation content', async () => {
    ctx = await startServer();
    const upload = await uploadFile(ctx, { name: 'report.txt', content: 'abc' });
    const sent = await sendHttp(ctx, { message: '', attachments: [upload.body.id] });

    expect(sent.res.status).toBe(200);
    const latest = rows(ctx.dbPath).at(-1);
    expect(latest.content).toContain('[attachment:file ');
    expect(latest.content).toContain('name="report.txt" 3B]');
    expect(latest.content).toContain(' ---- reply via: node ');
    expect(latest.content).not.toContain('[C4] Full message');
  });

  test('WS attachment-only send queues verbatim annotation content', async () => {
    ctx = await startServer();
    const upload = await uploadFile(ctx, { name: 'image.png', type: 'image/png', content: 'pngbytes' });

    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}/`);
      const timer = setTimeout(() => reject(new Error('timed out waiting for sent ack')), 3000);
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'send', content: '', attachments: [upload.body.id], tempId: 't1' }));
      });
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type !== 'sent') return;
        clearTimeout(timer);
        ws.close();
        msg.success ? resolve() : reject(new Error(msg.error || 'send failed'));
      });
      ws.on('error', reject);
    });

    const latest = rows(ctx.dbPath).at(-1);
    expect(latest.content).toContain('[attachment:image ');
    expect(latest.content).toContain('name="image.png" 8B]');
  });

  test('concurrent sends with the same upload id deliver exactly once', async () => {
    ctx = await startServer();
    const upload = await uploadFile(ctx, { name: 'report.txt', content: 'abc' });
    const payload = { message: '', attachments: [upload.body.id] };

    const results = await Promise.all([
      sendHttp(ctx, payload),
      sendHttp(ctx, payload)
    ]);

    const statuses = results.map((result) => result.res.status).sort();
    expect(statuses).toEqual([200, 400]);
    expect(results.map((result) => result.body.error).filter(Boolean)).toEqual(['invalid_attachment']);

    const queuedRows = rows(ctx.dbPath);
    expect(queuedRows).toHaveLength(1);
    expect(queuedRows[0].content).toContain('[attachment:file ');
    expect(queuedRows[0].content).toContain('name="report.txt" 3B]');
  });

  test('GET /api/media/:messageId serves only revalidated media rows', async () => {
    ctx = await startServer();
    const imagePath = path.join(ctx.root, 'out.png');
    fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const filePath = path.join(ctx.root, 'out.txt');
    fs.writeFileSync(filePath, 'download');
    const escapePath = path.join(ctx.root, 'escape');
    fs.symlinkSync('/etc/passwd', escapePath);

    const db = new Database(ctx.dbPath);
    const insert = db.prepare('INSERT INTO conversations (direction, channel, endpoint_id, content, timestamp) VALUES (?, ?, ?, ?, ?)');
    const imageId = insert.run('out', 'web-console', 'console', `[MEDIA:image]${imagePath}`, new Date().toISOString()).lastInsertRowid;
    const fileId = insert.run('out', 'web-console', 'console', `[MEDIA:file]${filePath}`, new Date().toISOString()).lastInsertRowid;
    const inRowId = insert.run('in', 'web-console', 'console', `[MEDIA:file]${filePath}`, new Date().toISOString()).lastInsertRowid;
    const wrongChannelId = insert.run('out', 'telegram', 'console', `[MEDIA:file]${filePath}`, new Date().toISOString()).lastInsertRowid;
    const wrongEndpointId = insert.run('out', 'web-console', 'other', `[MEDIA:file]${filePath}`, new Date().toISOString()).lastInsertRowid;
    const notMediaId = insert.run('out', 'web-console', 'console', `hello [MEDIA:file]${filePath}`, new Date().toISOString()).lastInsertRowid;
    const escapeId = insert.run('out', 'web-console', 'console', `[MEDIA:file]${escapePath}`, new Date().toISOString()).lastInsertRowid;
    db.close();

    const image = await fetch(`${ctx.baseUrl}/api/media/${imageId}`);
    expect(image.status).toBe(200);
    expect(image.headers.get('content-type')).toBe('image/png');
    expect(image.headers.get('content-disposition')).toBe('inline; filename="out.png"');

    const file = await fetch(`${ctx.baseUrl}/api/media/${fileId}`);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('application/octet-stream');
    expect(file.headers.get('content-disposition')).toBe('attachment; filename="out.txt"');
    expect(await file.text()).toBe('download');

    for (const id of [999999, inRowId, wrongChannelId, wrongEndpointId, notMediaId, escapeId]) {
      const res = await fetch(`${ctx.baseUrl}/api/media/${id}`);
      expect(res.status).toBe(404);
    }
  });

  test('GET /api/inbound-media/:filename serves uploaded files from media dir', async () => {
    ctx = await startServer();
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    const mediaDir = path.join(ctx.root, 'web-console', 'media');

    const pngFile = path.join(mediaDir, 'wc-test-image.png');
    fs.writeFileSync(pngFile, pngBytes);
    const txtFile = path.join(mediaDir, 'wc-test-doc.txt');
    fs.writeFileSync(txtFile, 'hello');

    const imgRes = await fetch(`${ctx.baseUrl}/api/inbound-media/wc-test-image.png`);
    expect(imgRes.status).toBe(200);
    expect(imgRes.headers.get('content-type')).toBe('image/png');
    expect(imgRes.headers.get('content-disposition')).toContain('inline');

    const txtRes = await fetch(`${ctx.baseUrl}/api/inbound-media/wc-test-doc.txt`);
    expect(txtRes.status).toBe(200);
    expect(txtRes.headers.get('content-type')).toBe('application/octet-stream');
    expect(txtRes.headers.get('content-disposition')).toContain('attachment');
    expect(await txtRes.text()).toBe('hello');

    const missing = await fetch(`${ctx.baseUrl}/api/inbound-media/nonexistent.png`);
    expect(missing.status).toBe(404);

    const traversal = await fetch(`${ctx.baseUrl}/api/inbound-media/..%2F..%2F.env`);
    expect(traversal.status).toBe(404);
  });

  test('GET /api/conversations/recent includes inbound image href', async () => {
    ctx = await startServer();
    const mediaDir = path.join(ctx.root, 'web-console', 'media');
    const imgFile = path.join(mediaDir, 'wc-uploaded.png');
    fs.writeFileSync(imgFile, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

    const db = new Database(ctx.dbPath);
    db.prepare('INSERT INTO conversations (direction, channel, endpoint_id, content, timestamp) VALUES (?, ?, ?, ?, ?)')
      .run('in', 'web-console', 'console',
        `hello\n[attachment:image ${imgFile} name="screenshot.png" 8B]`,
        new Date().toISOString());
    db.close();

    const res = await fetch(`${ctx.baseUrl}/api/conversations/recent?limit=10`);
    const conversations = await res.json();
    const last = conversations.at(-1);

    expect(last.content).toBe('hello');
    expect(last.attachments).toHaveLength(1);
    expect(last.attachments[0].kind).toBe('image');
    expect(last.attachments[0].href).toBe('/api/inbound-media/wc-uploaded.png');
  });
});
