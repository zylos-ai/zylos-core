#!/usr/bin/env node
/**
 * Web Console Server with WebSocket
 * Provides HTTP API + WebSocket for real-time browser-based Claude communication
 *
 * Run with PM2: pm2 start server.js --name web-console
 * Default port: 3456
 */

import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import multer from 'multer';
import crypto from 'crypto';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { spawn } from 'child_process';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import {
  MAX_ATTACHMENTS,
  UploadRegistry,
  assertAttachmentContentFitsC4,
  buildAnnotatedContent,
  classifyConversationMessage,
  contentDisposition,
  generateStoredFileName,
  parseMediaContent,
  resolveAllowedPathSync,
  sanitizeDisplayName,
  sniffImage,
  splitContentAndAttachments,
  uploadKind
} from './attachment-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.WEB_CONSOLE_PORT || 3456;

// Paths
const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const SKILLS_DIR = path.join(os.homedir(), 'zylos', '.claude', 'skills');
const DB_DIR = path.join(ZYLOS_DIR, 'comm-bridge');
const DB_PATH = path.join(DB_DIR, 'c4.db');
const STATUS_FILE = path.join(ZYLOS_DIR, 'activity-monitor', 'agent-status.json');
const MEDIA_DIR = path.join(ZYLOS_DIR, 'web-console', 'media');
const MAX_UPLOAD_MB = Number.parseInt(process.env.WEB_CONSOLE_MAX_UPLOAD_MB || '20', 10);
const MAX_UPLOAD_BYTES = Math.max(1, MAX_UPLOAD_MB) * 1024 * 1024;
const C4_SCRIPT_DIR = path.join(SKILLS_DIR, 'comm-bridge', 'scripts');

// Paths - __dirname is scripts/, public/ is one level up
const SKILL_ROOT = path.join(__dirname, '..');

// --- Authentication ---
import { parse as parseDotenv } from 'dotenv';

function readEnv() {
  const envPath = path.join(ZYLOS_DIR, '.env');
  try {
    return parseDotenv(fs.readFileSync(envPath, 'utf8'));
  } catch {
    return {};
  }
}

const ENV = readEnv();

function readEnvPassword() {
  return ENV.ZYLOS_WEB_PASSWORD || ENV.WEB_CONSOLE_PASSWORD || '';
}

const AUTH_PASSWORD = readEnvPassword();
const AUTH_ENABLED = AUTH_PASSWORD.length > 0;
const sessions = new Set(); // Active session tokens
const uploadRegistry = new UploadRegistry();

fs.mkdirSync(MEDIA_DIR, { recursive: true });

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  for (const pair of cookieHeader.split(';')) {
    const [name, ...rest] = pair.trim().split('=');
    if (name) cookies[name] = rest.join('=');
  }
  return cookies;
}

function isAuthenticated(req) {
  if (!AUTH_ENABLED) return true;
  const cookies = parseCookies(req.headers.cookie);
  return cookies.wc_session && sessions.has(cookies.wc_session);
}

function getSessionId(req) {
  if (!AUTH_ENABLED) return 'local';
  const cookies = parseCookies(req.headers.cookie);
  return cookies.wc_session || null;
}

function authMiddleware(req, res, next) {
  // Auth endpoints are always accessible
  if (req.path === '/auth') return next();
  if (!isAuthenticated(req)) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  next();
}

// Middleware
app.use(express.json());
app.use(express.static(path.join(SKILL_ROOT, 'public')));
app.use('/api', authMiddleware);

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, MEDIA_DIR),
    filename: (_req, file, cb) => cb(null, generateStoredFileName(file.originalname))
  }),
  limits: {
    fileSize: MAX_UPLOAD_BYTES,
    files: 1
  }
});

// Initialize database connection
let db;
try {
  // Verify database file exists
  if (!fs.existsSync(DB_PATH)) {
    console.error(`Database not found: ${DB_PATH}`);
    console.error('Make sure comm-bridge is initialized first (run c4-db.js init)');
    process.exit(1);
  }

  db = new Database(DB_PATH, { readonly: false });

  // Verify schema exists
  const tableCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='conversations'").get();
  if (!tableCheck) {
    console.error('Database schema not initialized');
    console.error('Run: node ~/zylos/.claude/skills/comm-bridge/scripts/c4-db.js init');
    process.exit(1);
  }
} catch (err) {
  console.error(`Failed to open database: ${err.message}`);
  console.error('Make sure comm-bridge is initialized first');
  process.exit(1);
}

// Track connected WebSocket clients
const clients = new Set();

