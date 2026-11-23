import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from '../../../comm-bridge/scripts/sqlite-driver.js';

const CLI_PATH = fileURLToPath(new URL('../cli.js', import.meta.url));

function cli(args, env = {}) {
  return execFileSync('node', [CLI_PATH, ...args], {
    env: { ...process.env, ...env },
    stdio: 'pipe',
    encoding: 'utf8'
  });
}

function withTmpDir(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-cli-'));
  const home = path.join(tmpDir, 'home');
  const zylos = path.join(home, 'zylos');
  const shortTmp = path.join(tmpDir, 'tmp');
  const dbPath = path.join(zylos, 'scheduler', 'scheduler.db');
  const env = { HOME: home, ZYLOS_DIR: zylos, PM2_HOME: path.join(home, '.pm2'), TMPDIR: shortTmp,
    TMUX_TMPDIR: shortTmp, TZ: 'UTC', ZYLOS_SESSION_GROUP: 'origin' };
  fs.mkdirSync(shortTmp, { recursive: true });
  for (const name of ['telegram', 'multica']) fs.mkdirSync(path.join(zylos, '.claude/skills', name), { recursive: true });
  // Covers the real CLI entry and text behavior; run for scheduler CLI changes, skip unrelated UI work.
  // No tmux or PM2 is called; all child environment paths and the database are private and removed below.
  for (const target of [env.HOME, env.ZYLOS_DIR, env.PM2_HOME, env.TMPDIR, dbPath]) assert.ok(target.startsWith(tmpDir + path.sep));
  console.log(JSON.stringify({ schedulerCliFixture: tmpDir, ...env, database: dbPath }));
  try {
    return fn({ tmpDir, dbPath, env });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe('cli add', () => {
  it('creates a cron task with correct timezone column', () => {
    withTmpDir(({ dbPath, env }) => {
      cli(['add', 'test cron task', '--cron', '0 9 * * *'], env);
      const db = new Database(dbPath);
      try {
        const task = db.prepare('SELECT * FROM tasks LIMIT 1').get();
        assert.equal(task.type, 'recurring');
        assert.equal(task.timezone, 'UTC');
        assert.equal(task.cron_expression, '0 9 * * *');
        assert.equal(task.status, 'pending');
        assert.equal(task.priority, 3);
      } finally {
        db.close();
      }
    });
  });

  it('sets require_idle and reply fields via --block-queue-until-idle', () => {
    withTmpDir(({ dbPath, env }) => {
      cli(['add', 'idle task', '--cron', '0 2 * * *', '--block-queue-until-idle',
           '--reply-channel', 'telegram', '--reply-endpoint', '12345'], env);
      const db = new Database(dbPath);
      try {
        const task = db.prepare('SELECT * FROM tasks LIMIT 1').get();
        assert.equal(task.require_idle, 1);
        assert.equal(task.reply_channel, 'telegram');
        assert.equal(task.reply_endpoint, '12345');
      } finally {
        db.close();
      }
    });
  });

});
