/**
 * zylos runtime — set the default agent runtime.
 *
 * Usage:
 *   zylos runtime <name>                        Set the default runtime
 *   zylos runtime status                        Show the currently configured runtime
 *   zylos runtime <name> --save-apikey <key>    Save API key and switch (all runtimes)
 *   zylos runtime <name> --save-base-url <url>  Save base URL and switch
 *   zylos runtime claude --save-setup-token <t> Save Claude setup token and switch
 *   zylos runtime <name> --no-validate          Skip switch-time auth probe
 */

import { DEFAULT_RUNTIME } from '../lib/runtime/descriptors.js';
import fs from 'node:fs';
import path from 'node:path';
import { readZylosConfigOrThrow, readZylosConfigStrict, readSessionMode, updateZylosConfigLocked, ZYLOS_DIR } from '../lib/config.js';
import { getRuntime, runtimeDisplayName, SUPPORTED_RUNTIMES } from '../lib/runtime/index.js';
import { listGroupTmuxSessions } from '../lib/session-group-paths.js';
import { desiredClaudeHooks, syncHooks, detectStopFailureSupport, detectSubagentHooksSupport } from '../lib/sync-runtime-hooks.js';
import { syncAgyConfig, isAgyConfigReady } from '../lib/agy-setup.js';
import { isCodexTrustValid, getCodexVersion } from '../lib/codex-hooks.js';
import { instructionPaths, isSplitInstructionsActive, buildInstructionFile } from '../lib/runtime/instruction-builder.js';
import { UNSUPPORTED } from '../lib/runtime/contract.js';
import { isValidBaseUrl } from '../lib/runtime-setup.js';

// ── Helpers ───────────────────────────────────────────────────────────────

const bold   = (s) => `\x1b[1m${s}\x1b[0m`;

const readLiveIdentity = async sessionGroup => (await import('../lib/session-state-reader.js')).readLiveIdentity(sessionGroup);

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
    return await showHelp();
  }

  // zylos runtime <name> [flags]
  if (SUPPORTED_RUNTIMES.includes(sub)) {
    const result = await execute(sub, args.slice(1));
    if (args.includes('--json')) console.log(JSON.stringify(result));
    else if (!result.ok) {
      for (const warning of result.error.warnings ?? []) console.error(`Warning [${warning.code}]: ${warning.message}`);
      console.error(`Error [${result.error.code}]: ${result.error.message}`);
    }
    else {
      const data = result.data;
      console.log(data.result === 'saved' ? `Baseline saved: ${data.previousBaseline} -> ${data.baseline}` : `Already on ${data.baseline} runtime.`);
      if (data.sessionMode === null) console.log('Sessions started after the first mode switch will use this baseline.');
      for (const group of data.groups) console.log(`  ${group.sessionGroup}: ${group.status}`);
      if (!data.groupsComplete) console.error('Group observation incomplete:', data.observationErrors.map(error => `${error.source}: ${error.message}`).join('; '));
      for (const warning of data.warnings) console.error(`Warning [${warning.code}]: ${warning.message}`);
    }
    if (!result.ok) process.exitCode = 1;
    return result;
  }

  if (args.includes('--json')) console.log(JSON.stringify({ ok: false, error: { code: 'RUNTIME_UNSUPPORTED', message: `Unsupported runtime: ${sub}`, persisted: [] } }));
  else { console.error(`Unknown subcommand: ${sub}`); await showHelp(); }
  process.exitCode = 1;
}

// ── Status ────────────────────────────────────────────────────────────────

function showStatus() {
  const cfg = readRuntimeConfig();
  const current = cfg.runtime ?? DEFAULT_RUNTIME;
  const label = runtimeDisplayName(current);
  console.log(`Current runtime: ${bold(label)}`);
}

// ── Credential save helpers ───────────────────────────────────────────────

export function applyCredentials(rt, creds, warnings = []) {
  const kind = creds.setupToken ? 'setupToken' : creds.apiKey ? 'apiKey' : null;
  if (!kind || rt.auth.saveCredential === UNSUPPORTED) return false;
  return rt.auth.saveCredential(kind, creds[kind], warnings);
}

