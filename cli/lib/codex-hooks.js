import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { parse, stringify } from 'smol-toml';
import { SIDE_EFFECT_NAMES, buildChain } from '../../skills/activity-monitor/scripts/shard-registry.js';
import { extractScriptPath } from './hook-utils.js';

const SESSION_START = 'SessionStart';
const CODEX_EVENT_KEYS = {
  SessionStart: 'session_start',
  PreToolUse: 'pre_tool_use',
  PostToolUse: 'post_tool_use',
  UserPromptSubmit: 'user_prompt_submit',
  Stop: 'stop',
  PermissionRequest: 'permission_request',
};

const DEFAULT_TRUST_TIMEOUT_MS = 15_000;
// The trust helper keeps only this much of the app-server's stderr: enough context to redact the reported tail,
// and far below spawnSync's 1 MiB output buffer, so a chatty Codex cannot turn the result into ENOBUFS.
const TRUST_HELPER_STDERR_KEEP = 16_384;
const DEFAULT_HOOK_TIMEOUT_SECONDS = 25;

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function parseToml(content = '') {
  if (!content.trim()) return {};
  try {
    return parse(content);
  } catch {
    return {};
  }
}

function stringifyToml(obj) {
  return stringify(obj);
}

function isSection(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stable(value[key])])
  );
}

function stableJson(value) {
  return JSON.stringify(stable(value));
}

function eventKey(event) {
  return CODEX_EVENT_KEYS[event]
    || String(event || '').replace(/[A-Z]/g, (m, i) => `${i ? '_' : ''}${m.toLowerCase()}`);
}

export function codexHooksPath(zylosDir) {
  return path.join(path.resolve(zylosDir), '.codex', 'hooks.json');
}

export function codexTrustMarkerPath(zylosDir) {
  return path.join(path.resolve(zylosDir), '.codex', 'hooks.trust.json');
}

export function codexProjectConfigPath(projectDir) {
  return path.join(path.resolve(projectDir), '.codex', 'config.toml');
}

export function codexGlobalConfigPath(homeDir = os.homedir(), codexHome) {
  return path.join(codexHome || path.join(homeDir, '.codex'), 'config.toml');
}

export function coreSessionStartCommand(zylosDir) {
  const script = path.join(
    path.resolve(zylosDir),
    '.claude',
    'skills',
    'activity-monitor',
    'scripts',
    'session-start-orchestrator.js'
  );
  return `node ${script}`;
}

/**
 * One command per injection shard plus the two side-effect steps, in chain
 * order. Codex injects hook output in CONFIG order (measured — the opposite
 * of Claude Code's completion order), so the array order here IS the
 * injection order there; the flag chain still runs as a second, redundant
 * guarantee with identical semantics on both runtimes.
 */
export function coreSessionStartCommands(zylosDir) {
  const base = coreSessionStartCommand(zylosDir);
  const { chain } = buildChain({ zylosDir });
  const names = [
    ...chain.map(shard => shard.name),
    SIDE_EFFECT_NAMES.foreground,
    SIDE_EFFECT_NAMES.startPrompt,
  ];
  return names.map(name => `${base} --shard ${name}`);
}

export function isCoreCodexHook(command, zylosDir) {
  if (!command) return false;
  const scriptsDir = path.join(
    path.resolve(zylosDir),
    '.claude',
    'skills',
    'activity-monitor',
    'scripts'
  );
  return typeof command === 'string' && ['session-start-orchestrator.js', 'hook-activity.js']
    .some(name => path.resolve(extractScriptPath(command)) === path.join(scriptsDir, name));
}

export function readCodexHooksConfig(filePath) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }

  if (!Array.isArray(raw)) return raw && typeof raw === 'object' ? raw : {};

  const config = { hooks: {} };
  for (const entry of raw) {
    if (!entry?.event || !entry?.command) continue;
    const event = entry.event;
    if (!Array.isArray(config.hooks[event])) config.hooks[event] = [];
    const hook = { type: 'command', command: entry.command };
    if (entry.timeout != null) hook.timeout = entry.timeout;
    if (entry.async != null) hook.async = entry.async;
    const group = { hooks: [hook] };
    if (entry.matcher != null) group.matcher = entry.matcher;
    config.hooks[event].push(group);
  }
  return config;
}

