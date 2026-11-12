#!/usr/bin/env node
/**
 * Upgrade Claude Code Script (C4-integrated)
 * Uses Supervisor restart admission in multi/transition; retains single exit ordering.
 * Usage: node upgrade.js
 *
 * IMPORTANT: Run with nohup and redirect output to log file:
 *   nohup node ~/zylos/.claude/skills/upgrade-claude/scripts/upgrade.js >> ~/zylos/logs/upgrade.log 2>&1 &
 */

import { execSync, execFileSync } from 'child_process';
import path from 'path';
import os from 'os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadCoreModule } from '../../activity-monitor/scripts/core-modules.js';
import { getModeTransition } from '../../comm-bridge/scripts/c4-db.js';
const { requestRuntimeRestart, enqueueSingleUpgradeExit, SINGLE_UPGRADE_CHECK_ACK_DEADLINE_SECONDS } = await loadCoreModule('request-runtime-restart.js');
const { readSessionMode } = await loadCoreModule('config.js');

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const C4_CONTROL = path.join(ZYLOS_DIR, '.claude/skills/comm-bridge/scripts/c4-control.js');
// Up to 120 seconds for Claude to exit, after at most the check's acknowledgment window.
const MAX_EXIT_WAIT = SINGLE_UPGRADE_CHECK_ACK_DEADLINE_SECONDS + 120;

function ts() {
  return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

function log(msg) {
  console.log(`[${ts()}] [upgrade-claude] ${msg}`);
}

function logError(msg) {
  console.error(`[${ts()}] [upgrade-claude] ${msg}`);
}

function sleep(seconds) {
  execSync(`sleep ${seconds}`);
}

// The waiting-work check is queued ahead of /exit; see enqueueSingleUpgradeExit.
async function enqueueExit() {
  try {
    const controls = await enqueueSingleUpgradeExit();
    log(`check (id=${controls.checkControlId}) and /exit (id=${controls.exitControlId}) enqueued via control queue`);
    return controls;
  } catch (err) {
    logError(`Failed to enqueue the check and /exit: ${err.message}`);
    throw err;
  }
}

function cancelExit(controls) {
  if (!controls) return;
  for (const [name, id] of [['/exit', controls.exitControlId], ['check', controls.checkControlId]]) {
    try {
      execFileSync('node', [C4_CONTROL, 'ack', '--id', String(id)], { stdio: 'pipe' });
      log(`Cancelled queued ${name} (id=${id})`);
    } catch {
      logError(`WARNING: Failed to cancel queued ${name} (id=${id})`);
    }
  }
}

function isClaudeRunning() {
  try {
    execSync('pgrep -f "claude.*--dangerously-skip-permissions" > /dev/null 2>&1');
    return true;
  } catch {
    return false;
  }
}

function waitForClaudeExit() {
  let waited = 0;

  while (waited < MAX_EXIT_WAIT) {
    if (!isClaudeRunning()) {
      log('Claude process has exited');
      return true;
    }
    sleep(2);
    waited += 2;
  }

  logError(`ABORT: Claude still running after ${MAX_EXIT_WAIT}s, upgrade cancelled`);
  return false;
}

function upgradeClaudeCode() {
  log('Starting Claude Code upgrade...');

  try {
    process.chdir(os.homedir());
    const output = execSync('curl -fsSL https://claude.ai/install.sh | bash', {
      encoding: 'utf8',
      stdio: 'pipe'
    });
    console.log(output);
    log('Upgrade completed successfully');
  } catch (err) {
    logError(`ERROR: Upgrade failed! ${err.message}`);
    throw err;
  }

  try {
    const newVersion = execSync('~/.local/bin/claude --version 2>/dev/null', {
      encoding: 'utf8'
    }).trim();
    log(`New version: ${newVersion}`);
  } catch {
    log('New version: unknown');
  }
}

export async function upgradeRuntime({ readMode = readSessionMode, readTransition = getModeTransition,
  install = upgradeClaudeCode, requestRestart = requestRuntimeRestart,
  enqueue = enqueueExit, waitForExit = waitForClaudeExit, cancel = cancelExit } = {}) {
  const mode = await readMode();
  const transition = await readTransition();
  if (mode.mode === 'multi' || transition) {
    // Runtime installers must preserve existing running processes. Validate this
    // property for each supported installer before enabling a production upgrade.
    await install();
    return requestRestart();
  }
  const controls = await enqueue();
  if (!await waitForExit()) {
    await cancel(controls);
    throw Object.assign(new Error('Runtime did not exit before upgrade deadline'), {code:'EXIT_UNCONFIRMED'});
  }
  await install();
  return {ok:true,data:{result:'installed_after_exit'}};
}

async function main() {
  log('Starting upgrade process');
  const result = await upgradeRuntime();
  if (!result.ok) throw Object.assign(new Error(result.error.message), {code:result.error.code});
  log(`Upgrade result: ${result.data.result}; replacement sessions are started by the dispatcher`);
}
function isMainModule() {
  try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}
if (isMainModule()) main().catch(error=>{
  logError(`ERROR [${error.code ?? 'UPGRADE_FAILED'}]: ${error.message}`);process.exitCode=1;
});