// Last known state for change detection
let lastStatus = null;
let lastMessageId = 0;

/**
 * Read current Claude status
 */
function readStatus() {
  try {
    if (fs.existsSync(STATUS_FILE)) {
      return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
    }
    return { state: 'unknown', message: 'Status file not found' };
  } catch (err) {
    return { state: 'error', message: err.message };
  }
}

/**
 * Strip internal routing info from message content for display
 */
function stripReplyVia(content) {
  // Remove "---- reply via: ..." suffix
  const idx = content.indexOf(' ---- reply via:');
  if (idx !== -1) {
    return content.substring(0, idx);
  }
  return content;
}

/**
 * Clean message for display (strip internal routing info)
 */
function cleanMessageForDisplay(msg) {
  const cleaned = {
    ...msg,
    content: stripReplyVia(msg.content)
  };
  const classified = classifyConversationMessage(cleaned);
  if (classified.kind === 'media') return classified;
  if (cleaned.direction === 'in') {
    const parsed = splitContentAndAttachments(cleaned.content);
    if (parsed.attachments.length > 0) {
      return {
        ...cleaned,
        content: parsed.content,
        attachments: parsed.attachments.map((attachment) => ({
          kind: attachment.kind,
          name: attachment.name,
          size_label: attachment.sizeLabel
        }))
      };
    }
  }
  return cleaned;
}

/**
 * Get new messages since given ID
 */
function getNewMessages(sinceId) {
  try {
    const stmt = db.prepare(`
      SELECT id, direction, channel, endpoint_id, content, timestamp
      FROM conversations
      WHERE channel = 'web-console' AND id > ?
      ORDER BY timestamp ASC
    `);
    return stmt.all(sinceId).map(cleanMessageForDisplay);
  } catch (err) {
    return [];
  }
}

/**
 * Broadcast message to all connected clients
 */
function broadcast(type, data) {
  const message = JSON.stringify({ type, data });
  for (const client of clients) {
    if (client.readyState === 1) { // WebSocket.OPEN
      client.send(message);
    }
  }
}

function normalizeAttachmentIds(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((id) => typeof id === 'string' && id.length > 0);
}

function validateSendPayload(content, attachmentIds) {
  if (attachmentIds.length > MAX_ATTACHMENTS) {
    const err = new Error(`Maximum ${MAX_ATTACHMENTS} attachments per message`);
    err.status = 400;
    err.code = 'too_many_attachments';
    throw err;
  }

  if (!String(content || '').trim() && attachmentIds.length === 0) {
    const err = new Error('Message is required');
    err.status = 400;
    err.code = 'message_required';
    throw err;
  }
}

function buildSendContent(content, attachmentEntries) {
  const message = buildAnnotatedContent(content, attachmentEntries);
  if (!message.trim()) {
    const err = new Error('Message is required');
    err.status = 400;
    err.code = 'message_required';
    throw err;
  }
  if (attachmentEntries.length > 0) {
    assertAttachmentContentFitsC4(message, {
      c4ReceiveScriptDir: C4_SCRIPT_DIR,
      channel: 'web-console',
      endpoint: 'console'
    });
  }
  return message;
}

function sendToC4(content) {
  const c4Receive = path.join(C4_SCRIPT_DIR, 'c4-receive.js');

  return new Promise((resolve, reject) => {
    const child = spawn('node', [
      c4Receive,
      '--channel', 'web-console',
      '--endpoint', 'console',
      '--content', content
    ], { stdio: 'pipe' });

    let stderr = '';
    child.stderr.on('data', (data) => { stderr += data; });
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        const err = new Error(stderr || 'Failed to send message');
        err.status = 500;
        err.code = 'send_failed';
        reject(err);
      }
    });
    child.on('error', (err) => {
      err.status = 500;
      err.code = 'send_failed';
      reject(err);
    });
  });
}

async function sendConsoleMessage({ content, attachmentIds, sessionId }) {
  const ids = normalizeAttachmentIds(attachmentIds);
  validateSendPayload(content, ids);

  let attachmentEntries = [];
  if (ids.length > 0) {
    attachmentEntries = uploadRegistry.getMany(ids, sessionId);
    if (attachmentEntries.length !== ids.length) {
      const err = new Error('Attachment upload id is invalid or expired');
      err.status = 400;
      err.code = 'invalid_attachment';
      throw err;
    }
  }

  const combined = buildSendContent(content, attachmentEntries);
  if (ids.length > 0 && !uploadRegistry.consumeMany(ids, sessionId)) {
    const err = new Error('Attachment upload id is invalid or expired');
    err.status = 400;
    err.code = 'invalid_attachment';
    throw err;
  }
  await sendToC4(combined);
  return {
    content: combined,
    attachments: attachmentEntries.map((entry) => ({
      kind: entry.kind,
      name: entry.name,
      size_label: entry.sizeLabel || null
    }))
  };
}

