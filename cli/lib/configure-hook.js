/**
 * Component configure hook runner.
 *
 * New components may declare lifecycle.hooks.configure in SKILL.md. Zylos
 * collects config.required values, then passes them to the hook as stdin JSON.
 * Legacy components without this hook continue to receive values through .env.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function hasConfigureHook(hooks) {
  return typeof hooks?.configure === 'string' && hooks.configure.trim() !== '';
}

export function resolveHookPath(skillDir, hookRef) {
  if (!hookRef || typeof hookRef !== 'string') return null;
  return path.resolve(skillDir, hookRef);
}

export function runConfigureHook({
  componentName,
  skillDir,
  dataDir,
  hookRef,
  configValues,
  stdio = 'inherit',
}) {
  const hookPath = resolveHookPath(skillDir, hookRef);
  if (!hookPath || !fs.existsSync(hookPath)) {
    return {
      success: false,
      error: `configure hook not found: ${hookRef}`,
      hookPath,
    };
  }

  const child = spawnSync(process.execPath, [hookPath], {
    cwd: skillDir,
    input: JSON.stringify(configValues || {}) + '\n',
    encoding: 'utf8',
    stdio: ['pipe', stdio, stdio],
    env: {
      ...process.env,
      ZYLOS_COMPONENT: componentName,
      ZYLOS_SKILL_DIR: skillDir,
      ZYLOS_DATA_DIR: dataDir,
    },
  });

  if (child.error) {
    return {
      success: false,
      error: child.error.message,
      hookPath,
    };
  }

  if (child.status !== 0) {
    return {
      success: false,
      error: `configure hook exited with code ${child.status}`,
      hookPath,
      status: child.status,
    };
  }

  return {
    success: true,
    hookPath,
  };
}