export function applyBaseUrl(rt, baseUrl, warnings = []) {
  if (rt.auth.saveBaseUrl === UNSUPPORTED) return false;
  return rt.auth.saveBaseUrl(baseUrl, warnings);
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

export function validateRuntimeFlags(rt, parsed) {
  const valueFlags = new Set(['--save-apikey', '--save-setup-token', '--save-base-url']);
  const seen = new Set();
  for (let index = 0; index < (parsed.flags || []).length; index++) {
    const flag = parsed.flags[index];
    if (seen.has(flag) || (!valueFlags.has(flag) && !['--json', '--no-validate'].includes(flag))) return { error: `Invalid or duplicate option: ${flag}` };
    seen.add(flag);
    if (valueFlags.has(flag)) index++;
  }
  if (rt.auth.saveBaseUrl === UNSUPPORTED && parsed.hasBaseUrl) return { error: `--save-base-url is not supported for ${rt.id}` };
  const kinds = rt.auth.credentialKinds === UNSUPPORTED ? {} : rt.auth.credentialKinds;
  if (parsed.hasSetupToken && !Object.hasOwn(kinds, 'setupToken')) return { error: '--save-setup-token requires claude' };
  if (parsed.hasApiKey && parsed.hasSetupToken) return { error: 'Choose either API key or setup token' };
  if (parsed.hasApiKey && (!parsed.apiKey || parsed.apiKey.startsWith('--'))) {
    return {
      error: 'Missing value for --save-apikey.',
      example: `zylos runtime ${rt.id} --save-apikey ${kinds.apiKey}`,
    };
  }
  if (parsed.hasSetupToken && (!parsed.setupToken || parsed.setupToken.startsWith('--'))) {
    return {
      error: 'Missing value for --save-setup-token.',
      example: `zylos runtime ${rt.id} --save-setup-token ${kinds.setupToken}`,
    };
  }
  if (parsed.hasBaseUrl && (!parsed.baseUrl || parsed.baseUrl.startsWith('--'))) {
    return {
      error: 'Missing value for --save-base-url.',
      example: `zylos runtime ${rt.id} --save-base-url ${rt.auth.baseUrlExample}`,
    };
  }
  if (parsed.baseUrl && !isValidBaseUrl(parsed.baseUrl)) {
    return {
      error: 'Invalid base URL. Use an HTTP(S) URL without credentials, query, or fragment.',
      example: `zylos runtime ${rt.id} --save-base-url ${rt.auth.baseUrlExample}`,
    };
  }
  return null;
}

// ── Switch ────────────────────────────────────────────────────────────────

export async function runtimeHooksReady(target) {
  const instruction = instructionPaths(target, { zylosDir: ZYLOS_DIR }).outputPath;
  const pendingMigration = !isSplitInstructionsActive({ zylosDir: ZYLOS_DIR });
  if (!fs.existsSync(instruction)) return { ready: false, pendingMigration };
  if (target === 'agy') {
    return { ready: isAgyConfigReady({ zylosDir: ZYLOS_DIR }), pendingMigration };
  }
  if (target === 'codex') return { ready: isCodexTrustValid({ zylosDir: ZYLOS_DIR, projectDir: ZYLOS_DIR, codexVersion: getCodexVersion() }).valid, pendingMigration };
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(ZYLOS_DIR, '.claude', 'settings.json'), 'utf8'));
    const copy = structuredClone(settings);
    const changes = syncHooks(copy, null, { zylosDir: ZYLOS_DIR, dryRun: true, log: () => {},
      desiredHooks: desiredClaudeHooks({ stopFailureSupported: detectStopFailureSupport(), subagentHooksSupported: detectSubagentHooksSupport() }) });
    return { ready: changes.added + changes.updated + changes.removed === 0, pendingMigration };
  } catch { return { ready: false, pendingMigration }; }
}

export async function observeRuntimeGroups(baseline, sessionMode, { list = listGroupTmuxSessions,
  overrides = async () => (await import('../../skills/comm-bridge/scripts/c4-db.js')).listGroupRuntimeOverrides(),
  identity = readLiveIdentity } = {}) {
  const result = { groups: [], groupsComplete: true, observationErrors: [] };
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
    try { if (sessionMode !== 'single' || sessionGroup === 'origin') live = await identity(sessionGroup); }
    catch (cause) { error = { code: 'READ_FAILED', message: cause.message }; failures('session', sessionGroup, cause); }
    const liveRuntime = live?.present ? live.runtime : null;
    const status = inherits === false ? 'override_kept' : inherits === null || error || liveRuntime === 'unknown' || (live?.present && !live.launchConfig)
      ? 'unknown' : liveRuntime === null ? 'not_running' : liveRuntime === baseline ? 'effective' : 'pending_reclaim';
    result.groups.push({ sessionGroup, inherits, liveRuntime, status, error });
  }
  return result;
}