function jsonError(res, err) {
  return res.status(err.status || 500).json({
    success: false,
    error: err.code || err.message || 'request_failed',
    message: err.message
  });
}

function getMediaRow(messageId) {
  const row = db.prepare(`
    SELECT id, direction, channel, endpoint_id, content, timestamp
    FROM conversations
    WHERE id = ?
  `).get(messageId);

  if (!row || row.direction !== 'out' || row.channel !== 'web-console' || row.endpoint_id !== 'console') {
    return null;
  }

  const media = parseMediaContent(row.content);
  if (!media) return null;
  return { row, media };
}

/**
 * Check for status changes and new messages
 */
function checkUpdates() {
  // Check status changes
  const currentStatus = readStatus();
  if (!lastStatus || currentStatus.state !== lastStatus.state) {
    lastStatus = currentStatus;
    broadcast('status', currentStatus);
  }

  // Check for new messages
  const newMessages = getNewMessages(lastMessageId);
  if (newMessages.length > 0) {
    lastMessageId = Math.max(...newMessages.map(m => m.id));
    broadcast('messages', newMessages);
  }
}

// Start update checker (every 500ms for responsiveness)
setInterval(checkUpdates, 500);

// Initialize lastMessageId
try {
  const stmt = db.prepare(`SELECT MAX(id) as maxId FROM conversations WHERE channel = 'web-console'`);
  const result = stmt.get();
  lastMessageId = result?.maxId || 0;
} catch (err) {
  // Ignore
}

/**
 * WebSocket connection handler
 */
wss.on('connection', (ws, req) => {
  // Check auth for WebSocket connections
  if (AUTH_ENABLED) {
    const cookies = parseCookies(req.headers.cookie);
    if (!cookies.wc_session || !sessions.has(cookies.wc_session)) {
      ws.close(4001, 'Authentication required');
      return;
    }
  }

  clients.add(ws);
  console.log(`WebSocket client connected (${clients.size} total)`);

  // Send current status immediately
  const status = readStatus();
  ws.send(JSON.stringify({ type: 'status', data: status }));

  // Handle client messages
  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data);

      if (msg.type === 'send') {
        const tempId = msg.tempId; // Track client's temp ID
        try {
          await sendConsoleMessage({
            content: msg.content || '',
            attachmentIds: msg.attachments,
            sessionId: getSessionId(req)
          });
          ws.send(JSON.stringify({ type: 'sent', success: true, tempId }));
        } catch (err) {
          ws.send(JSON.stringify({
            type: 'sent',
            success: false,
            error: err.code || err.message,
            message: err.message,
            tempId
          }));
        }
      }
    } catch (err) {
      // Ignore invalid messages
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`WebSocket client disconnected (${clients.size} remaining)`);
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
    clients.delete(ws);
  });
});

/**
 * Get Claude status (HTTP fallback)
 */
app.get('/api/status', (req, res) => {
  res.json(readStatus());
});

/**
 * Get conversation history
 */
app.get('/api/conversations', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const channel = req.query.channel || 'web-console';

    const stmt = db.prepare(`
      SELECT id, direction, channel, endpoint_id, content, timestamp
      FROM conversations
      WHERE channel = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `);

    const conversations = stmt.all(channel, limit).map(cleanMessageForDisplay);
    res.json(conversations.reverse());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Get all recent conversations (for display)
 */
app.get('/api/conversations/recent', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;

    const stmt = db.prepare(`
      SELECT id, direction, channel, endpoint_id, content, timestamp
      FROM conversations
      WHERE channel = 'web-console'
      ORDER BY timestamp DESC
      LIMIT ?
    `);

    const conversations = stmt.all(limit).map(cleanMessageForDisplay);
    res.json(conversations.reverse());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Upload one attachment for a later send call
 */
app.post('/api/upload', (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({
          success: false,
          error: 'upload_too_large',
          message: `File exceeds ${MAX_UPLOAD_MB}MB limit`
        });
      }
      return res.status(400).json({ success: false, error: 'upload_failed', message: err.message });
    }

    if (!req.file) {
      return res.status(400).json({ success: false, error: 'file_required' });
    }

    const name = sanitizeDisplayName(req.file.originalname, 'attachment');
    const entry = uploadRegistry.add({
      sessionId: getSessionId(req),
      path: req.file.path,
      name,
      size: req.file.size,
      sizeLabel: req.file.size < 1024 ? `${req.file.size}B`
        : req.file.size < 1024 * 1024 ? `${(req.file.size / 1024).toFixed(1)}KB`
          : `${(req.file.size / (1024 * 1024)).toFixed(1)}MB`,
      mime: req.file.mimetype || 'application/octet-stream',
      kind: uploadKind(req.file)
    });

    return res.json({
      id: entry.id,
      name: entry.name,
      size: entry.size,
      mime: entry.mime,
      kind: entry.kind
    });
  });
});

