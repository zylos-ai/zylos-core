import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { parse, stringify } from 'smol-toml';

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

export function codexGlobalConfigPath(homeDir = os.homedir()) {
  return path.join(homeDir, '.codex', 'config.toml');
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

export function isCoreCodexHook(command, zylosDir) {
  if (!command) return false;
  const script = path.join(
    path.resolve(zylosDir),
    '.claude',
    'skills',
    'activity-monitor',
    'scripts',
    'session-start-orchestrator.js'
  );
  return command.includes(script) || command.includes('session-start-orchestrator.js');
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

export function installCoreCodexHook({ zylosDir }) {
  const filePath = codexHooksPath(zylosDir);
  const config = readCodexHooksConfig(filePath);
  config.hooks = isSection(config.hooks) ? config.hooks : {};
  config.hooks[SESSION_START] = Array.isArray(config.hooks[SESSION_START])
    ? config.hooks[SESSION_START]
    : [];

  const command = coreSessionStartCommand(zylosDir);
  const desiredHook = {
    type: 'command',
    command,
    timeout: DEFAULT_HOOK_TIMEOUT_SECONDS,
  };

  let changed = false;
  const existingGroup = config.hooks[SESSION_START].find(group =>
    Array.isArray(group?.hooks) && group.hooks.some(h => isCoreCodexHook(h?.command, zylosDir))
  );

  if (existingGroup) {
    existingGroup.hooks = existingGroup.hooks.map((hook) => {
      if (!isCoreCodexHook(hook?.command, zylosDir)) return hook;
      const next = { ...hook, ...desiredHook };
      delete next.async;
      if (stableJson(next) !== stableJson(hook)) changed = true;
      return next;
    });
  } else {
    config.hooks[SESSION_START].push({ hooks: [desiredHook] });
    changed = true;
  }

  if (changed) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(config, null, 2) + '\n');
  }

  return { path: filePath, changed, command };
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

export function ensureHooksFeature({ projectDir, homeDir = os.homedir() }) {
  const paths = [
    codexProjectConfigPath(projectDir),
    codexGlobalConfigPath(homeDir),
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
  codexVersion,
} = {}) {
  const hooksPath = codexHooksPath(zylosDir);
  const markerPath = codexTrustMarkerPath(zylosDir);
  const globalConfig = codexGlobalConfigPath(homeDir);
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

app.stderr.on('data', d => { stderr += d.toString(); });
app.on('error', err => {
  clearTimeout(timer);
  finish({ ok: false, reason: 'codex_app_server_error', error: String(err) });
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
        finish({ ok: false, reason: 'hooks_list_error', error: msg.error });
        return;
      }

      const state = {};
      for (const entry of msg.result?.data || []) {
        for (const hook of entry.hooks || []) {
          if (hook.isManaged || !hook.key || !hook.currentHash) continue;
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
        finish({ ok: false, reason: 'config_batch_write_error', error: msg.error });
      } else {
        finish({ ok: true, trusted: trustedCount, status: msg.result?.status || 'ok' });
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

export function ensureCodexHooksTrusted({
  zylosDir,
  projectDir = zylosDir,
  homeDir = os.homedir(),
  codexBin = process.env.CODEX_BIN || 'codex',
  execFileSyncImpl,
  spawnSyncImpl = spawnSync,
} = {}) {
  installCoreCodexHook({ zylosDir });

  const codexVersion = getCodexVersion({ codexBin, execFileSyncImpl });
  const validity = isCodexTrustValid({ zylosDir, projectDir, homeDir, codexVersion });
  if (validity.valid) return { trusted: false, skipped: true, reason: validity.reason };

  ensureHooksFeature({ projectDir, homeDir });
  const trust = trustCodexHooksWithAppServer({ zylosDir, codexBin, spawnSyncImpl });
  if (!trust.ok) {
    throw new Error(`Codex hook trust failed (${trust.reason || 'unknown'}). Native SessionStart bootstrap may not run.`);
  }

  const hooksPath = codexHooksPath(zylosDir);
  const globalConfig = codexGlobalConfigPath(homeDir);
  const hooksContent = fs.readFileSync(hooksPath, 'utf8');
  const trustSnapshot = extractTrustSnapshot(readHooksState(globalConfig), hooksPath);
  if (Object.keys(trustSnapshot).length === 0) {
    throw new Error('Codex hook trust failed (empty_trust_snapshot). Native SessionStart bootstrap may not run.');
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
