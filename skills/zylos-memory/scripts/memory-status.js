#!/usr/bin/env node
/**
 * Quick memory status summary.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { MEMORY_DIR, BUDGETS } from './shared.js';

export function formatBytes(bytes) {
  if (bytes < 1024) {
    return `${bytes}B`;
  }
  return `${(bytes / 1024).toFixed(1)}KB`;
}

function fileInfo(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const stat = fs.statSync(filePath);
  return {
    sizeBytes: stat.size,
    modifiedAt: stat.mtime
  };
}

const MAX_WALK_DEPTH = 10;

function countAllFiles(dir, depth = 0) {
  if (!fs.existsSync(dir) || depth > MAX_WALK_DEPTH) {
    return [];
  }

  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...countAllFiles(fullPath, depth + 1));
    } else {
      const stat = fs.statSync(fullPath);
      out.push({ sizeBytes: stat.size });
    }
  }
  return out;
}

function main() {
  const lines = [];
  lines.push('Memory Status');
  lines.push('============');

  let overBudgetCount = 0;
  let missingCount = 0;

  for (const [name, budget] of Object.entries(BUDGETS)) {
    const info = fileInfo(path.join(MEMORY_DIR, name));
    if (!info) {
      lines.push(`${name}: MISSING`);
      missingCount += 1;
      continue;
    }

    const pct = Math.round((info.sizeBytes / budget) * 100);
    const status = info.sizeBytes > budget ? 'OVER' : 'OK';
    if (status === 'OVER') {
      overBudgetCount += 1;
    }

    const modified = info.modifiedAt.toISOString().slice(0, 16).replace('T', ' ');
    lines.push(`${name}: ${formatBytes(info.sizeBytes)} / ${formatBytes(budget)} (${pct}%) [${status}] updated ${modified}`);
  }

  const allFiles = countAllFiles(MEMORY_DIR);
  const totalBytes = allFiles.reduce((sum, item) => sum + item.sizeBytes, 0);

  lines.push('');
  lines.push(`Total files: ${allFiles.length}`);
  lines.push(`Total size: ${formatBytes(totalBytes)}`);

  const issues = [];
  if (overBudgetCount > 0) {
    issues.push(`${overBudgetCount} over budget`);
  }
  if (missingCount > 0) {
    issues.push(`${missingCount} missing`);
  }

  if (issues.length === 0) {
    lines.push('Health: good');
  } else {
    lines.push(`Health: attention needed (${issues.join(', ')})`);
  }

  process.stdout.write(`${lines.join('\n')}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
