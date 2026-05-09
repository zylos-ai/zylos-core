#!/usr/bin/env node

/**
 * tmux-launcher.js — Minimal CLI entry point for launching agent runtimes.
 *
 * Usage: node tmux-launcher.js <spec.json>
 *
 * Reads the spec file, deletes it (unlink-before-spawn), spawns the agent
 * process with the spec's env, and transparently forwards the exit code.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const SIGNAL_NUMBERS = {
  SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGTERM: 15, SIGKILL: 9,
};

const specPath = process.argv[2];
if (!specPath) {
  process.stderr.write('Usage: node tmux-launcher.js <spec.json>\n');
  process.exit(1);
}

// 1. Read spec
let spec;
try {
  const content = fs.readFileSync(specPath, 'utf8');
  // 2. Delete before spawn
  fs.unlinkSync(specPath);
  spec = JSON.parse(content);
} catch (err) {
  process.stderr.write(`Failed to read/parse spec: ${err.message}\n`);
  process.exit(1);
}

// 3. Spawn child
const child = spawn(spec.command, spec.args || [], {
  env: spec.env || {},
  cwd: spec.cwd || process.cwd(),
  stdio: 'inherit',
});

// Signal forwarding
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(sig, () => child.kill(sig));
}

// 4. Exit code transparency
child.on('exit', (code, signal) => {
  // Write exit log if configured
  if (spec.exitLogFile) {
    try {
      const ts = new Date().toISOString();
      const line = `[${ts}] exit_code=${code ?? 'null'} signal=${signal ?? 'null'}\n`;
      fs.appendFileSync(spec.exitLogFile, line);
    } catch { /* non-fatal */ }
  }

  if (signal) {
    const sigNum = SIGNAL_NUMBERS[signal] || 1;
    process.exit(128 + sigNum);
  }
  process.exit(code ?? 1);
});

child.on('error', (err) => {
  process.stderr.write(`Failed to spawn: ${err.message}\n`);
  process.exit(1);
});
