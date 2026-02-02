#!/usr/bin/env node
/**
 * Web Console Server
 * Provides HTTP API for browser-based Claude communication
 *
 * Run with PM2: pm2 start server.js --name web-console
 * Default port: 3456
 */

const express = require('express');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.WEB_CONSOLE_PORT || 3456;

// Paths
const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const SKILLS_DIR = path.join(os.homedir(), '.claude', 'skills');
const DB_DIR = path.join(ZYLOS_DIR, 'comm-bridge');
const DB_PATH = path.join(DB_DIR, 'c4.db');
const STATUS_FILE = path.join(os.homedir(), '.claude-status');

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Initialize database connection
let db;
try {
  db = new Database(DB_PATH, { readonly: false });
} catch (err) {
  console.error(`Failed to open database: ${err.message}`);
  console.error('Make sure comm-bridge is initialized first');
  process.exit(1);
}

/**
 * Get Claude status
 */
app.get('/api/status', (req, res) => {
  const fs = require('fs');
  try {
    if (fs.existsSync(STATUS_FILE)) {
      const status = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
      res.json(status);
    } else {
      res.json({ state: 'unknown', message: 'Status file not found' });
    }
  } catch (err) {
    res.json({ state: 'error', message: err.message });
  }
});

/**
 * Get conversation history
 */
app.get('/api/conversations', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const source = req.query.source || 'web';

    const stmt = db.prepare(`
      SELECT id, direction, source, endpoint_id, content, timestamp
      FROM conversations
      WHERE source = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `);

    const conversations = stmt.all(source, limit);
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
      SELECT id, direction, source, endpoint_id, content, timestamp
      FROM conversations
      WHERE source = 'web-console'
      ORDER BY timestamp DESC
      LIMIT ?
    `);

    const conversations = stmt.all(limit);
    res.json(conversations.reverse());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Send message to Claude
 */
app.post('/api/send', (req, res) => {
  const { message } = req.body;

  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'Message is required' });
  }

  // Use c4-receive.js to forward message to Claude
  const c4Receive = path.join(SKILLS_DIR, 'comm-bridge', 'c4-receive.js');

  const child = spawn('node', [
    c4Receive,
    '--source', 'web-console',
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
 * Poll for new messages since given ID
 */
app.get('/api/poll', (req, res) => {
  try {
    const sinceId = parseInt(req.query.since_id) || 0;

    const stmt = db.prepare(`
      SELECT id, direction, source, endpoint_id, content, timestamp
      FROM conversations
      WHERE source = 'web-console' AND id > ?
      ORDER BY timestamp ASC
    `);

    const messages = stmt.all(sinceId);
    res.json(messages);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Health check
 */
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Serve index.html for root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, () => {
  console.log(`Web Console server running on http://localhost:${PORT}`);
  console.log(`Database: ${DB_PATH}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down...');
  if (db) db.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('Shutting down...');
  if (db) db.close();
  process.exit(0);
});
