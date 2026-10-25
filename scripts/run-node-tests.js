#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createTestEnvironment } from './test-environment.js';

const ROOT = process.cwd();
const TEST_ROOTS = [
  path.join(ROOT, 'cli', 'lib', '__tests__'),
  path.join(ROOT, 'cli', 'lib', 'runtime', '__tests__'),
  path.join(ROOT, 'skills', 'activity-monitor', 'scripts', '__tests__'),
  path.join(ROOT, 'skills', 'health-check', 'scripts', '__tests__'),
  path.join(ROOT, 'skills', 'comm-bridge', 'scripts', '__tests__'),
];

function walk(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, files);
    } else if (entry.isFile() && entry.name.endsWith('.test.js')) {
      files.push(fullPath);
    }
  }
  return files;
}

function isNodeTest(file) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  if (rel.startsWith('cli/lib/__tests__/')) return true;
  if (rel.startsWith('cli/lib/runtime/__tests__/')) return true;
  if (rel.startsWith('skills/activity-monitor/scripts/__tests__/')) return true;
  if (rel.startsWith('skills/health-check/scripts/__tests__/')) return true;
  if (rel.startsWith('skills/comm-bridge/scripts/__tests__/')) return true;
  return false;
}

const discoveredFiles = TEST_ROOTS
  .flatMap((dir) => walk(dir))
  .filter(isNodeTest)
  .sort()
  .map((file) => path.relative(ROOT, file));

// Explicit paths are selected only from the normal discovery roots.
const requested = process.argv.slice(2);
if (requested.length === 1 && requested[0] === '--list') {
  console.log(discoveredFiles.join('\n'));
  process.exit(0);
}
const unknown = requested.filter(file => !discoveredFiles.includes(file));
if (unknown.length) {
  console.error(`Not a discovered Node test: ${unknown.join(', ')}`);
  process.exit(1);
}
const testFiles = requested.length ? discoveredFiles.filter(file => requested.includes(file)) : discoveredFiles;

if (testFiles.length === 0) {
  console.error('No Node test files found.');
  process.exit(1);
}

console.log(`Running ${testFiles.length} Node test files`);
const environment = createTestEnvironment();
try {
  const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--test', ...testFiles], {
    stdio: 'inherit',
  });
  process.exitCode = result.status ?? 1;
} finally {
  environment.cleanup();
}
