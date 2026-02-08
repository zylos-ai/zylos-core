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

// Dynamic import: set ZYLOS_DIR before loading so shared.js picks up temp dir
process.env.ZYLOS_DIR = TEST_BASE;
const { findHeaderDate, resolveArchivePath } = await import('../rotate-session.js');

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

// ── resolveArchivePath unit tests ────────────────────────────────

describe('resolveArchivePath', () => {
  afterEach(() => cleanSessions());

  it('returns YYYY-MM-DD.md when no collision', () => {
    ensureSessionsDir();
    const result = resolveArchivePath('2025-01-15', 'UTC');
    assert.equal(path.basename(result), '2025-01-15.md');
  });

  it('appends -1 suffix on first collision', () => {
    ensureSessionsDir();
    fs.writeFileSync(path.join(SESSIONS_DIR, '2025-01-15.md'), 'old', 'utf8');
    const result = resolveArchivePath('2025-01-15', 'UTC');
    assert.equal(path.basename(result), '2025-01-15-1.md');
  });

  it('appends -2 suffix on second collision', () => {
    ensureSessionsDir();
    fs.writeFileSync(path.join(SESSIONS_DIR, '2025-01-15.md'), 'old', 'utf8');
    fs.writeFileSync(path.join(SESSIONS_DIR, '2025-01-15-1.md'), 'old', 'utf8');
    const result = resolveArchivePath('2025-01-15', 'UTC');
    assert.equal(path.basename(result), '2025-01-15-2.md');
  });

  it('falls back to today when baseDate is invalid', () => {
    ensureSessionsDir();
    const result = resolveArchivePath('not-a-date', 'UTC');
    const basename = path.basename(result);
    assert.match(basename, /^\d{4}-\d{2}-\d{2}\.md$/);
  });

  it('resolves into SESSIONS_DIR', () => {
    ensureSessionsDir();
    const result = resolveArchivePath('2025-03-01', 'UTC');
    assert.equal(path.dirname(result), SESSIONS_DIR);
  });
});

// ── Integration tests (full rotation via child_process) ──────────

describe('rotate-session integration', () => {
  afterEach(() => cleanSessions());

  it('creates fresh current.md when none exists', () => {
    ensureSessionsDir();
    const output = runRotate();
    assert.match(output, /Created fresh current\.md/);

    const content = fs.readFileSync(CURRENT_FILE, 'utf8');
    assert.match(content, /^# Session Log: \d{4}-\d{2}-\d{2}\n/);
  });

  it('skips rotation when current.md matches today', () => {
    const today = new Date().toISOString().slice(0, 10);
    writeCurrent(`# Session Log: ${today}\n\nSome entries.\n`);

    const output = runRotate();
    assert.match(output, /No rotation needed/);

    const content = fs.readFileSync(CURRENT_FILE, 'utf8');
    assert.ok(content.includes('Some entries.'));
  });

  it('rotates current.md when header date is yesterday', () => {
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    writeCurrent(`# Session Log: ${yesterday}\n\nYesterday entries.\n`);

    const output = runRotate();
    assert.match(output, /Rotated current\.md/);
    assert.match(output, /Created fresh current\.md/);

    const archived = fs.readFileSync(path.join(SESSIONS_DIR, `${yesterday}.md`), 'utf8');
    assert.ok(archived.includes('Yesterday entries.'));

    const current = fs.readFileSync(CURRENT_FILE, 'utf8');
    const today = new Date().toISOString().slice(0, 10);
    assert.ok(current.includes(`# Session Log: ${today}`));
  });

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

  it('uses mtime fallback when header is missing', () => {
    writeCurrent('No header here, just content.\n');

    const output = runRotate();
    assert.match(output, /Rotated current\.md/);
    assert.match(output, /Created fresh current\.md/);

    const files = fs.readdirSync(SESSIONS_DIR).filter((f) => f !== 'current.md');
    assert.ok(files.length >= 1, `Expected at least 1 archived file, got: ${files}`);
    assert.match(files[0], /^\d{4}-\d{2}-\d{2}/);
  });

  it('creates sessions directory if missing', () => {
    cleanSessions();
    const output = runRotate();
    assert.match(output, /Created fresh current\.md/);
    assert.ok(fs.existsSync(CURRENT_FILE));
  });
});
