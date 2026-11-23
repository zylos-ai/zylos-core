import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto, { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { parse, stringify } from 'smol-toml';
import { parse as parseDotEnv } from 'dotenv';
import { SIDE_EFFECT_NAMES, buildChain } from '../../../../skills/activity-monitor/scripts/shard-registry.js';
import { extractScriptPath, hookEntryTarget, HOOK_ENTRY_SCRIPT } from '../../hook-utils.js';
import { UNSUPPORTED } from '../contract.js';
import { selectToolInput } from '../shared/tool-input.js';

const ZYLOS_DIR = path.resolve(process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos'));

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

/** Core Codex hooks run through the hook entry, like Claude's (see sync-runtime-hooks). */
function coreHookCommand(zylosDir, script) {
  const root = path.join(path.resolve(zylosDir), '.claude');
  return `exec node ${path.join(root, HOOK_ENTRY_SCRIPT)} ${path.join(root, 'skills', 'activity-monitor', 'scripts', script)}`;
}

export function coreSessionStartCommand(zylosDir) {
  return coreHookCommand(zylosDir, 'session-start-orchestrator.js');
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
    .some(name => path.resolve(hookEntryTarget(command) ?? extractScriptPath(command)) === path.join(scriptsDir, name));
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
  const activityCommand = coreHookCommand(zylosDir, 'hook-activity.js');
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
// backslash as \\\\), "quoted" or 'quoted' with escapes, or a bare word. A quoted value whose closing quote is
// not in the text (it was cut off) runs to the end of the text. A value an earlier rule already replaced is left
// alone.
const SECRET_VALUE = String.raw`(?!\[redacted\])(?:\\"(?:\\\\\\"|\\\\\\\\|\\\\[^\\]|\\[^"\\]|[^\\])*?\\"|"(?:[^"\\]|\\.)*(?:"|$)|'(?:[^'\\]|\\.)*(?:'|$)|[^\s,;&"'}\]]+)`;
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

// The line a cut goes through is never reported: a cut can leave part of a secret that redaction no longer
// recognises, such as a value without its name. [cut] stands for that line. The head ends at the last line break
// before the cut and the tail starts at the first one after it; with none, the whole part is [cut].
const headForRedaction = (text) => {
  if (text.length <= TRUST_REDACT_MESSAGE_LIMIT) return text;
  const head = text.slice(0, TRUST_REDACT_MESSAGE_LIMIT);
  const end = Math.max(head.lastIndexOf('\n'), head.lastIndexOf('\r')) + 1;
  return `${head.slice(0, end)}[cut]`;
};
// The tail is redacted together with the line the cut goes through, so a secret name on that line still covers
// its value on the next line; the cut line is dropped after that.
const redactTail = (text) => {
  if (text.length <= TRUST_REDACT_STDERR_LIMIT) return redactTrustText(text);
  const tail = redactTrustText(text.slice(-TRUST_REDACT_STDERR_LIMIT));
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
    const tail = oneLine(redactTail(stderr));
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

const CODEX_PROJECT_HEADER = [
  '# Zylos project-level Codex config.',
  '# Zylos applies overwrite, backfill, key-level, and exact-replacement settings; other settings are preserved.',
].join('\n');

const CODEX_GLOBAL_HEADER = [
  '# Codex global config.',
  '# Zylos manages its project trust entry and optional base URL; other settings are preserved.',
].join('\n');

const CODEX_NOTICE = {
  hide_full_access_warning: true,
  hide_world_writable_warning: true,
  hide_rate_limit_model_nudge: true,
  hide_gpt5_1_migration_prompt: true,
  'hide_gpt-5.1-codex-max_migration_prompt': true,
};

const CODEX_MODEL_MIGRATIONS = {
  'gpt-5.3-codex': 'gpt-5.4',
};

function tomlWithHeader(header, obj) {
  return `${header}\n\n${stringify(obj)}`;
}

// This comment records only keys inserted by Zylos, never user values/secrets.
// Keeping it in the same file makes config + ownership one write. If another
// TOML writer strips it, the values become user-owned and are not auto-removed.
const PERMISSION_MARKER = '# zylos-managed-permission-defaults: ';
const PERMISSION_DEFAULTS = { approval_policy: 'never', sandbox_mode: 'danger-full-access' };

function applyCodexPermissionDefaults(obj, content, bypass) {
  const marker = content.split('\n').find(line => line.startsWith(PERMISSION_MARKER));
  const previous = new Set(marker?.slice(PERMISSION_MARKER.length).split(',') ?? []);
  const owned = [];
  for (const [key, value] of Object.entries(PERMISSION_DEFAULTS)) {
    const stillOwned = previous.has(key) && obj[key] === value;
    // Explicit named or workspace configuration takes over sandbox ownership.
    const sandboxConfigured = obj.default_permissions !== undefined || obj.sandbox_workspace_write !== undefined;
    const enabled = bypass && !(key === 'sandbox_mode' && sandboxConfigured);
    if (!enabled) {
      if (stillOwned) delete obj[key];
    } else if (obj[key] === undefined || stillOwned) {
      obj[key] = value;
      owned.push(key);
    }
  }
  return owned.length ? PERMISSION_MARKER + owned.join(',') : '';
}

export function resolveCodexBypassPermissions(projectDir, opts = {}) {
  if (opts.bypassPermissions != null) return opts.bypassPermissions;
  if (process.env.CODEX_BYPASS_PERMISSIONS !== undefined) {
    return process.env.CODEX_BYPASS_PERMISSIONS !== 'false';
  }
  try {
    const env = parseDotEnv(fs.readFileSync(path.join(projectDir, '.env'), 'utf8'));
    if (env.CODEX_BYPASS_PERMISSIONS !== undefined) return env.CODEX_BYPASS_PERMISSIONS !== 'false';
  } catch (err) { if (err.code !== 'ENOENT') throw err; }
  return true;
}

function writeCodexProjectConfigAtomically(configPath, content) {
  // Preserve a user-managed symlink instead of replacing the link itself.
  let target = configPath;
  let mode = 0o600;
  let existing;
  try { existing = fs.lstatSync(configPath); }
  catch (err) { if (err.code !== 'ENOENT') throw err; }
  if (existing) {
    if (existing.isSymbolicLink()) target = fs.realpathSync(configPath);
    mode = fs.statSync(target).mode & 0o777;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp.${randomUUID()}`;
  let fd;
  let created = false;
  try {
    fd = fs.openSync(temporary, 'wx', mode);
    created = true;
    fs.fchmodSync(fd, mode); // Preserve existing mode even under a stricter umask.
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, target);
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* best effort */ }
    if (created) try { fs.unlinkSync(temporary); } catch { /* renamed or already absent */ }
  }
}

export function writeCodexProjectConfig(projectDir, opts = {}) {
  const configPath = path.join(path.resolve(projectDir), '.codex', 'config.toml');
  let existing = '';
  try { existing = fs.readFileSync(configPath, 'utf8'); }
  catch (err) { if (err.code !== 'ENOENT') throw err; }
  const bypassPermissions = resolveCodexBypassPermissions(projectDir, opts);
  const content = renderCodexProjectConfig(existing, { bypassPermissions });
  if (bypassPermissions) {
    const config = parse(content);
    if (config.approval_policy !== 'never'
      || (config.default_permissions !== undefined
        ? config.default_permissions !== ':danger-full-access'
        : config.sandbox_mode !== 'danger-full-access')) {
      console.warn('Warning: explicit Codex project permissions are preserved; unattended resume may be restricted or require approval.');
    }
  }
  if (content !== existing) {
    writeCodexProjectConfigAtomically(configPath, content);
    opts.onWrite?.(configPath);
  }
}

/**
 * Render project-level .codex/config.toml with headless configuration.
 *
 * Contains settings required for zylos unattended operation: interactive prompt
 * suppression, feature flags, and model migration acknowledgements. These are
 * project requirements, not user preferences.
 *
 * Written to <projectDir>/.codex/config.toml (Codex project-level config).
 *
 * @param {string} existingContent - Existing project config.toml contents (optional)
 * @param {{ bypassPermissions?: boolean }} opts - Whether to backfill unattended permissions
 * @returns {string}
 */
export function renderCodexProjectConfig(existingContent = '', opts = {}) {
  // Do not turn malformed user configuration into unattended full access.
  const obj = existingContent.trim() ? parse(existingContent) : {};
  const permissionHeader = applyCodexPermissionDefaults(obj, existingContent, opts.bypassPermissions ?? true);

  // Always overwrite: these values are required for unattended Zylos runtime behavior.
  obj.check_for_update_on_startup = false;
  obj.model_availability_nux = 'gpt-5.4';

  // Backfill: default only when the user has not configured a value.
  if (obj.model === undefined) obj.model = 'gpt-6.2-sol';
  if (obj.model_reasoning_effort === undefined) obj.model_reasoning_effort = 'medium';

  obj.features = isSection(obj.features) ? obj.features : {};
  obj.features.multi_agent = true;
  obj.features.fast_mode = false;
  obj.features.hooks = true;

  const existingNotice = isSection(obj.notice) ? obj.notice : {};
  const notice = { ...CODEX_NOTICE };
  for (const [key, value] of Object.entries(existingNotice)) {
    if (key !== 'model_migrations' && isSection(value)) {
      notice[key] = value;
    }
  }
  notice.model_migrations = { ...CODEX_MODEL_MIGRATIONS };
  obj.notice = notice;

  return tomlWithHeader([CODEX_PROJECT_HEADER, permissionHeader].filter(Boolean).join('\n'), obj);
}

/**
 * Render global ~/.codex/config.toml with user/environment-level settings.
 *
 * Contains only trust declarations and optional base URL override.
 * Existing [projects.*] trust entries are preserved; the zylos project trust
 * entry is always regenerated.
 *
 * @param {string} projectDir - The zylos working directory to pre-trust
 * @param {string} existingContent - Existing global config.toml contents (optional)
 * @param {{ openaiBaseUrl?: string }} opts - Optional Codex config overrides
 * @returns {string}
 */
export function renderCodexGlobalConfig(projectDir, existingContent = '', opts = {}) {
  const absProject = path.resolve(projectDir);
  const openaiBaseUrl = opts.openaiBaseUrl || process.env.OPENAI_BASE_URL || '';
  const obj = parseToml(existingContent);
  if (openaiBaseUrl) {
    obj.openai_base_url = openaiBaseUrl;
  }
  obj.features = isSection(obj.features) ? obj.features : {};
  obj.features.hooks = true;
  obj.projects = isSection(obj.projects) ? obj.projects : {};
  obj.projects[absProject] = { trust_level: 'trusted' };
  return tomlWithHeader(CODEX_GLOBAL_HEADER, obj);
}

/**
 * Write Codex configuration to both project-level and global locations.
 *
 * - Project config (<projectDir>/.codex/config.toml): headless settings,
 *   features, notice suppression — required for zylos unattended operation.
 * - Global config (~/.codex/config.toml): trust declarations, optional
 *   base URL override.
 *
 * Called by both `zylos init` (Codex runtime) and `zylos runtime codex` so the
 * config is always present when switching to Codex.
 *
 * @param {string} projectDir - The zylos working directory to pre-trust
 * @returns {boolean} true on success
 */
export function writeCodexConfig(projectDir, opts = {}) {
  try {
    writeCodexProjectConfig(projectDir, opts);

    // Write global config
    const globalCodexDir = path.join(os.homedir(), '.codex');
    const globalConfigPath = path.join(globalCodexDir, 'config.toml');
    let existing = '';
    try {
      existing = fs.readFileSync(globalConfigPath, 'utf8');
    } catch { /* new file — nothing to preserve */ }
    fs.mkdirSync(globalCodexDir, { recursive: true });
    fs.writeFileSync(
      globalConfigPath,
      renderCodexGlobalConfig(projectDir, existing, opts),
      'utf8'
    );
    opts.onWrite?.(globalConfigPath);

    installCoreCodexHook({ zylosDir: projectDir, onWrite: opts.onWrite });

    return true;
  } catch {
    return false;
  }
}

export function syncCodexConfig({
  dryRun = false,
  projectDir = ZYLOS_DIR,
  homeDir = os.homedir(),
  readFileSync = fs.readFileSync,
  writeConfig = writeCodexConfig,
  checkHooks = installCoreCodexHook,
  onWrite,
  log = console.log,
} = {}) {
  const globalConfigPath = path.join(homeDir, '.codex', 'config.toml');
  const projectConfigPath = path.join(path.resolve(projectDir), '.codex', 'config.toml');

  // Check both project-level and global config for drift
  let existingGlobal = '';
  try { existingGlobal = readFileSync(globalConfigPath, 'utf8'); } catch {}
  let existingProject = '';
  try { existingProject = readFileSync(projectConfigPath, 'utf8'); } catch {}

  let desiredProject;
  try {
    const bypassPermissions = resolveCodexBypassPermissions(projectDir);
    desiredProject = renderCodexProjectConfig(existingProject, { bypassPermissions });
  } catch {
    const error = 'Failed to refresh Codex project config: check TOML syntax and deployment environment.';
    log(`  Warning: ${error}`);
    return { attempted: true, changed: false, fatal: true, error };
  }
  const desiredGlobal = renderCodexGlobalConfig(projectDir, existingGlobal);
  // .codex/hooks.json drifts independently of the TOML configs: a component
  // shard declaration adds SessionStart commands without touching either
  // config file. Compare the desired hook set with the file content itself.
  const hooksCheck = checkHooks({ zylosDir: projectDir, dryRun: true });
  if (existingProject === desiredProject && existingGlobal === desiredGlobal && !hooksCheck.changed) {
    return { attempted: true, changed: false, fatal: false };
  }

  if (dryRun) {
    if (existingProject !== desiredProject) log(`  ~ codex project config: ${projectConfigPath}`);
    if (existingGlobal !== desiredGlobal) log(`  ~ codex global config: ${globalConfigPath}`);
    if (hooksCheck.changed) log(`  ~ codex hooks: ${hooksCheck.path}`);
    return { attempted: true, changed: true, hooksChanged: hooksCheck.changed, fatal: false };
  }

  if (!writeConfig(projectDir, { onWrite })) {
    return {
      attempted: true,
      changed: false,
      fatal: true,
      error: 'Failed to refresh codex config.',
    };
  }

  if (existingProject !== desiredProject) log(`  ~ codex project config: ${projectConfigPath}`);
  if (existingGlobal !== desiredGlobal) log(`  ~ codex global config: ${globalConfigPath}`);
  if (hooksCheck.changed) log(`  ~ codex hooks: ${hooksCheck.path}`);
  return { attempted: true, changed: true, hooksChanged: hooksCheck.changed, fatal: false };
}

async function sync({ zylosDir = ZYLOS_DIR, dryRun } = {}) {
  const config = syncCodexConfig({ dryRun, projectDir: zylosDir });
  if (config.fatal) {
    console.error(config.error);
    throw new Error(config.error);
  }

  // Config synchronization may already have refreshed hooks.json.
  const installed = dryRun ? { changed: false } : installCoreCodexHook({ zylosDir });
  const entry = { ...installed, changed: installed.changed || (!dryRun && Boolean(config.hooksChanged)) };
  if (entry.changed) console.log('Codex hooks: updated; they take effect at the next Codex session start.');

  return {
    entry,
    changed: config.changed || entry.changed,
    restart: entry.changed,
    fragments: {
      dryRun: config.changed ? ', codex config to refresh' : '',
      done: `${config.changed ? ', Codex config refreshed' : ''}${entry.changed ? ', Codex hooks refreshed' : ''}`,
      upToDate: `Codex config ${config.changed ? 'refreshed' : 'unchanged'}`,
    },
  };
}

export const hooks = Object.freeze({
  sessionIdEnv: 'CODEX_SESSION_ID',
  sync,
  syncPolicy: 'always',
  optedIn: UNSUPPORTED,
  ready: async ({ zylosDir }) => {
    const validity = isCodexTrustValid({ zylosDir, projectDir: zylosDir, codexVersion: getCodexVersion() });
    if (validity.valid) return true;
    try {
      ensureCodexHooksTrusted({ zylosDir });
    } catch (error) {
      throw new Error(`Codex hook trust is invalid (${validity.reason}) and rebuilding it failed: ${error.message}`);
    }
    return true;
  },
  trust: async ({ zylosDir }) => ensureCodexHooksTrusted({ zylosDir }),
  stage: UNSUPPORTED,
  writeConfig: syncCodexConfig,
  installHooks: installCoreCodexHook,
  normalize: payload => payload,
  output: ({ event, result }) => event === 'SessionStart' && typeof result?.text === 'string' ? result.text : '',
  toolInput: selectToolInput,
  mainSession: UNSUPPORTED,
  readSessionSource: UNSUPPORTED,
  toolGuard: UNSUPPORTED,
});
