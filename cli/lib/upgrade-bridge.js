import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { discoverUpgradeContext } from './runtime/upgrade-context.js';

export function upgradeBridgeFailure(error, { code = 'UPGRADE_FAILED', next } = {}) {
  return {
    success: false,
    code,
    error: String(error || 'Upgrade failed'),
    persisted: [],
    ...(next ? { next } : {}),
  };
}

export function resumeUnfinishedUpgrade(zylosDir, {
  discover = discoverUpgradeContext,
} = {}) {
  const context = discover(zylosDir, { resume: true, scanHistory: true });
  if (!context.active && !context.recovery_required) return { success: true };

  const manual = context.automaticResume === false || context.code === 'MANUAL_RECOVERY_REQUIRED';
  const next = context.next || 'zylos recovery status';
  return {
    success: false,
    failure: upgradeBridgeFailure(
      context.error || 'An unfinished upgrade transaction must be recovered before starting a new upgrade.',
      { code: manual ? 'MANUAL_RECOVERY_REQUIRED' : 'UPGRADE_RECOVERY_REQUIRED', next },
    ),
  };
}

export function validateDownloadedCore(tempDir) {
  for (const relative of ['package.json', path.join('cli', 'lib', 'upgrade-entry.js')]) {
    const file = path.join(tempDir, relative);
    try {
      if (!fs.statSync(file).isFile()) throw new Error('not a file');
    } catch {
      return upgradeBridgeFailure(`Downloaded package is incomplete: ${relative} is missing or is not a file.`);
    }
  }
  return { success: true };
}

export function runDownloadedUpgrade({
  tempDir,
  fromVersion,
  installedRoot,
  zylosDir,
}, { spawn = spawnSync } = {}) {
  const handoff = { schemaVersion: 1, fromVersion, tempDir, installedRoot, zylosDir };
  const entry = path.join(tempDir, 'cli', 'lib', 'upgrade-entry.js');
  const child = spawn(process.execPath, [entry], {
    input: JSON.stringify(handoff),
    encoding: 'utf8',
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  return Number.isInteger(child.status) ? child.status : 1;
}
