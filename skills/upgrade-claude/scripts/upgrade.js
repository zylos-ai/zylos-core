#!/usr/bin/env node
/**
 * Upgrade Claude Code Script (C4-integrated)
 * Installs first, then requests graceful replacement sessions.
 * Usage: node upgrade.js
 *
 * IMPORTANT: Run with nohup and redirect output to log file:
 *   nohup node ~/zylos/.claude/skills/upgrade-claude/scripts/upgrade.js >> ~/zylos/logs/upgrade.log 2>&1 &
 */

import { execSync } from 'child_process';
import os from 'os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadCoreModule } from '../../activity-monitor/scripts/core-modules.js';
import { getModeTransition } from '../../comm-bridge/scripts/c4-db.js';
const { requestRuntimeRestart, enqueueSingleUpgradeExit } = await loadCoreModule('request-runtime-restart.js');
const { readSessionMode } = await loadCoreModule('config.js');

function ts() {
  return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

function log(msg) {
  console.log(`[${ts()}] [upgrade-claude] ${msg}`);
}

function logError(msg) {
  console.error(`[${ts()}] [upgrade-claude] ${msg}`);
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
  install = upgradeClaudeCode, requestRestart = requestRuntimeRestart, enqueue = enqueueExit } = {}) {
  const mode = await readMode();
  const transition = await readTransition();
  await install();
  if (mode.mode === 'multi' || transition) return requestRestart();
  const controls = await enqueue();
  return {ok:true,data:{result:'exit_enqueued',mode:'single',...controls}};
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