/**
 * Send message to Claude (HTTP fallback)
 */
app.post('/api/send', (req, res) => {
  sendConsoleMessage({
    content: req.body.message || '',
    attachmentIds: req.body.attachments,
    sessionId: getSessionId(req)
  }).then(() => {
    res.json({ success: true, message: 'Message sent to Claude' });
  }).catch((err) => jsonError(res, err));
});

/**
 * Serve an outbound media row by message id
 */
app.get('/api/media/:messageId', (req, res) => {
  try {
    const messageId = Number.parseInt(req.params.messageId, 10);
    if (!Number.isSafeInteger(messageId)) return res.sendStatus(404);

    const result = getMediaRow(messageId);
    if (!result) return res.sendStatus(404);

    const allowedPath = resolveAllowedPathSync(result.media.path, [ZYLOS_DIR, '/tmp']);
    if (!allowedPath) {
      console.warn(`Blocked web-console media path outside allowlist: ${result.media.path}`);
      return res.sendStatus(404);
    }

    let stat;
    try {
      stat = fs.statSync(allowedPath);
    } catch {
      return res.sendStatus(404);
    }
    if (!stat.isFile()) return res.sendStatus(404);

    const fd = fs.openSync(allowedPath, 'r');
    const head = Buffer.alloc(Math.min(16, stat.size));
    fs.readSync(fd, head, 0, head.length, 0);
    fs.closeSync(fd);

    const image = result.media.media_type === 'image' ? sniffImage(head) : null;
    const disposition = image ? 'inline' : 'attachment';
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Type', image?.mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', contentDisposition(disposition, result.media.name));
    res.sendFile(allowedPath);
  } catch {
    res.sendStatus(404);
  }
});

/**
 * Poll for new messages since given ID (HTTP fallback)
 */
app.get('/api/poll', (req, res) => {
  try {
    const sinceId = parseInt(req.query.since_id) || 0;
    res.json(getNewMessages(sinceId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Check auth status
 */
app.get('/api/auth', (req, res) => {
  res.json({
    required: AUTH_ENABLED,
    authenticated: isAuthenticated(req),
    timezone: ENV.TZ || null
  });
});

/**
 * Login
 */
app.post('/api/auth', (req, res) => {
  if (!AUTH_ENABLED) {
    return res.json({ success: true, timezone: ENV.TZ || null });
  }

  const { password } = req.body;
  if (password !== AUTH_PASSWORD) {
    return res.status(401).json({ success: false, error: 'Wrong password' });
  }

  const token = crypto.randomBytes(32).toString('hex');
  sessions.add(token);
  res.setHeader('Set-Cookie', `wc_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`);
  res.json({ success: true, timezone: ENV.TZ || null });
});

/**
 * Logout
 */
app.post('/api/logout', (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  if (cookies.wc_session) sessions.delete(cookies.wc_session);
  res.setHeader('Set-Cookie', 'wc_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
  res.json({ success: true });
});

/**
 * Health check
 */
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    websocket_clients: clients.size
  });
});

// Serve index.html for root
app.get('/', (req, res) => {
  res.sendFile(path.join(SKILL_ROOT, 'public', 'index.html'));
});

// Start server (bind to localhost only for security)
const BIND_HOST = process.env.WEB_CONSOLE_BIND || '127.0.0.1';
server.listen(PORT, BIND_HOST, () => {
  console.log(`Web Console server running on http://${BIND_HOST}:${PORT}`);
  console.log(`WebSocket available at ws://${BIND_HOST}:${PORT}`);
  console.log(`Authentication: ${AUTH_ENABLED ? 'enabled' : 'disabled (no password set)'}`);
  console.log(`Database: ${DB_PATH}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down...');
  wss.close();
  if (db) db.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('Shutting down...');
  wss.close();
  if (db) db.close();
  process.exit(0);
});