export function installCoreCodexHook({ zylosDir, dryRun = false, onWrite = () => {} }) {
  const filePath = codexHooksPath(zylosDir);
  const config = readCodexHooksConfig(filePath);
  config.hooks = isSection(config.hooks) ? config.hooks : {};
  const before = stableJson(config);

  const commands = coreSessionStartCommands(zylosDir);
  const desiredHooks = commands.map(command => ({
    type: 'command',
    command,
    timeout: DEFAULT_HOOK_TIMEOUT_SECONDS,
  }));

  // Reconcile: strip every core-managed hook (including the retired no-arg
  // orchestrator command and stale shard sets), keep non-core groups intact,
  // then install the full desired shard command set as one group. Config
  // order is injection order on Codex, so the group must stay contiguous
  // and chain-ordered.
  const activityCommand = `node ${path.join(path.resolve(zylosDir), '.claude', 'skills',
    'activity-monitor', 'scripts', 'hook-activity.js')}`;
  for (const event of Object.keys(CODEX_EVENT_KEYS)) {
    const existing = Array.isArray(config.hooks[event]) ? config.hooks[event] : [];
    const preserved = existing
      .map((group) => {
        if (!Array.isArray(group?.hooks)) return group;
        return { ...group, hooks: group.hooks.filter(h => !isCoreCodexHook(h?.command, zylosDir)) };
      })
      .filter(group => !Array.isArray(group?.hooks) || group.hooks.length > 0);
    config.hooks[event] = [
      ...preserved,
      ...(event === SESSION_START ? [{ hooks: desiredHooks }] : []),
      { hooks: [{ type: 'command', command: activityCommand, timeout: DEFAULT_HOOK_TIMEOUT_SECONDS }] },
    ];
  }

  const changed = stableJson(config) !== before;
  if (changed && !dryRun) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(config, null, 2) + '\n');
    onWrite(filePath);
  }

  return { path: filePath, changed, commands };
}

export function uninstallCoreCodexHook({ zylosDir }) {
  const filePath = codexHooksPath(zylosDir);
  const config = readCodexHooksConfig(filePath);
  if (!isSection(config.hooks)) return { path: filePath, removed: 0 };

  let removed = 0;
  for (const event of Object.keys(config.hooks)) {
    if (!Array.isArray(config.hooks[event])) continue;
    config.hooks[event] = config.hooks[event]
      .map((group) => {
        if (!Array.isArray(group?.hooks)) return group;
        const before = group.hooks.length;
        const hooks = group.hooks.filter(h => !isCoreCodexHook(h?.command, zylosDir));
        removed += before - hooks.length;
        return { ...group, hooks };
      })
      .filter(group => !Array.isArray(group?.hooks) || group.hooks.length > 0);
    if (config.hooks[event].length === 0) delete config.hooks[event];
  }

  if (removed > 0) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(config, null, 2) + '\n');
  }
  return { path: filePath, removed };
}

export function ensureHooksFeatureInToml(content = '') {
  const obj = parseToml(content);
  obj.features = isSection(obj.features) ? obj.features : {};
  obj.features.hooks = true;
  return stringifyToml(obj);
}

export function ensureHooksFeatureAtPath(filePath) {
  let existing = '';
  try {
    existing = fs.readFileSync(filePath, 'utf8');
  } catch { /* new file */ }
  const next = ensureHooksFeatureInToml(existing);
  if (next !== existing) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, next, 'utf8');
    return { path: filePath, changed: true };
  }
  return { path: filePath, changed: false };
}

export function ensureHooksFeature({ projectDir, homeDir = os.homedir(), codexHome }) {
  const paths = [
    codexProjectConfigPath(projectDir),
    codexGlobalConfigPath(homeDir, codexHome),
  ];
  const results = paths.map(ensureHooksFeatureAtPath);
  return {
    changed: results.some(r => r.changed),
    paths,
    results,
  };
}

export function hooksFeatureEnabledAtPath(filePath) {
  let content = '';
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return false;
  }
  const obj = parseToml(content);
  return obj?.features?.hooks === true;
}

export function readHooksState(globalConfigPath) {
  let content = '';
  try {
    content = fs.readFileSync(globalConfigPath, 'utf8');
  } catch {
    return {};
  }
  const obj = parseToml(content);
  const state = obj?.hooks?.state;
  return isSection(state) ? state : {};
}

