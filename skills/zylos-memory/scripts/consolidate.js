#!/usr/bin/env node
/**
 * Consolidation report for memory health.
 *
 * Scans ~/zylos/memory for sizes, ages, and budget compliance.
 * Outputs JSON report.
 */

import fs from 'fs';
import path from 'path';
import { MEMORY_DIR, SESSIONS_DIR, BUDGETS, loadTimezoneFromEnv, dateInTimeZone } from './shared.js';

function walkFiles(rootDir, prefix = '') {
  const out = [];

  if (!fs.existsSync(rootDir)) {
    return out;
  }

  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) {
      continue;
    }

    const fullPath = path.join(rootDir, entry.name);
    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      out.push(...walkFiles(fullPath, relPath));
      continue;
    }

    const stat = fs.statSync(fullPath);
    out.push({
      path: relPath,
      sizeBytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      ageDays: Math.floor((Date.now() - stat.mtimeMs) / (1000 * 60 * 60 * 24))
    });
  }

  return out;
}

function parseSessionDate(fileName) {
  const match = fileName.match(/^(\d{4}-\d{2}-\d{2})(?:-\d+)?\.md$/);
  return match ? match[1] : null;
}

function sessionArchiveCandidates(tz) {
  const candidates = [];

  if (!fs.existsSync(SESSIONS_DIR)) {
    return candidates;
  }

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - 30);
  const cutoffStr = dateInTimeZone(cutoffDate, tz);

  for (const fileName of fs.readdirSync(SESSIONS_DIR)) {
    if (fileName === 'current.md' || fileName.startsWith('.')) {
      continue;
    }

    const sessionDate = parseSessionDate(fileName);
    if (!sessionDate) {
      continue;
    }

    if (sessionDate < cutoffStr) {
      candidates.push(fileName);
    }
  }

  candidates.sort();
  return candidates;
}

function coreBudgetChecks() {
  const checks = [];

  for (const [name, budget] of Object.entries(BUDGETS)) {
    const filePath = path.join(MEMORY_DIR, name);
    if (!fs.existsSync(filePath)) {
      checks.push({ file: name, exists: false, budgetBytes: budget, overBudget: false });
      continue;
    }

    const stat = fs.statSync(filePath);
    checks.push({
      file: name,
      exists: true,
      sizeBytes: stat.size,
      budgetBytes: budget,
      overBudget: stat.size > budget,
      budgetUsagePct: Math.round((stat.size / budget) * 100),
      modifiedAt: stat.mtime.toISOString()
    });
  }

  return checks;
}

function topLargest(files, count = 10) {
  return [...files]
    .sort((a, b) => b.sizeBytes - a.sizeBytes)
    .slice(0, count);
}

function main() {
  const tz = loadTimezoneFromEnv();
  const files = walkFiles(MEMORY_DIR);
  const budgetChecks = coreBudgetChecks();
  const overBudget = budgetChecks.filter((item) => item.overBudget).map((item) => item.file);

  const report = {
    timestamp: new Date().toISOString(),
    memoryDir: MEMORY_DIR,
    totals: {
      files: files.length,
      sizeBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0)
    },
    budgets: {
      rules: BUDGETS,
      checks: budgetChecks,
      overBudget
    },
    sessions: {
      archiveCandidatesOlderThan30Days: sessionArchiveCandidates(tz)
    },
    oldestFiles: [...files].sort((a, b) => b.ageDays - a.ageDays).slice(0, 10),
    largestFiles: topLargest(files),
    recommendations: []
  };

  if (overBudget.length > 0) {
    report.recommendations.push(`Trim over-budget core files: ${overBudget.join(', ')}`);
  }

  if (report.sessions.archiveCandidatesOlderThan30Days.length > 0) {
    report.recommendations.push('Move old session logs from sessions/ into archive/.');
  }

  if (report.recommendations.length === 0) {
    report.recommendations.push('No immediate consolidation action required.');
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main();
