/** Per-HOME Antigravity configuration. Only the Zylos hook and MCP entries are managed. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ZYLOS_DIR } from './config.js';
import { writePrivateFile } from './private-file.js';

function objectFile(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object');
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw Object.assign(new Error(`Cannot merge Antigravity configuration: ${file}`, { cause: error }), { code: 'AGY_CONFIG_UNREADABLE' });
  }
}

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

export function agyConfigurationPaths(home = os.homedir()) {
  const gemini = path.join(home, '.gemini');
  return {
    settings: path.join(gemini, 'antigravity-cli/settings.json'),
    hooks: path.join(gemini, 'config/hooks.json'),
    mcp: path.join(gemini, 'config/mcp_config.json'),
    onboarding: path.join(gemini, 'antigravity-cli/cache/onboarding.json'),
  };
}

export function syncAgyConfig({ zylosDir = ZYLOS_DIR, home = os.homedir(), dryRun = false } = {}) {
  const root = path.resolve(zylosDir);
  const files = agyConfigurationPaths(home);
  // Read every file before writing any, so malformed user configuration is never replaced.
  const current = Object.fromEntries(Object.entries(files).map(([key, file]) => [key, objectFile(file)]));
  if (current.mcp.mcpServers !== undefined && (!current.mcp.mcpServers || typeof current.mcp.mcpServers !== 'object' || Array.isArray(current.mcp.mcpServers))) {
    throw Object.assign(new Error('Cannot merge Antigravity MCP servers'), { code: 'AGY_CONFIG_UNREADABLE' });
  }
  const command = event => `node ${quote(path.join(root, '.claude/skills/activity-monitor/scripts/agy-hooks.js'))} ${event}`;
  const desired = {
    settings: { ...current.settings, modelProvider: 'gemini', userDataCollectionForceDisabled: true,
      statusLine: { ...current.settings.statusLine, type: 'command', command: `node ${quote(path.join(root, '.claude/skills/activity-monitor/scripts/context-monitor.js'))}` } },
    hooks: { ...current.hooks, zylos: {
      ...Object.fromEntries(['SessionStart', 'PreInvocation', 'Stop'].map(event => [event, [{ type: 'command', command: command(event), timeout: 60 }]])),
      PreToolUse: [{ matcher: '^ask_question$', hooks: [{ type: 'command',
        command: `node ${quote(path.join(root, '.claude/skills/activity-monitor/scripts/agy-tool-guard.js'))}`, timeout: 60 }] }],
    } },
    mcp: { ...current.mcp, mcpServers: { ...current.mcp.mcpServers, 'zylos-memory': { command: 'node', args: [path.join(root, '.claude/skills/zylos-memory/scripts/memory-mcp-server.js')] } } },
    onboarding: { ...current.onboarding, consumerOnboardingComplete: true, onboardingComplete: true },
  };
  const changedFiles = Object.keys(files).filter(key => JSON.stringify(current[key]) !== JSON.stringify(desired[key]));
  if (!dryRun) {
    for (const key of changedFiles) {
      fs.mkdirSync(path.dirname(files[key]), { recursive: true });
      writePrivateFile(files[key], JSON.stringify(desired[key], null, 2) + '\n');
    }
  }
  return { changed: changedFiles.length > 0, files: changedFiles.map(key => files[key]) };
}

export function isAgyConfigReady(options) {
  try { return !syncAgyConfig({ ...options, dryRun: true }).changed; }
  catch { return false; }
}

/** Existing Zylos hooks identify an opted-in HOME; unrelated agy settings are left alone. */
export function hasAgyZylosHooks(home = os.homedir()) {
  try { return Object.hasOwn(objectFile(agyConfigurationPaths(home).hooks), 'zylos'); }
  catch { return false; }
}
