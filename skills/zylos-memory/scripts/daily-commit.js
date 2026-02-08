#!/usr/bin/env node
/**
 * Daily memory commit helper.
 *
 * Creates a local commit for memory/ in ~/zylos if changes exist.
 */

import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { ZYLOS_DIR, loadTimezoneFromEnv, dateInTimeZone } from './shared.js';

function hasMemoryChanges() {
  const output = execFileSync('git', ['status', '--porcelain', '--', 'memory/'], {
    cwd: ZYLOS_DIR,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });

  return output.trim().length > 0;
}

function main() {
  try {
    if (!hasMemoryChanges()) {
      console.log('No memory changes to commit.');
      return;
    }

    const tz = loadTimezoneFromEnv();
    const dateStr = dateInTimeZone(new Date(), tz);
    const message = `memory: daily snapshot ${dateStr}`;

    execFileSync('git', ['add', 'memory/'], {
      cwd: ZYLOS_DIR,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const commitOutput = execFileSync('git', ['commit', '-m', message], {
      cwd: ZYLOS_DIR,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });

    process.stdout.write(commitOutput);
  } catch (err) {
    const stderr = err?.stderr?.toString?.().trim();
    const detail = stderr || err.message;

    if (detail.includes('user.name') || detail.includes('user.email')) {
      console.error(`daily-commit error: git user not configured in ${ZYLOS_DIR}. Run: git -C ${ZYLOS_DIR} config user.name "Zylos" && git -C ${ZYLOS_DIR} config user.email "zylos@local"`);
    } else {
      console.error(`daily-commit error: ${detail}`);
    }

    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