export function extractTrustSnapshot(hooksState = {}, hooksPath = '') {
  const prefix = hooksPath ? `${hooksPath}:` : '';
  const out = {};
  for (const [key, value] of Object.entries(hooksState || {})) {
    if (prefix && !key.startsWith(prefix)) continue;
    if (!value || typeof value !== 'object') continue;
    out[key] = {
      enabled: value.enabled === true,
      trusted_hash: value.trusted_hash || '',
    };
  }
  return stable(out);
}

function readTrustMarker(markerPath) {
  try {
    return JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  } catch {
    return null;
  }
}

function writeTrustMarker(markerPath, marker) {
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(markerPath, JSON.stringify(stable(marker), null, 2) + '\n', { mode: 0o600 });
}

export function getCodexVersion({ codexBin = process.env.CODEX_BIN || 'codex', execFileSyncImpl } = {}) {
  const execImpl = execFileSyncImpl || execFileSync;
  return String(execImpl(codexBin, ['--version'], {
    encoding: 'utf8',
    timeout: 10_000,
    stdio: 'pipe',
  })).trim();
}

export function isCodexTrustValid({
  zylosDir,
  projectDir = zylosDir,
  homeDir = os.homedir(),
  codexHome,
  codexVersion,
} = {}) {
  const hooksPath = codexHooksPath(zylosDir);
  const markerPath = codexTrustMarkerPath(zylosDir);
  const globalConfig = codexGlobalConfigPath(homeDir, codexHome);
  const projectConfig = codexProjectConfigPath(projectDir);
  let hooksContent = '';
  try {
    hooksContent = fs.readFileSync(hooksPath, 'utf8');
  } catch {
    return { valid: false, reason: 'missing_hooks_json' };
  }

  if (!hooksFeatureEnabledAtPath(projectConfig)) return { valid: false, reason: 'project_hooks_feature_off' };
  if (!hooksFeatureEnabledAtPath(globalConfig)) return { valid: false, reason: 'global_hooks_feature_off' };

  const marker = readTrustMarker(markerPath);
  if (!marker) return { valid: false, reason: 'missing_marker' };
  if (marker.hooksHash !== sha256(hooksContent)) return { valid: false, reason: 'hooks_json_changed' };
  if (marker.codexVersion !== codexVersion) return { valid: false, reason: 'codex_version_changed' };

  const currentSnapshot = extractTrustSnapshot(readHooksState(globalConfig), hooksPath);
  if (stableJson(currentSnapshot) !== stableJson(marker.trustSnapshot || {})) {
    return { valid: false, reason: 'trust_snapshot_changed' };
  }

  return { valid: true, reason: 'trusted' };
}

export function hookKeyFor({ zylosDir, event, groupIndex, hookIndex }) {
  return `${codexHooksPath(zylosDir)}:${eventKey(event)}:${groupIndex}:${hookIndex}`;
}

