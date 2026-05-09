import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, it } from 'node:test';

const LAUNCHER_PATH = path.resolve(import.meta.dirname, '..', 'runtime', 'tmux-launcher.js');

const tmpFiles = [];
afterEach(() => {
  while (tmpFiles.length) {
    try { fs.unlinkSync(tmpFiles.pop()); } catch { }
  }
});

function writeSpec(spec) {
  const specPath = path.join(os.tmpdir(), `.zylos-test-spec-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(specPath, JSON.stringify(spec), { mode: 0o600 });
  tmpFiles.push(specPath);
  return specPath;
}

describe('tmux-launcher', () => {
  it('exits with code 0 when child exits 0', () => {
    const specPath = writeSpec({
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
      cwd: os.tmpdir(),
    });

    execFileSync(process.execPath, [LAUNCHER_PATH, specPath], {
      timeout: 10_000,
      encoding: 'utf8',
    });
    tmpFiles.pop(); // spec was deleted by launcher
    // If we get here without throw, exit code was 0
  });

  it('exits with child error code', () => {
    const specPath = writeSpec({
      command: process.execPath,
      args: ['-e', 'process.exit(42)'],
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
      cwd: os.tmpdir(),
    });

    try {
      execFileSync(process.execPath, [LAUNCHER_PATH, specPath], {
        timeout: 10_000,
        encoding: 'utf8',
      });
      assert.fail('Should have thrown');
    } catch (err) {
      assert.equal(err.status, 42);
    }
    tmpFiles.pop(); // spec was deleted by launcher
  });

  it('deletes spec file before spawn', () => {
    // Use a child that checks if the spec file still exists
    const specPath = path.join(os.tmpdir(), `.zylos-test-spec-delete-${Date.now()}.json`);
    const checkScript = `
      const fs = require('fs');
      const exists = fs.existsSync(${JSON.stringify(specPath)});
      if (exists) {
        process.stderr.write('SPEC_STILL_EXISTS');
        process.exit(99);
      }
      process.exit(0);
    `;

    fs.writeFileSync(specPath, JSON.stringify({
      command: process.execPath,
      args: ['-e', checkScript],
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
      cwd: os.tmpdir(),
    }), { mode: 0o600 });

    execFileSync(process.execPath, [LAUNCHER_PATH, specPath], {
      timeout: 10_000,
      encoding: 'utf8',
    });
    // If child exited 0, spec was deleted before spawn
  });

  it('exits with 128+signal when child is signaled', () => {
    // Spawn a child that kills itself with SIGTERM
    const specPath = writeSpec({
      command: process.execPath,
      args: ['-e', 'process.kill(process.pid, "SIGTERM")'],
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
      cwd: os.tmpdir(),
    });

    try {
      execFileSync(process.execPath, [LAUNCHER_PATH, specPath], {
        timeout: 10_000,
        encoding: 'utf8',
      });
      assert.fail('Should have thrown');
    } catch (err) {
      // SIGTERM = 15, so exit code should be 128 + 15 = 143
      assert.equal(err.status, 143, `Expected exit code 143 (128+SIGTERM), got ${err.status}`);
    }
    tmpFiles.pop();
  });

  it('writes exit log when exitLogFile is set', () => {
    const exitLog = path.join(os.tmpdir(), `.zylos-test-exit-log-${Date.now()}`);
    tmpFiles.push(exitLog);

    const specPath = writeSpec({
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
      cwd: os.tmpdir(),
      exitLogFile: exitLog,
    });

    execFileSync(process.execPath, [LAUNCHER_PATH, specPath], {
      timeout: 10_000,
      encoding: 'utf8',
    });
    tmpFiles.pop(); // spec deleted

    const logContent = fs.readFileSync(exitLog, 'utf8');
    assert.ok(logContent.includes('exit_code=0'), `Exit log should contain exit_code=0: ${logContent}`);
  });
});
