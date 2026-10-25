/**
 * zylos runtime — switch agent runtime without re-running full init.
 *
 * Usage:
 *   zylos runtime <name>                        Switch to the specified runtime (claude|codex)
 *   zylos runtime status                        Show the currently configured runtime
 *   zylos runtime <name> --save-apikey <key>    Save API key and switch (all runtimes)
 *   zylos runtime <name> --save-base-url <url>  Save base URL and switch
 *   zylos runtime claude --save-setup-token <t> Save Claude setup token and switch
 *   zylos runtime <name> --no-validate          Skip switch-time auth probe
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { readZylosConfigOrThrow, readZylosConfigStrict, readSessionMode, updateZylosConfigLocked, ZYLOS_DIR } from '../lib/config.js';
import { getSessionAdapter, SUPPORTED_RUNTIMES } from '../lib/runtime/index.js';
import { listGroupTmuxSessions } from '../lib/session-group-paths.js';
import { readLiveIdentity } from '../lib/session-state-reader.js';
import { desiredClaudeHooks, syncHooks, detectStopFailureSupport } from '../lib/sync-runtime-hooks.js';
import { isCodexTrustValid, getCodexVersion } from '../lib/codex-hooks.js';
import { isSplitInstructionsActive } from '../lib/runtime/instruction-builder.js';
import { commandExists } from '../lib/shell-utils.js';
import { getCoreEcosystemPath, restartManagedProcess } from '../lib/pm2.js';
import {
  isValidBaseUrl,
  saveApiKey,
  saveApiKeyToEnv,
  saveClaudeBaseUrlToSettingsAndEnv,
  saveSetupToken,
  saveSetupTokenToEnv,
  saveCodexApiKey,
  saveCodexBaseUrlToEnv,
  saveCodexApiKeyToEnv,
  writeCodexConfig,
} from '../lib/runtime-setup.js';

// ── Helpers ───────────────────────────────────────────────────────────────

const green  = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const red    = (s) => `\x1b[31m${s}\x1b[0m`;
const bold   = (s) => `\x1b[1m${s}\x1b[0m`;
const dim    = (s) => `\x1b[2m${s}\x1b[0m`;
const cyan   = (s) => `\x1b[36m${s}\x1b[0m`;

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Entry point for `zylos runtime [subcommand|name]`.
 *
 * @param {string[]} args - CLI args after "runtime"
 */
export async function runtimeCommand(args, { execute = executeRuntimeSwitch } = {}) {
  const sub = args[0];

  if (!sub || sub === 'status') {
    return showStatus();
  }

  if (sub === '--help' || sub === '-h' || sub === 'help') {
    return showHelp();
  }

  // zylos runtime <name> [flags]
  if (SUPPORTED_RUNTIMES.includes(sub)) {
    const result = await execute(sub, args.slice(1));
    if (args.includes('--json')) console.log(JSON.stringify(result));
    else if (!result.ok) console.error(`Error [${result.error.code}]: ${result.error.message}`);
    else {
      const data = result.data;
      console.log(data.result === 'saved' ? `Baseline saved: ${data.previousBaseline} -> ${data.baseline}` : `Already on ${data.baseline} runtime.`);
      for (const group of data.groups) console.log(`  ${group.sessionGroup}: ${group.status}`);
      if (!data.groupsComplete) console.error('Group observation incomplete:', data.observationErrors.map(error => `${error.source}: ${error.message}`).join('; '));
      for (const warning of data.warnings) console.error(`Warning [${warning.code}]: ${warning.message}`);
    }
    if (!result.ok) process.exitCode = 1;
    return result;
  }

  if (args.includes('--json')) console.log(JSON.stringify({ ok: false, error: { code: 'RUNTIME_UNSUPPORTED', message: `Unsupported runtime: ${sub}`, persisted: [] } }));
  else { console.error(`Unknown subcommand: ${sub}`); showHelp(); }
  process.exitCode = 1;
}

// ── Status ────────────────────────────────────────────────────────────────

function showStatus() {
  const cfg = readRuntimeConfig();
  const current = cfg.runtime ?? 'claude';
  const label = current === 'codex' ? 'Codex (OpenAI)' : 'Claude Code (Anthropic)';
  console.log(`Current runtime: ${bold(label)}`);
}



// ── Credential save helpers ───────────────────────────────────────────────

/**
 * Save credentials for the target runtime and write to .env.
 * Returns true on success, false on failure.
 *
 * @param {string} target - 'claude' | 'codex'
 * @param {{ apiKey?: string, setupToken?: string }} creds
 * @returns {boolean}
 */
