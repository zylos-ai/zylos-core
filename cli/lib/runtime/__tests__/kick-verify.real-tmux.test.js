// Real-process negative/positive controls for the first-start marker boundary
// (#743 review): an isolated tmux server plus the real tmux-launcher.js and
// the verifier's real /proc + pgrep defaults. This is the discriminating test
// the mocked launch suite cannot provide — a launch whose tmux commands all
// return 0 but whose Codex child never (or only momentarily) exists must not
// count as a confirmed start. Skipped when tmux is unavailable.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createKickVerifier } from '../kick-verify.js';

const KICK = '[ZYLOS_INTERNAL_SESSION_START] lifecycle=first_boot. Internal lifecycle trigger, not a human message. Real-tmux boundary test.';

let hasTmux = true;
try {
  execFileSync('tmux', ['-V'], { stdio: 'ignore', timeout: 3000 });
} catch {
  hasTmux = false;
}

const SOCKET = `zylos-kick-test-${process.pid}`;
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-kick-real-'));
const launcherPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'tmux-launcher.js',
);

function tmux(...args) {
  return execFileSync('tmux', ['-L', SOCKET, ...args], {
    encoding: 'utf8',
    timeout: 5000,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

function isolatedPanePid(session) {
  try {
    const out = tmux('list-panes', '-t', session, '-F', '#{pane_pid}').trim();
    const pid = parseInt(out.split('\n')[0], 10);
    return Number.isInteger(pid) && pid > 0 ? pid : 0;
  } catch {
    return 0;
  }
}

// Default listChildPids/readArgv (real pgrep + /proc); only the pane lookup
// is redirected to the isolated tmux server.
function makeVerifier(session) {
  return createKickVerifier({ getPanePid: () => isolatedPanePid(session) });
}

function writeSpec(name, spec) {
  const specPath = path.join(tmpRoot, name);
  fs.writeFileSync(specPath, JSON.stringify(spec));
  return specPath;
}

after(() => {
  try {
    execFileSync('tmux', ['-L', SOCKET, 'kill-server'], { stdio: 'ignore', timeout: 5000 });
  } catch { /* server already gone */ }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('kick-verify against real tmux', { skip: !hasTmux }, () => {
  it('confirms a pane child that stays alive with the kick argv (paste-path shape)', async () => {
    tmux('new-session', '-d', '-s', 'kv-alive',
      `node -e 'setTimeout(function(){},30000)' '${KICK}'`);
    const ok = await makeVerifier('kv-alive')({
      session: 'kv-alive', kickPrompt: KICK, timeoutMs: 8000,
    });
    assert.equal(ok, true);
  });

  it('rejects a pane child that exits immediately (broken CODEX_BIN, paste-path shape)', async () => {
    tmux('new-session', '-d', '-s', 'kv-broken',
      `node -e 'process.exit(1)' '${KICK}'; sleep 15`);
    const ok = await makeVerifier('kv-broken')({
      session: 'kv-broken', kickPrompt: KICK, timeoutMs: 2500,
    });
    assert.equal(ok, false);
  });

  it('rejects a real tmux-launcher whose command is missing — tmux rc 0, pane dies (review repro)', async () => {
    const specPath = writeSpec('spec-missing.json', {
      command: '/nonexistent-codex-bin-for-kick-verify-test',
      args: [KICK],
      env: { PATH: '/usr/bin:/bin' },
      cwd: tmpRoot,
    });
    // tmux itself reports success — exactly the evidence the old call point
    // trusted when it committed the marker.
    tmux('new-session', '-d', '-s', 'kv-missing',
      `"${process.execPath}" "${launcherPath}" "${specPath}"`);
    const ok = await makeVerifier('kv-missing')({
      session: 'kv-missing', kickPrompt: KICK, timeoutMs: 2500,
    });
    assert.equal(ok, false);
  });

  it('confirms a real tmux-launcher whose child spawns and survives (new-session-path shape)', async () => {
    const specPath = writeSpec('spec-alive.json', {
      command: process.execPath,
      args: ['-e', 'setTimeout(function(){},30000)', KICK],
      env: { PATH: '/usr/bin:/bin' },
      cwd: tmpRoot,
    });
    tmux('new-session', '-d', '-s', 'kv-launcher-alive',
      `"${process.execPath}" "${launcherPath}" "${specPath}"`);
    const ok = await makeVerifier('kv-launcher-alive')({
      session: 'kv-launcher-alive', kickPrompt: KICK, timeoutMs: 8000,
    });
    assert.equal(ok, true);
  });
});
