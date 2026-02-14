#!/usr/bin/env node
/**
 * Daily memory commit helper.
 *
 * Creates a local commit in ~/zylos/memory/ if changes exist.
 */

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { MEMORY_DIR, loadTimezoneFromEnv, dateInTimeZone } from './shared.js';

function ensureGitRepo() {
  if (fs.existsSync(path.join(MEMORY_DIR, '.git'))) {
    return;
  }
  console.log(`Initializing git repo in ${MEMORY_DIR}`);
  execFileSync('git', ['init'], {
    cwd: MEMORY_DIR,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  execFileSync('git', ['config', 'user.name', 'Zylos'], {
    cwd: MEMORY_DIR,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  execFileSync('git', ['config', 'user.email', 'zylos@local'], {
    cwd: MEMORY_DIR,
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function hasMemoryChanges() {
  const output = execFileSync('git', ['status', '--porcelain'], {
    cwd: MEMORY_DIR,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });

  return output.trim().length > 0;
}

function main() {
  try {
    ensureGitRepo();

    if (!hasMemoryChanges()) {
      console.log('No memory changes to commit.');
      return;
    }

    const tz = loadTimezoneFromEnv();
    const dateStr = dateInTimeZone(new Date(), tz);
    const message = `memory: daily snapshot ${dateStr}`;

    execFileSync('git', ['add', '.'], {
      cwd: MEMORY_DIR,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const commitOutput = execFileSync('git', ['commit', '-m', message], {
      cwd: MEMORY_DIR,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });

    process.stdout.write(commitOutput);
  } catch (err) {
    const stderr = err?.stderr?.toString?.().trim();
    const detail = stderr || err.message;

    if (detail.includes('user.name') || detail.includes('user.email')) {
      console.error(`daily-commit error: git user not configured in ${MEMORY_DIR}. Run: git -C ${MEMORY_DIR} config user.name "Zylos" && git -C ${MEMORY_DIR} config user.email "zylos@local"`);
    } else {
      console.error(`daily-commit error: ${detail}`);
    }

    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