function applyCredentials(target, creds) {
  if (target === 'claude') {
    if (creds.setupToken) {
      if (!saveSetupToken(creds.setupToken)) return false;
      saveSetupTokenToEnv(creds.setupToken);
      return true;
    }
    if (creds.apiKey) {
      if (!saveApiKey(creds.apiKey)) return false;
      saveApiKeyToEnv(creds.apiKey);
      return true;
    }
  } else if (target === 'codex') {
    if (creds.apiKey) {
      return saveCodexApiKey(creds.apiKey);
    }
  }
  return false;
}

export function applyBaseUrl(target, baseUrl) {
  if (target === 'claude') {
    return saveClaudeBaseUrlToSettingsAndEnv(baseUrl);
  }
  if (target === 'codex') {
    if (!saveCodexBaseUrlToEnv(baseUrl)) return false;
    return writeCodexConfig(ZYLOS_DIR, { openaiBaseUrl: baseUrl });
  }
  return false;
}

export function parseRuntimeFlags(flags) {
  const apiKeyIdx = flags.indexOf('--save-apikey');
  const setupTokenIdx = flags.indexOf('--save-setup-token');
  const baseUrlIdx = flags.indexOf('--save-base-url');

  return {
    flags,
    apiKey: apiKeyIdx >= 0 ? flags[apiKeyIdx + 1] : null,
    setupToken: setupTokenIdx >= 0 ? flags[setupTokenIdx + 1] : null,
    baseUrl: baseUrlIdx >= 0 ? flags[baseUrlIdx + 1] : null,
    hasApiKey: apiKeyIdx >= 0,
    hasSetupToken: setupTokenIdx >= 0,
    hasBaseUrl: baseUrlIdx >= 0,
    noValidate: flags.includes('--no-validate'),
  };
}

export function validateRuntimeFlags(target, parsed) {
  const valueFlags = new Set(['--save-apikey', '--save-setup-token', '--save-base-url']);
  const seen = new Set();
  for (let index = 0; index < (parsed.flags || []).length; index++) {
    const flag = parsed.flags[index];
    if (seen.has(flag) || (!valueFlags.has(flag) && !['--json', '--no-validate'].includes(flag))) return { error: `Invalid or duplicate option: ${flag}` };
    seen.add(flag);
    if (valueFlags.has(flag)) index++;
  }
  if (target !== 'claude' && parsed.hasSetupToken) return { error: '--save-setup-token requires claude' };
  if (parsed.hasApiKey && parsed.hasSetupToken) return { error: 'Choose either API key or setup token' };
  if (parsed.hasApiKey && (!parsed.apiKey || parsed.apiKey.startsWith('--'))) {
    return {
      error: 'Missing value for --save-apikey.',
      example: target === 'codex'
        ? 'zylos runtime codex --save-apikey sk-proj-xxx'
        : 'zylos runtime claude --save-apikey sk-ant-api-xxx',
    };
  }
  if (parsed.hasSetupToken && (!parsed.setupToken || parsed.setupToken.startsWith('--'))) {
    return {
      error: 'Missing value for --save-setup-token.',
      example: 'zylos runtime claude --save-setup-token sk-ant-oat-xxx',
    };
  }
  if (parsed.hasBaseUrl && (!parsed.baseUrl || parsed.baseUrl.startsWith('--'))) {
    return {
      error: 'Missing value for --save-base-url.',
      example: target === 'codex'
        ? 'zylos runtime codex --save-base-url https://proxy.example.com/v1'
        : 'zylos runtime claude --save-base-url https://claude-proxy.example.com',
    };
  }
  if (parsed.baseUrl && !isValidBaseUrl(parsed.baseUrl)) {
    return {
      error: `Invalid base URL: "${parsed.baseUrl}".`,
      example: target === 'codex'
        ? 'zylos runtime codex --save-base-url https://proxy.example.com/v1'
        : 'zylos runtime claude --save-base-url https://claude-proxy.example.com',
    };
  }
  return null;
}

export function restartRuntimeServices({
  services = ['activity-monitor', 'c4-dispatcher'],
  ecosystemPath = getCoreEcosystemPath(),
  restartManagedProcessFn = restartManagedProcess,
  logSuccess = console.log,
  logWarning = console.error,
} = {}) {
  for (const svc of services) {
    try {
      restartManagedProcessFn(svc, {
        ecosystemPath,
        stdio: 'pipe',
        fallbackToPlainRestartOnError: true,
      });
      logSuccess(`  ${green('✓')} ${svc}`);
    } catch (e) {
      logWarning(`  ${yellow(`Warning: failed to restart ${svc} — ${e.message}`)}`);
    }
  }
}


// ── Switch ────────────────────────────────────────────────────────────────

