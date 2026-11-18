#!/usr/bin/env node
/**
 * Quick memory status summary.
 */

import fs from 'fs';
import path from 'path';
import { BUDGETS, measureMemoryText } from './memory-budget.js';
import { isMainModule } from './is-main-module.js';
import { MEMORY_DIR, OPTIONAL_BUDGET_FILES, walkFiles } from './shared.js';

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


function main() {
  const lines = [];
  lines.push('Memory Status');
  lines.push('============');

  let overBudgetCount = 0;
  let warnCount = 0;
  let missingCount = 0;

  for (const [name, budget] of Object.entries(BUDGETS)) {
    const info = fileInfo(path.join(MEMORY_DIR, name));
    if (!info) {
      if (OPTIONAL_BUDGET_FILES.has(name)) lines.push(`${name}: not created yet`);
      else {
        lines.push(`${name}: MISSING`);
        missingCount += 1;
      }
      continue;
    }

    const check = measureMemoryText(name, fs.readFileSync(path.join(MEMORY_DIR, name), 'utf8'));
    if (check.status === 'over') overBudgetCount += 1;
    if (check.status === 'warning') warnCount += 1;
    const usage = typeof budget === 'number'
      ? `${formatBytes(info.sizeBytes)} / ${formatBytes(budget)}`
      : `${check.chars} / ${check.maxChars} chars; ${check.estimatedTokens} / ${check.maxTokens} estimated tokens`;
    const modified = info.modifiedAt.toISOString().slice(0, 16).replace('T', ' ');
    const status = { ok: 'OK', warning: 'WARN', over: 'OVER' }[check.status];
    lines.push(`${name}: ${usage} (${check.budgetUsagePct}%) [${status}] updated ${modified}`);
  }

  const allFiles = walkFiles(MEMORY_DIR);
  const totalBytes = allFiles.reduce((sum, item) => sum + item.sizeBytes, 0);

  lines.push('');
  lines.push(`Total files: ${allFiles.length}`);
  lines.push(`Total size: ${formatBytes(totalBytes)}`);

  const issues = [];
  if (overBudgetCount > 0) {
    issues.push(`${overBudgetCount} over budget`);
  }
  if (warnCount > 0) {
    issues.push(`${warnCount} near budget (audit on next sync)`);
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

if (isMainModule(import.meta.url)) main();
