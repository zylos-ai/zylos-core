import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';

// Temp dir for integration tests (child_process gets ZYLOS_DIR via env)
const TEST_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-rotate-test-'));
const SESSIONS_DIR = path.join(TEST_BASE, 'memory', 'sessions');
const CURRENT_FILE = path.join(SESSIONS_DIR, 'current.md');
const SCRIPT_PATH = path.resolve(import.meta.dirname, '..', 'rotate-session.js');

function cleanSessions() {
  if (fs.existsSync(SESSIONS_DIR)) {
    fs.rmSync(SESSIONS_DIR, { recursive: true, force: true });
  }
}

function ensureSessionsDir() {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

function writeCurrent(content) {
  ensureSessionsDir();
  fs.writeFileSync(CURRENT_FILE, content, 'utf8');
}

function runRotate(envOverrides = {}) {
  const env = { ...process.env, ZYLOS_DIR: TEST_BASE, ...envOverrides };
  return execFileSync(process.execPath, [SCRIPT_PATH], {
    encoding: 'utf8',
    env,
    stdio: ['pipe', 'pipe', 'pipe']
  });
}

// ── Integration tests (full rotation via child_process) ──────────

describe('rotate-session integration', () => {
  afterEach(() => cleanSessions());

  it('handles collision when dated archive already exists', () => {
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    ensureSessionsDir();
    fs.writeFileSync(path.join(SESSIONS_DIR, `${yesterday}.md`), 'earlier archive\n', 'utf8');
    writeCurrent(`# Session Log: ${yesterday}\n\nNew entries.\n`);

    const output = runRotate();
    assert.match(output, /Rotated current\.md/);

    const archived = fs.readFileSync(path.join(SESSIONS_DIR, `${yesterday}-1.md`), 'utf8');
    assert.ok(archived.includes('New entries.'));

    const original = fs.readFileSync(path.join(SESSIONS_DIR, `${yesterday}.md`), 'utf8');
    assert.ok(original.includes('earlier archive'));
  });

});
