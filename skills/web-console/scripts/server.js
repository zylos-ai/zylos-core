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
import crypto from 'crypto';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { spawn } from 'child_process';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';

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
const STATUS_FILE = path.join(ZYLOS_DIR, 'activity-monitor', 'claude-status.json');

// Paths - __dirname is scripts/, public/ is one level up
const SKILL_ROOT = path.join(__dirname, '..');

// --- Authentication ---
import { parse as parseDotenv } from 'dotenv';

function readEnvPassword() {
  const envPath = path.join(ZYLOS_DIR, '.env');
  try {
    const env = parseDotenv(fs.readFileSync(envPath, 'utf8'));
    return env.WEB_CONSOLE_PASSWORD || '';
  } catch {
    return '';
  }
}

const AUTH_PASSWORD = readEnvPassword();
const AUTH_ENABLED = AUTH_PASSWORD.length > 0;
const sessions = new Set(); // Active session tokens

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
  return {
    ...msg,
    content: stripReplyVia(msg.content)
  };
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

      if (msg.type === 'send' && msg.content) {
        // Send message to Claude
        const c4Receive = path.join(SKILLS_DIR, 'comm-bridge', 'scripts', 'c4-receive.js');
        const tempId = msg.tempId; // Track client's temp ID

        const child = spawn('node', [
          c4Receive,
          '--channel', 'web-console',
          '--endpoint', 'console',
          '--content', msg.content.trim()
        ], { stdio: 'pipe' });

        child.on('close', (code) => {
          if (code === 0) {
            ws.send(JSON.stringify({ type: 'sent', success: true, tempId }));
          } else {
            ws.send(JSON.stringify({ type: 'sent', success: false, error: 'Failed to send', tempId }));
          }
        });

        child.on('error', (err) => {
          ws.send(JSON.stringify({ type: 'sent', success: false, error: err.message, tempId }));
        });
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

    const conversations = stmt.all(channel, limit);
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
 * Send message to Claude (HTTP fallback)
 */
app.post('/api/send', (req, res) => {
  const { message } = req.body;

  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'Message is required' });
  }

  const c4Receive = path.join(SKILLS_DIR, 'comm-bridge', 'scripts', 'c4-receive.js');

  const child = spawn('node', [
    c4Receive,
    '--channel', 'web-console',
    '--endpoint', 'console',
    '--content', message.trim()
  ], {
    stdio: 'pipe'
  });

  let stdout = '';
  let stderr = '';

  child.stdout.on('data', (data) => { stdout += data; });
  child.stderr.on('data', (data) => { stderr += data; });

  child.on('close', (code) => {
    if (code === 0) {
      res.json({ success: true, message: 'Message sent to Claude' });
    } else {
      res.status(500).json({
        success: false,
        error: stderr || 'Failed to send message',
        code
      });
    }
  });

  child.on('error', (err) => {
    res.status(500).json({ success: false, error: err.message });
  });
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
    authenticated: isAuthenticated(req)
  });
});

/**
 * Login
 */
app.post('/api/auth', (req, res) => {
  if (!AUTH_ENABLED) {
    return res.json({ success: true });
  }

  const { password } = req.body;
  if (password !== AUTH_PASSWORD) {
    return res.status(401).json({ success: false, error: 'Wrong password' });
  }

  const token = crypto.randomBytes(32).toString('hex');
  sessions.add(token);
  res.setHeader('Set-Cookie', `wc_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`);
  res.json({ success: true });
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