export function trustCodexHooksWithAppServer({
  zylosDir,
  codexBin = process.env.CODEX_BIN || 'codex',
  spawnSyncImpl = spawnSync,
  timeoutMs = DEFAULT_TRUST_TIMEOUT_MS,
} = {}) {
  const helper = String.raw`
const { spawn } = require('node:child_process');

const cwd = process.env.ZYLOS_CODEX_TRUST_CWD;
const codexBin = process.env.ZYLOS_CODEX_BIN || 'codex';
const app = spawn(codexBin, ['app-server', '--listen', 'stdio://'], {
  cwd,
  stdio: ['pipe', 'pipe', 'pipe']
});

let stdout = '';
let stderr = '';
let nextId = 0;
let finished = false;
let trustedCount = 0;
let candidateCount = 0;
let missingHashCount = 0;

function send(method, params) {
  const id = nextId++;
  app.stdin.write(JSON.stringify({ method, id, params }) + '\n');
  return id;
}

function notify(method, params) {
  app.stdin.write(JSON.stringify({ method, params }) + '\n');
}

function finish(result) {
  if (finished) return;
  finished = true;
  try { app.kill('SIGTERM'); } catch {}
  process.stdout.write(JSON.stringify(result) + '\n');
}

const timer = setTimeout(() => {
  finish({ ok: false, reason: 'codex_app_server_timeout', stderr });
}, ${timeoutMs});

app.stderr.on('data', d => { stderr = (stderr + d.toString()).slice(-${TRUST_HELPER_STDERR_KEEP}); });
app.on('error', err => {
  clearTimeout(timer);
  finish({ ok: false, reason: 'codex_app_server_error', error: String(err), stderr });
});
app.on('exit', code => {
  if (!finished) {
    clearTimeout(timer);
    finish({ ok: false, reason: 'codex_app_server_exit', code, stderr });
  }
});

app.stdout.on('data', chunk => {
  stdout += chunk.toString();
  const lines = stdout.split('\n');
  stdout = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }

    if (msg.id === 0) {
      notify('initialized', {});
      send('hooks/list', { cwds: [cwd] });
      continue;
    }

    if (msg.id === 1) {
      if (msg.error) {
        clearTimeout(timer);
        finish({ ok: false, reason: 'hooks_list_error', error: msg.error, stderr });
        return;
      }

      const state = {};
      for (const entry of msg.result?.data || []) {
        for (const hook of entry.hooks || []) {
          if (hook.isManaged || !hook.key) continue;
          candidateCount++;
          if (!hook.currentHash) {
            missingHashCount++;
            continue;
          }
          state[hook.key] = { enabled: true, trusted_hash: hook.currentHash };
        }
      }

      trustedCount = Object.keys(state).length;
      send('config/batchWrite', {
        edits: [{
          keyPath: 'hooks.state',
          value: state,
          mergeStrategy: 'upsert'
        }],
        reloadUserConfig: true
      });
      continue;
    }

    if (msg.id === 2) {
      clearTimeout(timer);
      if (msg.error) {
        finish({ ok: false, reason: 'config_batch_write_error', error: msg.error, stderr });
      } else {
        finish({
          ok: true,
          trusted: trustedCount,
          candidates: candidateCount,
          missingHash: missingHashCount,
          status: msg.result?.status || 'ok'
        });
      }
    }
  }
});

send('initialize', {
  clientInfo: {
    name: 'zylos_core_codex_hook_trust',
    title: 'Zylos Core Codex Hook Trust',
    version: '0.1.0'
  },
  capabilities: { experimentalApi: true }
});
`;

  const result = spawnSyncImpl(process.execPath, ['-e', helper], {
    cwd: zylosDir,
    env: {
      ...process.env,
      ZYLOS_CODEX_TRUST_CWD: zylosDir,
      ZYLOS_CODEX_BIN: codexBin,
    },
    encoding: 'utf8',
    timeout: timeoutMs,
  });

  if (result.error) return { ok: false, reason: 'trust_helper_error', error: String(result.error) };
  if (result.status !== 0) {
    return {
      ok: false,
      reason: 'trust_helper_exit',
      status: result.status,
      stderr: result.stderr?.trim(),
    };
  }

  const line = result.stdout?.trim().split('\n').filter(Boolean).pop();
  if (!line) return { ok: false, reason: 'trust_helper_no_output' };
  try {
    return JSON.parse(line);
  } catch (error) {
    return { ok: false, reason: 'trust_helper_bad_output', error: String(error), stdout: result.stdout?.trim() };
  }
}

const TRUST_ERROR_MESSAGE_LIMIT = 300;
const TRUST_STDERR_TAIL_LIMIT = 600;
const TRUST_ERROR_CODE_LIMIT = 40;
// Only this much is redacted: the start of a message and the end of stderr. That is far more than is reported,
// so the reported part keeps its context, and it bounds the time redaction can take on a huge input.
const TRUST_REDACT_MESSAGE_LIMIT = 4096;
const TRUST_REDACT_STDERR_LIMIT = 8192;

// A name: a whole run of name characters, starting only where the run begins, and checked by isSecretName instead
// of being searched for inside the run. Either of the other ways makes redaction slow on long runs.
const NAME = String.raw`(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]+)(?![A-Za-z0-9_.-])`;
// A name whose value is a secret: it contains one of these words, or ends in _key, -key or apikey.
const isSecretName = name => /secret|token|password|passwd|passphrase|credential|cookie|authorization/i.test(name)
  || /(?:[_-]key|apikey)$/i.test(name);
