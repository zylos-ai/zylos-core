import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

import Database from 'better-sqlite3';

import { scanLegacyDonePrompts } from '../run-id-cutover-check.js';

const SCRIPT = new URL('../run-id-cutover-check.js', import.meta.url).pathname;

describe('run-id cutover check', () => {
  it('blocks per-machine cutover when stored prompts contain static done instructions', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-cutover-check-'));
    const dbPath = path.join(tmpDir, 'scheduler.db');
    const db = new Database(dbPath);
    try {
      db.exec(`
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          prompt TEXT NOT NULL
        )
      `);
      const insert = db.prepare('INSERT INTO tasks (id, type, prompt) VALUES (?, ?, ?)');
      insert.run('task-recurring-cli', 'recurring', 'Afterward run cli.js done task-recurring-cli');
      insert.run('task-interval-oral', 'interval', '完成后 scheduler done task-interval-oral');
      insert.run('task-one-time-cli', 'one-time', 'Run /scheduler/scripts/cli.js done task-one-time-cli');
      insert.run('task-cjk-tight', 'recurring', '完成后cli.js done本任务。');
      insert.run('task-middle-dot-tight', 'interval', '·cli.js done 本次。');
      insert.run('task-cjk-scheduler-tight', 'one-time', '完成后scheduler done。');
      insert.run(
        'task-mixed-same-line',
        'recurring',
        'First cli.js done task-old; replacement cli.js done task-new --run-id 42'
      );
      insert.run('task-current', 'recurring', 'Use cli.js done task-current --run-id 42');
      insert.run('task-unrelated', 'recurring', 'No completion command is stored here');

      const before = fs.readFileSync(dbPath);
      const result = scanLegacyDonePrompts(dbPath);
      const after = fs.readFileSync(dbPath);

      assert.deepEqual(result, {
        legacy_prompt_count: 8,
        recurring_interval_count: 6,
        tasks: [
          { id: 'task-cjk-scheduler-tight', type: 'one-time' },
          { id: 'task-cjk-tight', type: 'recurring' },
          { id: 'task-current', type: 'recurring' },
          { id: 'task-interval-oral', type: 'interval' },
          { id: 'task-middle-dot-tight', type: 'interval' },
          { id: 'task-mixed-same-line', type: 'recurring' },
          { id: 'task-one-time-cli', type: 'one-time' },
          { id: 'task-recurring-cli', type: 'recurring' }
        ]
      });
      const cli = spawnSync(process.execPath, [SCRIPT, '--db', dbPath, '--json'], { encoding: 'utf8' });
      assert.equal(cli.status, 1);
      assert.deepEqual(JSON.parse(cli.stdout), result);
      assert.deepEqual(after, before, 'the imported cutover gate must be read-only');
      assert.deepEqual(fs.readFileSync(dbPath), before, 'the CLI cutover gate must be read-only');
    } finally {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('blocks a stored done instruction even when it contains a fixed run ID', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-cutover-clean-'));
    const dbPath = path.join(tmpDir, 'scheduler.db');
    const db = new Database(dbPath);
    try {
      db.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY, type TEXT NOT NULL, prompt TEXT NOT NULL)');
      db.prepare('INSERT INTO tasks (id, type, prompt) VALUES (?, ?, ?)')
        .run('task-current', 'recurring', 'Use cli.js done task-current --run-id 42');

      const result = scanLegacyDonePrompts(dbPath);
      assert.deepEqual(result, {
        legacy_prompt_count: 1,
        recurring_interval_count: 1,
        tasks: [{ id: 'task-current', type: 'recurring' }]
      });
      const cli = spawnSync(process.execPath, [SCRIPT, '--db', dbPath, '--json'], { encoding: 'utf8' });
      assert.equal(cli.status, 1);
      assert.deepEqual(JSON.parse(cli.stdout), result);
    } finally {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('passes only when stored prompts contain no static done instruction', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-cutover-clean-'));
    const dbPath = path.join(tmpDir, 'scheduler.db');
    const db = new Database(dbPath);
    try {
      db.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY, type TEXT NOT NULL, prompt TEXT NOT NULL)');
      db.prepare('INSERT INTO tasks (id, type, prompt) VALUES (?, ?, ?)')
        .run('task-current', 'recurring', 'No completion command is stored here');

      const result = scanLegacyDonePrompts(dbPath);
      assert.deepEqual(result, {
        legacy_prompt_count: 0,
        recurring_interval_count: 0,
        tasks: []
      });
      const cli = spawnSync(process.execPath, [SCRIPT, '--db', dbPath, '--json'], { encoding: 'utf8' });
      assert.equal(cli.status, 0);
      assert.deepEqual(JSON.parse(cli.stdout), result);
    } finally {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