export async function runtimeHooksReady(target) {
  const instruction = path.join(ZYLOS_DIR, target === 'codex' ? 'AGENTS.md' : 'CLAUDE.md');
  const pendingMigration = !isSplitInstructionsActive({ zylosDir: ZYLOS_DIR });
  if (!fs.existsSync(instruction)) return { ready: false, pendingMigration };
  if (target === 'codex') return { ready: isCodexTrustValid({ zylosDir: ZYLOS_DIR, projectDir: ZYLOS_DIR, codexVersion: getCodexVersion() }).valid, pendingMigration };
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(ZYLOS_DIR, '.claude', 'settings.json'), 'utf8'));
    const copy = structuredClone(settings);
    const changes = syncHooks(copy, null, { zylosDir: ZYLOS_DIR, dryRun: true, log: () => {},
      desiredHooks: desiredClaudeHooks({ stopFailureSupported: detectStopFailureSupport() }) });
    return { ready: changes.added + changes.updated + changes.removed === 0, pendingMigration };
  } catch { return { ready: false, pendingMigration }; }
}

export async function observeRuntimeGroups(baseline, sessionMode, { list = listGroupTmuxSessions,
  overrides = async () => (await import('../../skills/comm-bridge/scripts/c4-db.js')).listGroupRuntimeOverrides(),
  identity = readLiveIdentity } = {}) {
  const result = { groups: [], groupsComplete: true, observationErrors: [] };
  if (sessionMode === null || sessionMode === 'single') return result;
  const names = new Set(['origin']);
  const failures = (source, sessionGroup, error) => {
    result.groupsComplete = false;
    result.observationErrors.push({ source, sessionGroup, code: 'READ_FAILED', message: error.message });
  };
  try { for (const row of await list()) names.add(row.sessionGroup); } catch (error) { failures('tmux', null, error); }
  let configured;
  try { configured = await overrides(); for (const row of configured) names.add(row.sessionGroup); }
  catch (error) { failures('overrides', null, error); }
  for (const sessionGroup of [...names].sort()) {
    const inherits = configured ? !configured.some(row => row.sessionGroup === sessionGroup) : null;
    let live = null, error = null;
    try { live = await identity(sessionGroup); }
    catch (cause) { error = { code: 'READ_FAILED', message: cause.message }; failures('session', sessionGroup, cause); }
    const liveRuntime = live?.present ? live.runtime : null;
    const status = inherits === false ? 'override_kept' : inherits === null || error || liveRuntime === 'unknown' || (live?.present && !live.launchConfig)
      ? 'unknown' : liveRuntime === null ? 'not_running' : liveRuntime === baseline ? 'effective' : 'pending_reclaim';
    result.groups.push({ sessionGroup, inherits, liveRuntime, status, error });
  }
  return result;
}

