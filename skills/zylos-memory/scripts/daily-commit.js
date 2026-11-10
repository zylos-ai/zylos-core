#!/usr/bin/env node
/**
 * Daily memory commit helper.
 *
 * Creates a local commit in ~/zylos/memory/ if changes exist. Files larger than
 * MAX_FILE_BYTES are left out of the commit and listed in the output: git
 * streams files above core.bigFileThreshold (512 MB) into a pack while adding
 * them, and a failed add leaves that partial pack behind.
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

// GitHub rejects files over 100 MB; memory files are text of a few KB to MB.
const MAX_FILE_BYTES = 50 * 1024 * 1024;

/** Paths `git status` reports as changed or untracked (each file inside an untracked directory). */
function changedPaths() {
  const output = execFileSync('git', ['status', '--porcelain', '-z', '--untracked-files=all'], {
    cwd: MEMORY_DIR,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const fields = output.split('\0');
  const paths = [];
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
    // A rename or copy is followed by its source path.
    if (/[RC]/.test(entry.slice(0, 2))) i++;
  }
  return [...new Set(paths)];
}

/** Changed regular files above MAX_FILE_BYTES, with their sizes. */
function oversizedFiles(paths) {
  const oversized = [];
  for (const relative of paths) {
    let stat;
    try {
      stat = fs.lstatSync(path.join(MEMORY_DIR, relative));
    } catch {
      continue; // deleted
    }
    if (stat.isFile() && stat.size > MAX_FILE_BYTES) oversized.push({ path: relative, size: stat.size });
  }
  return oversized;
}

function describeSkipped(oversized) {
  const shown = oversized.slice(0, 10).map(file => `${file.path} (${Math.round(file.size / 1024 / 1024)} MB)`);
  const more = oversized.length > shown.length ? `, and ${oversized.length - shown.length} more` : '';
  return `Skipped ${oversized.length} file(s) over ${MAX_FILE_BYTES / 1024 / 1024} MB, not committed: ${shown.join(', ')}${more}`;
}

function hasStagedChanges() {
  try {
    execFileSync('git', ['diff', '--cached', '--quiet'], { cwd: MEMORY_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
    return false;
  } catch (err) {
    if (err.status === 1) return true;
    throw err;
  }
}

function main() {
  let skipped = '';
  try {
    ensureGitRepo();

    const paths = changedPaths();
    if (paths.length === 0) {
      console.log('No memory changes to commit.');
      return;
    }

    const oversized = oversizedFiles(paths);
    if (oversized.length > 0) {
      skipped = describeSkipped(oversized);
      console.log(skipped);
    }

    const tz = loadTimezoneFromEnv();
    const dateStr = dateInTimeZone(new Date(), tz);
    const message = `memory: daily snapshot ${dateStr}`;

    execFileSync('git', ['add', '--', '.', ...oversized.map(file => `:(exclude,literal)${file.path}`)], {
      cwd: MEMORY_DIR,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    // A file staged before this run (by hand, or by an earlier `git add .` whose commit failed) is still in the
    // index despite the exclude: put it back to its committed state so it is not committed either.
    if (oversized.length > 0) {
      execFileSync('git', ['reset', '-q', '--', ...oversized.map(file => `:(literal)${file.path}`)], {
        cwd: MEMORY_DIR,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    }

    if (!hasStagedChanges()) {
      console.log('No memory changes to commit.');
      return;
    }

    const commitOutput = execFileSync('git', ['commit', '-m', message], {
      cwd: MEMORY_DIR,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });

    process.stdout.write(commitOutput);
  } catch (err) {
    const stderr = err?.stderr?.toString?.().trim();
    const detail = stderr || err.message;

    // A failed run is logged from stderr only (and may be truncated): say first what was left out.
    if (skipped) console.error(skipped);

    if (detail.includes('user.name') || detail.includes('user.email')) {
      console.error(`daily-commit error: git user not configured in ${MEMORY_DIR}. Run: git -C ${MEMORY_DIR} config user.name "Zylos" && git -C ${MEMORY_DIR} config user.email "zylos@local"`);
    } else {
      console.error(`daily-commit error: ${detail}`);
    }

    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