export async function executeRuntimeSwitch(target, flags, { read = readZylosConfigStrict, mode = readSessionMode,
  runtimeFor = getRuntime, prepareCli, credentials = applyCredentials, baseUrl = applyBaseUrl,
  hooksReady = runtimeHooksReady, write = updateZylosConfigLocked, observe = observeRuntimeGroups,
} = {}) {
  const credentialsSaved = [], warnings = [];
  // A failure after a save keeps the warnings collected so far (for example a
  // settings.json key that overrides the saved credential and fails the probe).
  const fail = (code, message, extra = {}) => ({ ok: false, error: { code, message, persisted: [...credentialsSaved],
    ...(warnings.length ? { warnings: [...warnings] } : {}), ...extra } });
  const parsed = parseRuntimeFlags(flags);
  if (!SUPPORTED_RUNTIMES.includes(target)) return fail('RUNTIME_UNSUPPORTED', 'Unsupported runtime');
  let selected;
  try { selected = await runtimeFor(target); } catch (error) { return fail('RUNTIME_UNSUPPORTED', error.message); }
  const invalid = validateRuntimeFlags(selected, parsed);
  if (invalid) return fail('INVALID_ARGUMENT', invalid.error);
  let config;
  try {
    const result = read();
    if (result.state === 'error') return fail('CONFIG_UNREADABLE', result.error?.message || 'Cannot read configuration');
    config = result.state === 'ok' ? result.config : {};
  } catch (error) { return fail('CONFIG_UNREADABLE', error.message); }
  let previousBaseline = config.runtime ?? DEFAULT_RUNTIME;
  let baseline = previousBaseline, changed = false;
  const fullPath = previousBaseline !== target || parsed.hasApiKey || parsed.hasSetupToken || parsed.hasBaseUrl;
  if (fullPath) {
    if (selected.identity.findExecutable() === null) {
      try {
        const { installCliOnUse } = await import('./init.js');
        const installation = await installCliOnUse(selected, { prepare: prepareCli });
        if (!installation.attempted) return fail('RUNTIME_NOT_INSTALLED', `${target} CLI missing; run zylos init`);
        if (!installation.ok) return fail('RUNTIME_NOT_INSTALLED', installation.message);
        for (const { message } of installation.notices) {
          warnings.push({ code: 'RUNTIME_CLI_INSTALL_NOTICE', message });
        }
      } catch (error) {
        return fail('RUNTIME_NOT_INSTALLED', error.message);
      }
    }
    try {
      for (const [key, value, save] of [
        ['apiKey', parsed.apiKey, () => credentials(selected, { apiKey: parsed.apiKey }, warnings)],
        ['setupToken', parsed.setupToken, () => credentials(selected, { setupToken: parsed.setupToken }, warnings)],
        ['baseUrl', parsed.baseUrl, () => baseUrl(selected, parsed.baseUrl, warnings)],
      ]) {
        if (value) { if (!await save()) return fail('CREDENTIAL_SAVE_FAILED', `Could not save ${key}`); credentialsSaved.push(key); }
      }
    } catch (error) { return fail('CREDENTIAL_SAVE_FAILED', error.message); }
    if (credentialsSaved.includes('setupToken') && !parsed.baseUrl && selected.auth.afterLogin !== UNSUPPORTED) {
      warnings.push(...(await selected.auth.afterLogin()).warnings);
    }
    if (credentialsSaved.length && selected.auth.overrideWarnings !== UNSUPPORTED) {
      warnings.push(...selected.auth.overrideWarnings({ against: 'saved' }));
    }
    const name = runtimeDisplayName(target);
    const file = instructionPaths(target, { zylosDir: ZYLOS_DIR }).outputPath;
    try { buildInstructionFile(target, { zylosDir: ZYLOS_DIR }); }
    catch (error) { return fail('INSTRUCTIONS_UNAVAILABLE', `Could not rebuild ${file}: ${error.message}`); }
    if (!fs.existsSync(file)) {
      return fail('INSTRUCTIONS_UNAVAILABLE', 'Instruction file unavailable; run zylos migrate-instructions');
    }

    let ready;
    try {
      if (target === 'agy') {
        syncAgyConfig({ zylosDir: ZYLOS_DIR });
      }
      ready = await hooksReady(target);
    } catch (error) {
      return fail('RUNTIME_SETUP_INCOMPLETE', `Could not check Zylos setup for ${name}: ${error.message}`);
    }
    if (!ready.ready) {
      return fail('RUNTIME_SETUP_INCOMPLETE', `Zylos setup for ${name} is missing or out of date; run zylos init`);
    }
    if (ready.pendingMigration) warnings.push({ code: 'INSTRUCTION_PENDING_MIGRATION', message: 'Instruction migration pending; run zylos migrate-instructions' });
    if (parsed.noValidate) warnings.push({ code: 'AUTH_CHECK_SKIPPED', message: 'Authentication check skipped (--no-validate)' });
    else {
      let auth;
      try { auth = await selected.auth.checkAuth(); } catch { auth = { status: 'uncertain' }; }
      if (auth.status !== 'success') {
        const rejected = auth.status === 'failure';
        const message = rejected
          ? `${target} credentials rejected or not logged in; ${selected.auth.remedy}`
          : `${target} authentication could not be confirmed; check network/proxy connectivity, then retry zylos runtime ${target}`;
        return fail(rejected ? 'AUTH_FAILED' : 'AUTH_NOT_CONFIRMED', message, { authStatus: rejected ? 'failure' : 'uncertain' });
      }
    }
    try {
      const saved = write({ set: { runtime: target } });
      previousBaseline = saved.previous.runtime ?? DEFAULT_RUNTIME; baseline = saved.config.runtime ?? DEFAULT_RUNTIME;
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
  try { observed = sessionMode === null
    ? { groups: [], groupsComplete: true, observationErrors: [] }
    : await observe(baseline, sessionMode); }
  catch (error) { observed = { groups: [], groupsComplete: false, observationErrors: [{ source: 'session', sessionGroup: null, code: 'READ_FAILED', message: error.message }] }; }
  return { ok: true, data: { result: changed ? 'saved' : 'unchanged', previousBaseline, baseline,
    credentialsSaved, sessionMode, ...observed, warnings } };
}

function readRuntimeConfig() {
  return readZylosConfigOrThrow();
}

// ── Help ──────────────────────────────────────────────────────────────────

export async function showHelp() {
  const authenticationOptions = [];
  const remedies = [];
  for (const id of SUPPORTED_RUNTIMES) {
    const { auth } = await getRuntime(id);
    const [first, ...rest] = auth.cliHelp;
    if (first !== undefined) {
      authenticationOptions.push(`  ${(id + ':').padEnd(9)}${first}`);
      authenticationOptions.push(...rest.map(line => `           ${line}`));
    }
    remedies.push(`       ${id}: ${auth.remedy}`);
  }
  console.log(`
zylos runtime — set the default agent runtime

Usage:
  zylos runtime <name>                        Set the default runtime
  zylos runtime status                        Show currently configured runtime
  zylos runtime <name> --save-apikey <key>    Save API key and switch
  zylos runtime <name> --save-base-url <url>  Save base URL and switch
  zylos runtime claude --save-setup-token <t> Save Claude setup token and switch
  zylos runtime <name> --no-validate          Skip switch-time auth probe

Supported runtimes:
  claude    Claude Code (Anthropic) — default
  codex     Codex CLI (OpenAI)
  agy       Antigravity CLI (Google, Gemini API key only)

Authentication options (if not already authenticated):
${authenticationOptions.join('\n')}

Validation:
  --no-validate skips only the switch-time auth probe. Use it for prepared,
  mocked, or gateway contexts where the target runtime cannot be probed yet.

Exit codes:
  0  Success
  1  Failed; AUTH_FAILED requires new credentials or login:
${remedies.join('\n')}
     AUTH_NOT_CONFIRMED requires checking network/proxy before retrying

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