export async function executeRuntimeSwitch(target, flags, { read = readZylosConfigStrict, mode = readSessionMode,
  exists = commandExists, adapter = getSessionAdapter, credentials = applyCredentials, baseUrl = applyBaseUrl,
  hooksReady = runtimeHooksReady, write = updateZylosConfigLocked, observe = observeRuntimeGroups,
  restart = restartRuntimeServices } = {}) {
  const credentialsSaved = [], warnings = [];
  const fail = (code, message, extra = {}) => ({ ok: false, error: { code, message, persisted: [...credentialsSaved], ...extra } });
  const parsed = parseRuntimeFlags(flags);
  if (!SUPPORTED_RUNTIMES.includes(target)) return fail('RUNTIME_UNSUPPORTED', 'Unsupported runtime');
  const invalid = validateRuntimeFlags(target, parsed);
  if (invalid) return fail('INVALID_ARGUMENT', invalid.error);
  let selected;
  try { selected = adapter(target); } catch (error) { return fail('RUNTIME_UNSUPPORTED', error.message); }
  let config;
  try {
    const result = read();
    if (result.state === 'error') return fail('CONFIG_UNREADABLE', result.error?.message || 'Cannot read configuration');
    config = result.state === 'ok' ? result.config : {};
  } catch (error) { return fail('CONFIG_UNREADABLE', error.message); }
  let previousBaseline = config.runtime ?? 'claude';
  let baseline = previousBaseline, changed = false;
  const fullPath = previousBaseline !== target || parsed.hasApiKey || parsed.hasSetupToken || parsed.hasBaseUrl;
  if (fullPath) {
    if (!exists(target)) return fail('RUNTIME_NOT_INSTALLED', `${target} CLI missing; run zylos init`);
    try {
      for (const [key, value, save] of [
        ['apiKey', parsed.apiKey, () => credentials(target, { apiKey: parsed.apiKey })],
        ['setupToken', parsed.setupToken, () => credentials(target, { setupToken: parsed.setupToken })],
        ['baseUrl', parsed.baseUrl, () => baseUrl(target, parsed.baseUrl)],
      ]) {
        if (value) { if (!await save()) return fail('CREDENTIAL_SAVE_FAILED', `Could not save ${key}`); credentialsSaved.push(key); }
      }
    } catch (error) { return fail('CREDENTIAL_SAVE_FAILED', error.message); }
    try {
      const ready = await hooksReady(target);
      if (!ready.ready) return fail('HOOKS_NOT_READY', 'Runtime hooks/instructions not ready; run zylos init');
      if (ready.pendingMigration) warnings.push({ code: 'INSTRUCTION_PENDING_MIGRATION', message: 'Instruction migration pending; run zylos migrate-instructions' });
    }
    catch (error) { return fail('HOOKS_NOT_READY', error.message); }
    if (parsed.noValidate) warnings.push({ code: 'AUTH_CHECK_SKIPPED', message: 'Authentication check skipped (--no-validate)' });
    else {
      let auth;
      try { auth = await selected.checkAuth(); } catch { auth = { status: 'uncertain' }; }
      if (auth.status !== 'success') return fail('AUTH_NOT_CONFIRMED', `${target} authentication not confirmed; run zylos auth ${target}`, { authStatus: auth.status === 'failure' ? 'failure' : 'uncertain' });
    }
    try {
      const saved = write({ set: { runtime: target } });
      previousBaseline = saved.previous.runtime ?? 'claude'; baseline = saved.config.runtime ?? 'claude';
      config = saved.config; changed = saved.changed;
    } catch (error) {
      return fail(error.code || 'CONFIG_WRITE_FAILED', error.message, { ...(error.phase ? { phase: error.phase } : {}),
        ...(error.phase === 'after_rename' ? { persisted: null, persistedBeforeConfig: [...credentialsSaved] } : {}) });
    }
  }
  let sessionMode;
  try { sessionMode = fullPath ? config.session_mode ?? null : mode().mode;
    if (![null, 'single', 'multi'].includes(sessionMode)) sessionMode = 'unreadable'; }
  catch { sessionMode = 'unreadable'; }
  let observed;
  try { observed = await observe(baseline, sessionMode); }
  catch (error) { observed = { groups: [], groupsComplete: false, observationErrors: [{ source: 'session', sessionGroup: null, code: 'READ_FAILED', message: error.message }] }; }
  if (fullPath && (sessionMode === null || sessionMode === 'single')) {
    try { restart({ logSuccess: () => {}, logWarning: message => warnings.push({ code: 'SERVICE_RESTART_FAILED', message }) }); }
    catch (error) { warnings.push({ code: 'SERVICE_RESTART_FAILED', message: error.message }); }
  }
  return { ok: true, data: { result: changed ? 'saved' : 'unchanged', previousBaseline, baseline,
    credentialsSaved, sessionMode, ...observed, warnings } };
}

function readRuntimeConfig() {
  return readZylosConfigOrThrow();
}

// ── Help ──────────────────────────────────────────────────────────────────

export function showHelp() {
  console.log(`
zylos runtime — switch agent runtime

Usage:
  zylos runtime <name>                        Switch to the specified runtime
  zylos runtime status                        Show currently configured runtime
  zylos runtime <name> --save-apikey <key>    Save API key and switch
  zylos runtime <name> --save-base-url <url>  Save base URL and switch
  zylos runtime claude --save-setup-token <t> Save Claude setup token and switch
  zylos runtime <name> --no-validate          Skip switch-time auth probe

Supported runtimes:
  claude    Claude Code (Anthropic) — default
  codex     Codex CLI (OpenAI)

Authentication options (if not already authenticated):
  Claude:  --save-apikey <sk-ant-api...>   Anthropic API key
           --save-base-url <url>           Claude base URL
           --save-setup-token <sk-ant-oat...>  Setup token
           claude auth login               Browser OAuth (then retry)
  Codex:   --save-apikey <sk-...>          OpenAI API key
           --save-base-url <url>           Codex base URL
           codex login --device-auth       Device auth (headless)
           codex login                     Browser login (then retry)

Validation:
  --no-validate skips only the switch-time auth probe. Use it for prepared,
  mocked, or gateway contexts where the target runtime cannot be probed yet.

Exit codes:
  0  Success
  1  Failed; AUTH_NOT_CONFIRMED requires zylos auth <runtime>

Examples:
  zylos runtime status
  zylos runtime codex
  zylos runtime claude --save-apikey sk-ant-api-xxx
  zylos runtime claude --save-base-url https://claude-proxy.example.com
  zylos runtime claude --save-setup-token sk-ant-oat-xxx
  zylos runtime codex --save-apikey sk-proj-xxx
  zylos runtime codex --save-base-url https://proxy.example.com/v1
  zylos runtime codex --no-validate
`);
}