// A value: \"escaped-quoted\" (Rust debug output of JSON, where a JSON-escaped quote shows as \\\" and a
// backslash as \\\\), "quoted" or 'quoted' with escapes, or a bare word. A value an earlier rule already
// replaced is left alone.
const SECRET_VALUE = String.raw`(?!\[redacted\])(?:\\"(?:\\\\\\"|\\\\\\\\|\\\\[^\\]|\\[^"\\]|[^\\])*?\\"|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,;&"'}\]]+)`;
const REDACTIONS = [
  // Cookie headers carry several values: everything to the end of the line goes.
  [/\b((?:set-)?cookie\s*:\s*)[^\r\n]*/gi, '$1[redacted]'],
  // An Authorization header, whatever its scheme.
  [/\b((?:proxy-)?authorization\s*:\s*)(?:(?:Bearer|Basic|Digest|Token|Negotiate)\s+)?[^\s,;]+/gi, '$1[redacted]'],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[redacted]'],
  // Basic credentials only when the value looks like base64, so "basic validation failed" stays readable.
  [/\b(Basic\s+)(?=[A-Za-z0-9+/=]{8,})(?=[A-Za-z0-9+/=]*(?:[0-9+/=]|[a-z][A-Z]))[A-Za-z0-9+/]+=*/g, '$1[redacted]'],
  // JWTs, OpenAI-style keys and GitHub tokens, wherever they appear.
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]'],
  [/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}/g, '[redacted]'],
  [/\b(?:gh[opsur]_|github_pat_)[A-Za-z0-9_]{16,}/g, '[redacted]'],
  // user:password@ in a URL, up to the last @ before the host, since a password may hold an unencoded @.
  // The scheme starts only where a run of scheme characters begins: starting anywhere makes it slow on long runs.
  [/(?<![A-Za-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/)[^\s/]+@/gi, '$1[redacted]@'],
];
// --api-key VALUE on a command line. A value never starts with "--", so a following flag is not taken as one; a
// value may start with a single "-", as a random token sometimes does.
const SECRET_FLAG = new RegExp(String.raw`(?<![A-Za-z0-9_.-])(--[A-Za-z0-9_.-]+)(?![A-Za-z0-9_.-])(\s+)((?!--)[^\s"']+)`, 'g');
// The start of name=value, name: value, "name": "value", \"name\":\"value\" and --token=value, up to the value.
const NAME_SEPARATOR = new RegExp(String.raw`(\\?["']?)${NAME}(\\?["']?\s*[:=]\s*)`, 'g');
const VALUE_HERE = new RegExp(SECRET_VALUE, 'y');

// Replaces the value after each secret name. The search goes on right after the separator of a name that is not
// secret, so its value is searched too, since a quoted value may hold a secret pair. Only a secret name's value is
// matched, so a long run of plain pairs is read once instead of once for each pair.
function redactNameValues(text) {
  let result = '';
  let from = 0;
  NAME_SEPARATOR.lastIndex = 0;
  for (let match; (match = NAME_SEPARATOR.exec(text));) {
    if (!isSecretName(match[2])) continue;
    VALUE_HERE.lastIndex = NAME_SEPARATOR.lastIndex;
    const value = VALUE_HERE.exec(text);
    if (!value) continue;
    result += `${text.slice(from, NAME_SEPARATOR.lastIndex)}[redacted]`;
    from = NAME_SEPARATOR.lastIndex = VALUE_HERE.lastIndex;
  }
  return result + text.slice(from);
}

// Credentials that a Codex error or its stderr could carry. The error's data field and stdout are never included.
function redactTrustText(text) {
  const redacted = REDACTIONS.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), String(text));
  return redactNameValues(redacted.replace(SECRET_FLAG, (match, name, separator) => (isSecretName(name) ? `${name}${separator}[redacted]` : match)));
}

// The line a cut goes through is never reported: a cut can take a secret's name and leave its value, or open a
// quoted value it does not close, and redaction no longer recognises either. [cut] stands for that line. The head
// ends at the last line break before the cut and the tail starts at the first one after it; with none, the whole
// part is [cut].
const headForRedaction = (text) => {
  if (text.length <= TRUST_REDACT_MESSAGE_LIMIT) return text;
  const head = text.slice(0, TRUST_REDACT_MESSAGE_LIMIT);
  const end = Math.max(head.lastIndexOf('\n'), head.lastIndexOf('\r')) + 1;
  return `${head.slice(0, end)}[cut]`;
};
const tailForRedaction = (text) => {
  if (text.length <= TRUST_REDACT_STDERR_LIMIT) return text;
  const tail = text.slice(-TRUST_REDACT_STDERR_LIMIT);
  const start = tail.search(/[\r\n]/);
  return start === -1 ? '[cut]' : `[cut]${tail.slice(start)}`;
};

