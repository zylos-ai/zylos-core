#!/usr/bin/env node
/**
 * Read-only pre-install gate for the run-bound `done --run-id` protocol.
 *
 * Stored task prompts are per-machine data. A prompt can contain an old
 * completion instruction even when the dispatcher appends the new exact-run
 * command. Every matching command in the stored prompt is static, including
 * one with a fixed --run-id; the only safe exact-run command is generated at
 * dispatch time. This gate therefore blocks cutover until every stored
 * completion instruction is removed. It never prints prompt text and never
 * opens the DB for writing.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import Database from 'better-sqlite3';

const LEGACY_DONE_RE = /(?<![\w./-])(?:(?:[^\s`'"]*\/)?cli\.js|scheduler)\s+done\b/im;

function hasLegacyDoneInstruction(prompt) {
  return LEGACY_DONE_RE.test(String(prompt || ''));
}

export function scanLegacyDonePrompts(dbPath) {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Scheduler DB not found: ${dbPath}`);
  }

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare(`
      SELECT id, type, prompt
      FROM tasks
      ORDER BY id
    `).all();
    const tasks = rows
      .filter((task) => hasLegacyDoneInstruction(task.prompt))
      .map(({ id, type }) => ({ id, type }));

    return {
      legacy_prompt_count: tasks.length,
      recurring_interval_count: tasks.filter((task) =>
        task.type === 'recurring' || task.type === 'interval'
      ).length,
      tasks
    };
  } finally {
    db.close();
  }
}

function defaultDbPath() {
  const zylosDir = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
  return process.env.SCHEDULER_DB_PATH || path.join(zylosDir, 'scheduler', 'scheduler.db');
}

function readOption(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function main() {
  const dbPath = readOption('--db') || defaultDbPath();
  let result;
  try {
    result = scanLegacyDonePrompts(dbPath);
  } catch (error) {
    console.error(`Run-ID cutover check failed: ${error.message}`);
    process.exitCode = 2;
    return;
  }

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.legacy_prompt_count === 0) {
    console.log('PASS: no stored legacy scheduler done instructions found on this machine.');
  } else {
    console.error(
      `BLOCKED: ${result.legacy_prompt_count} stored prompt(s) contain a static scheduler done instruction; ` +
      `${result.recurring_interval_count} are recurring/interval. ` +
      'Update those per-machine prompts before installing the run-ID cutover.'
    );
    console.error(`Task IDs: ${result.tasks.map((task) => task.id).join(', ')}`);
  }

  if (result.legacy_prompt_count > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
