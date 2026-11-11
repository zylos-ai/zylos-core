#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createTestEnvironment } from './test-environment.js';

const ROOT = process.cwd();
const ROOT_NODE_TESTS = [
  'test/history-reminders.integration.test.js',
  'test/chat-quote.integration.test.js',
  'test/test-location.test.js',
  'test/group-deletion.integration.test.js',
  'test/group-deletion-storage.integration.test.js',
  'test/reference-memory-templates.test.js',
];
const TEST_ROOTS = [
  path.join(ROOT, 'skills', 'dashboard', '__tests__'),
  path.join(ROOT, 'skills', 'web-console', 'scripts', '__tests__'),
  path.join(ROOT, 'cli', 'lib', '__tests__'),
  path.join(ROOT, 'cli', 'lib', 'runtime', '__tests__'),
  path.join(ROOT, 'skills', 'activity-monitor', 'scripts', '__tests__'),
  path.join(ROOT, 'skills', 'health-check', 'scripts', '__tests__'),
  path.join(ROOT, 'skills', 'comm-bridge', 'scripts', '__tests__'),
  path.join(ROOT, 'skills', 'scheduler', 'scripts', '__tests__'),
  path.join(ROOT, 'skills', 'zylos-memory', 'scripts', '__tests__'),
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
  if (ROOT_NODE_TESTS.includes(rel)) return true;
  // These integration entries use Jest and are selected by jest.config.js.
  if (rel === 'skills/activity-monitor/scripts/__tests__/mode-switch-admission.integration.test.js'
      || rel === 'skills/activity-monitor/scripts/__tests__/mode-switch-followup.integration.test.js') return false;
  if (rel.startsWith('skills/dashboard/__tests__/')) return true;
  if (rel.startsWith('skills/web-console/scripts/__tests__/')) return true;
  if (rel.startsWith('cli/lib/__tests__/')) return true;
  if (rel.startsWith('cli/lib/runtime/__tests__/')) return true;
  if (rel.startsWith('skills/activity-monitor/scripts/__tests__/')) return true;
  if (rel.startsWith('skills/health-check/scripts/__tests__/')) return true;
  if (rel.startsWith('skills/comm-bridge/scripts/__tests__/')) return true;
  if (rel.startsWith('skills/scheduler/scripts/__tests__/')) return true;
  if (rel.startsWith('skills/zylos-memory/scripts/__tests__/')) return true;
  return false;
}

const discoveredFiles = [...ROOT_NODE_TESTS.map(file => path.join(ROOT, file)).filter(file => fs.existsSync(file)), ...TEST_ROOTS
  .flatMap((dir) => walk(dir))
  ]
  .filter(isNodeTest)
  .sort()
  .map((file) => path.relative(ROOT, file));

// Explicit paths are selected only from the normal discovery roots.
const arguments_ = process.argv.slice(2);
if (arguments_.includes('--test-name-pattern')) {
  console.error('Use --test-name-pattern=<pattern> as one argument.');
  process.exit(1);
}
const patterns = arguments_.filter(value => value.startsWith('--test-name-pattern='));
const requested = arguments_.filter(value => !value.startsWith('--test-name-pattern='));
if (patterns.length > 1 || patterns.some(value => value === '--test-name-pattern=')) {
  console.error('Supply at most one nonempty --test-name-pattern=<pattern>.');
  process.exit(1);
}
if (requested.length === 1 && requested[0] === '--list') {
  if (patterns.length) {
    console.error('--list cannot be combined with --test-name-pattern.');
    process.exit(1);
  }
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
const tmpdir = path.join(environment.root, 'tmp');
let failed = true;
try {
  fs.mkdirSync(tmpdir);
  const env = { ...process.env, TMPDIR: tmpdir };
  // Runtime identity belongs to each fixture, never the agent running tests.
  for (const key of ['CLAUDE_SESSION_ID','CODEX_SESSION_ID','ZYLOS_RUN_ID','ZYLOS_SESSION_GROUP']) delete env[key];
  const reporter = patterns.length
    ? [`--test-reporter=${fileURLToPath(new URL('./test-match-reporter.js', import.meta.url))}`] : [];
  const nodeArgs = ['--experimental-test-module-mocks', '--test', ...reporter, ...patterns, ...testFiles];
  // Probe in subshells: unsupported special builtins must not terminate the runner.
  // Apply limits in the exec shell so Node and every test child inherit them.
  const limitScript = `
    limits_supported=true
    if (ulimit -c 0) 2>/dev/null; then ulimit -c 0; else limits_supported=false; fi
    if (ulimit -d 4194304) 2>/dev/null; then ulimit -d 4194304; else limits_supported=false; fi
    if [ "$limits_supported" = false ]; then
      printf '%s\\n' 'Warning: test process memory/core limits are not fully supported; continuing.' >&2
    fi
    exec "$0" "$@"
  `;
  const supportsShell = process.platform !== 'win32';
  if (!supportsShell) console.error('Warning: test process memory/core limits are not supported; continuing.');
  const result = spawnSync(supportsShell ? '/bin/sh' : process.execPath,
    supportsShell ? ['-c', limitScript, process.execPath, ...nodeArgs] : nodeArgs, {
    stdio: 'inherit', cwd: ROOT, env,
  });
  process.exitCode = result.status ?? 1;
  failed = process.exitCode !== 0;
} finally {
  environment.cleanup({ preserveTmp: failed });
  if (failed) console.error(`Test temporary files retained at ${tmpdir}`);
}
