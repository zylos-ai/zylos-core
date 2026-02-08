import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

import { getNextRun } from '../cron-utils.js';
import { parseTime } from '../time-utils.js';

const CLI_PATH = fileURLToPath(new URL('../cli.js', import.meta.url));

async function importTimezoneModule() {
  const cacheBuster = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return import(new URL(`../tz.js?${cacheBuster}`, import.meta.url));
}

describe('scheduler timezone behavior', () => {
  it('parseTime interprets natural language using current TZ', () => {
    const originalTz = process.env.TZ;
    const refDate = new Date('2026-02-08T00:00:00Z');
    try {
      process.env.TZ = 'UTC';
      const utcTs = parseTime('tomorrow at 9am', refDate);

      process.env.TZ = 'Asia/Shanghai';
      const shanghaiTs = parseTime('tomorrow at 9am', refDate);

      assert.equal(utcTs, 1770627600);
      assert.equal(shanghaiTs, 1770598800);
    } finally {
      if (originalTz === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = originalTz;
      }
    }
  });

  it('getNextRun respects explicit timezone and DST transitions', () => {
    const fromDate = new Date('2026-02-08T00:00:00Z');
    assert.equal(getNextRun('0 9 * * *', 'UTC', fromDate), 1770541200);
    assert.equal(getNextRun('0 9 * * *', 'Asia/Shanghai', fromDate), 1770512400);

    const beforeDst = new Date('2026-03-07T12:00:00Z');
    const afterDstJump = new Date('2026-03-08T07:01:00Z');
    assert.equal(getNextRun('0 2 * * *', 'America/New_York', beforeDst), 1772953200);
    assert.equal(getNextRun('0 2 * * *', 'America/New_York', afterDstJump), 1773036000);
  });

  it('loadTimezone validates and follows fallback chain', async () => {
    const originalTz = process.env.TZ;
    const originalZylosDir = process.env.ZYLOS_DIR;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-tz-'));
    const envPath = path.join(tmpDir, '.env');
    try {
      process.env.ZYLOS_DIR = tmpDir;
      const { loadTimezone } = await importTimezoneModule();

      fs.writeFileSync(envPath, 'TZ=Asia/Shanghai\n', 'utf8');
      assert.equal(loadTimezone(), 'Asia/Shanghai');

      fs.writeFileSync(envPath, 'TZ=Asia/NotAZone\n', 'utf8');
      assert.throws(() => loadTimezone(), (error) => error.code === 'INVALID_TZ');

      fs.writeFileSync(envPath, 'TZ=\n', 'utf8');
      assert.throws(() => loadTimezone(), (error) => error.code === 'INVALID_TZ');

      fs.writeFileSync(envPath, 'TZ=UTC\n', 'utf8');
      fs.chmodSync(envPath, 0o000);
      assert.throws(() => loadTimezone(), (error) => error.code === 'TZ_ENV_READ_ERROR');
      fs.chmodSync(envPath, 0o644);

      fs.unlinkSync(envPath);
      process.env.TZ = 'Asia/Tokyo';
      assert.equal(loadTimezone(), 'Asia/Tokyo');

      process.env.TZ = 'Asia/NotAZone';
      assert.throws(() => loadTimezone(), (error) => error.code === 'INVALID_TZ');

      delete process.env.TZ;
      assert.equal(loadTimezone(), 'UTC');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      if (originalTz === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = originalTz;
      }
      if (originalZylosDir === undefined) {
        delete process.env.ZYLOS_DIR;
      } else {
        process.env.ZYLOS_DIR = originalZylosDir;
      }
    }
  });

  it('loadTimezone parses dotenv quoted values with inline comments', async () => {
    const originalTz = process.env.TZ;
    const originalZylosDir = process.env.ZYLOS_DIR;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-tz-dotenv-'));
    const envPath = path.join(tmpDir, '.env');
    try {
      process.env.ZYLOS_DIR = tmpDir;
      const { loadTimezone } = await importTimezoneModule();

      fs.writeFileSync(envPath, 'TZ="Asia/Shanghai" # local timezone\n', 'utf8');
      assert.equal(loadTimezone(), 'Asia/Shanghai');

      fs.writeFileSync(envPath, "TZ='America/New_York' # east coast\n", 'utf8');
      assert.equal(loadTimezone(), 'America/New_York');

      fs.writeFileSync(envPath, 'TZ="Asia/Shanghai"\n', 'utf8');
      assert.equal(loadTimezone(), 'Asia/Shanghai');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      if (originalTz === undefined) { delete process.env.TZ; } else { process.env.TZ = originalTz; }
      if (originalZylosDir === undefined) { delete process.env.ZYLOS_DIR; } else { process.env.ZYLOS_DIR = originalZylosDir; }
    }
  });

  it('loadTimezone falls back when .env has no TZ key', async () => {
    const originalTz = process.env.TZ;
    const originalZylosDir = process.env.ZYLOS_DIR;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-tz-nokey-'));
    const envPath = path.join(tmpDir, '.env');
    try {
      process.env.ZYLOS_DIR = tmpDir;
      const { loadTimezone } = await importTimezoneModule();

      fs.writeFileSync(envPath, 'DOMAIN=example.com\nOTHER=value\n', 'utf8');
      process.env.TZ = 'Europe/London';
      assert.equal(loadTimezone(), 'Europe/London');

      delete process.env.TZ;
      assert.equal(loadTimezone(), 'UTC');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      if (originalTz === undefined) { delete process.env.TZ; } else { process.env.TZ = originalTz; }
      if (originalZylosDir === undefined) { delete process.env.ZYLOS_DIR; } else { process.env.ZYLOS_DIR = originalZylosDir; }
    }
  });

  it('cmdUpdate syncs timezone column when schedule changes', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-cli-tz-'));
    const dbPath = path.join(tmpDir, 'scheduler', 'scheduler.db');
    let db;
    try {
      execFileSync('node', [CLI_PATH, 'add', 'timezone-sync', '--cron', '0 9 * * *'], {
        env: { ...process.env, ZYLOS_DIR: tmpDir, TZ: 'UTC' },
        stdio: 'pipe'
      });

      db = new Database(dbPath);
      const task = db.prepare('SELECT id, timezone FROM tasks LIMIT 1').get();
      assert.equal(task.timezone, 'UTC');

      execFileSync('node', [CLI_PATH, 'update', task.id, '--cron', '0 10 * * *'], {
        env: { ...process.env, ZYLOS_DIR: tmpDir, TZ: 'Asia/Shanghai' },
        stdio: 'pipe'
      });

      const updated = db.prepare('SELECT timezone FROM tasks WHERE id = ?').get(task.id);
      assert.equal(updated.timezone, 'Asia/Shanghai');
    } finally {
      if (db) {
        db.close();
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