// One log line: terminal escape sequences removed, line breaks shown as " | ", other control characters as spaces.
function oneLine(text) {
  return String(text)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g, '')
    .replace(/\s*(?:\r\n|\r|\n)\s*/g, ' | ')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .trim();
}

/**
 * The parts of a failed trust attempt worth reporting: the exit code of a process that ended early, Codex's own
 * error code and message, and the end of the app-server's stderr; each redacted before it is capped.
 */
export function describeTrustFailure(trust = {}) {
  const parts = [];
  const exit = Number.isInteger(trust.code) ? trust.code : Number.isInteger(trust.status) ? trust.status : null;
  if (exit !== null) parts.push(`exit code ${exit}`);
  const error = trust.error;
  if (error !== undefined && error !== null) {
    // An object is Codex's own JSON-RPC error; a string is an error of the trust helper or of spawning Codex.
    const fromCodex = typeof error === 'object';
    const rawCode = fromCodex ? error.code : undefined;
    const code = rawCode === undefined || rawCode === null ? null
      : typeof rawCode === 'number' ? String(rawCode)
        : oneLine(redactTrustText(headForRedaction(String(rawCode)))).slice(0, TRUST_ERROR_CODE_LIMIT);
    const raw = fromCodex ? error.message ?? '' : error;
    const message = oneLine(redactTrustText(headForRedaction(String(raw)))).slice(0, TRUST_ERROR_MESSAGE_LIMIT);
    parts.push(`${fromCodex ? 'Codex error' : 'error'}${code ? ` ${code}` : ''}: ${message || '(no message)'}`);
  }
  const stderr = typeof trust.stderr === 'string' ? trust.stderr.trim() : '';
  if (stderr) {
    const tail = oneLine(redactTrustText(tailForRedaction(stderr)));
    parts.push(`stderr${tail.length > TRUST_STDERR_TAIL_LIMIT ? ` (last ${TRUST_STDERR_TAIL_LIMIT} characters)` : ''}: ${tail.slice(-TRUST_STDERR_TAIL_LIMIT)}`);
  }
  return parts.join('; ');
}

export function ensureCodexHooksTrusted({
  zylosDir,
  projectDir = zylosDir,
  homeDir = os.homedir(),
  codexHome,
  codexBin = process.env.CODEX_BIN || 'codex',
  execFileSyncImpl,
  spawnSyncImpl = spawnSync,
} = {}) {
  installCoreCodexHook({ zylosDir });

  const codexVersion = getCodexVersion({ codexBin, execFileSyncImpl });
  const validity = isCodexTrustValid({ zylosDir, projectDir, homeDir, codexHome, codexVersion });
  if (validity.valid) return { trusted: false, skipped: true, reason: validity.reason };

  ensureHooksFeature({ projectDir, homeDir, codexHome });
  const trust = trustCodexHooksWithAppServer({ zylosDir, codexBin, spawnSyncImpl });
  if (!trust.ok) {
    const detail = describeTrustFailure(trust);
    throw new Error(`Codex hook trust failed (${trust.reason || 'unknown'})${detail ? `: ${detail}` : ''}`);
  }
  if (trust.trusted === 0 && trust.missingHash > 0) {
    throw new Error(
      `Codex hook trust failed (missing_current_hash): Codex CLI "${codexVersion}" does not report currentHash in hooks/list ` +
      '(field added in Codex CLI 0.129.0). Upgrade Codex CLI to 0.129.0 or later (0.146+ recommended).'
    );
  }

  const hooksPath = codexHooksPath(zylosDir);
  const globalConfig = codexGlobalConfigPath(homeDir, codexHome);
  const hooksContent = fs.readFileSync(hooksPath, 'utf8');
  const trustSnapshot = extractTrustSnapshot(readHooksState(globalConfig), hooksPath);
  if (Object.keys(trustSnapshot).length === 0) {
    throw new Error('Codex hook trust failed (empty_trust_snapshot)');
  }
  writeTrustMarker(codexTrustMarkerPath(zylosDir), {
    hooksHash: sha256(hooksContent),
    codexVersion,
    trustSnapshot,
  });

  return {
    trusted: true,
    skipped: false,
    reason: validity.reason,
    count: Object.keys(trustSnapshot).length,
    appServer: trust,
  };
}

export const _test = {
  sha256,
  stableJson,
  parseToml,
};
