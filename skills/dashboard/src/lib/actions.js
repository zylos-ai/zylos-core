import { execFile, spawn } from 'node:child_process';
import https from 'node:https';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { getCodexModels, codexEffortsForModel } from './codex-models.js';
import { compareVersions, isNewerVersion } from './version-utils.js';

const execFileAsync = promisify(execFile);

function settingsPath(zylosDir) {
  return path.join(zylosDir, '.claude', 'settings.json');
}

function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

function codexConfigPath() {
  return path.join(codexHome(), 'config.toml');
}

function codexProjectConfigPath(zylosDir) {
  return path.join(zylosDir || path.join(os.homedir(), 'zylos'), '.codex', 'config.toml');
}

function c4ControlPath(zylosDir) {
  return path.join(zylosDir, '.claude', 'skills', 'comm-bridge', 'scripts', 'c4-control.js');
}

function dashboardDataDir(zylosDir) {
  return path.join(zylosDir, 'components', 'dashboard');
}

function zylosUpgradeMarkerPath(zylosDir) {
  return path.join(dashboardDataDir(zylosDir), 'upgrade-zylos-pending.json');
}

export function consumeZylosUpgradeMarker(zylosDir, currentVersion) {
  const markerPath = zylosUpgradeMarkerPath(zylosDir);
  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  } catch {
    return null;
  }

  try { fs.rmSync(markerPath, { force: true }); } catch { /* best effort */ }

  const targetVersion = marker.targetVersion || null;
  const fromVersion = marker.fromVersion || null;
  const current = currentVersion || null;
  let status = 'warning';

  if (current && targetVersion) {
    const cmp = compareVersions(current, targetVersion);
    if (cmp !== null && cmp >= 0) status = 'success';
  } else if (current && fromVersion) {
    const cmp = compareVersions(current, fromVersion);
    if (cmp !== null && cmp > 0) status = 'success';
  }

  return {
    status,
    fromVersion,
    targetVersion,
    currentVersion: current,
    startedAt: marker.startedAt || null
  };
}

const DEDUP_WINDOW_MS = 2000;
const recentInvocations = new Map();

function readSettings(zylosDir) {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(zylosDir), 'utf8'));
  } catch {
    return {};
  }
}

function writeSettings(zylosDir, settings) {
  fs.writeFileSync(settingsPath(zylosDir), JSON.stringify(settings, null, 2) + '\n');
}

export function readCodexRootString(key, zylosDir) {
  try {
    const text = fs.readFileSync(codexProjectConfigPath(zylosDir), 'utf8');
    const match = text.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"\\s*$`, 'm'));
    return match?.[1] || null;
  } catch { /* fall through */ }
  return null;
}

function writeCodexRootString(key, value, zylosDir) {
  const configPath = codexProjectConfigPath(zylosDir);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  let text = '';
  try { text = fs.readFileSync(configPath, 'utf8'); } catch { /* create below */ }
  if (!text) {
    text = '# Zylos project-level Codex config.\n';
  }
  const line = `${key} = ${JSON.stringify(value)}`;
  const pattern = new RegExp(`^\\s*${key}\\s*=\\s*"[^"]*"\\s*$`, 'm');
  text = pattern.test(text)
    ? text.replace(pattern, line)
    : `${line}\n${text}`;
  fs.writeFileSync(configPath, text.endsWith('\n') ? text : text + '\n', { mode: 0o600 });
}

function log(reqId, msg) {
  process.stderr.write(`[actions ${reqId}] ${msg}\n`);
}

function dedupKey(action, body) {
  return `${action}:${JSON.stringify(body || {})}`;
}

function isDuplicate(action, body) {
  const key = dedupKey(action, body);
  const now = Date.now();
  for (const [k, ts] of recentInvocations) {
    if (now - ts > DEDUP_WINDOW_MS) recentInvocations.delete(k);
  }
  const prev = recentInvocations.get(key);
  if (prev && now - prev <= DEDUP_WINDOW_MS) return true;
  recentInvocations.set(key, now);
  return false;
}

export async function handleAction(action, body, config) {
  const reqId = crypto.randomBytes(3).toString('hex');
  const zylosDir = config.zylosDir || path.join(os.homedir(), 'zylos');
  log(reqId, `=> ${action} ${JSON.stringify(body || {})}`);

  if (isDuplicate(action, body)) {
    log(reqId, `<= deduped (same payload within ${DEDUP_WINDOW_MS}ms)`);
    return { ok: false, error: 'duplicate_request', message: 'Identical request received within dedup window; ignored.', messageKey: 'result.duplicate_request' };
  }

  let result;
  try {
    switch (action) {
      case 'interrupt': result = await interrupt(reqId, zylosDir); break;
      case 'chop-chop': result = await chopChop(reqId, zylosDir); break;
      case 'restart-session': result = await restartSession(reqId, config); break;
      case 'switch-runtime': result = await switchRuntime(reqId, body, config); break;
      case 'switch-model': result = await switchModel(reqId, body, config, zylosDir); break;
      case 'switch-effort': result = await switchEffort(reqId, body, config, zylosDir); break;
      case 'set-threshold': result = await setThreshold(reqId, body, config, zylosDir); break;
      case 'upgrade-zylos': result = await upgradeZylos(reqId, zylosDir); break;
      case 'upgrade-cc': result = await upgradeRuntimeCli(reqId, config); break;
      default: result = { ok: false, error: 'unknown_action', messageKey: 'result.unknown_action' };
    }
  } catch (err) {
    log(reqId, `<= unhandled error: ${err.message}`);
    result = { ok: false, error: 'internal_error', message: err.message, messageKey: 'result.internal_error', messageParams: { error: err.message } };
  }

  log(reqId, `<= ${result.ok ? 'ok' : 'fail'}${result.error ? ' ' + result.error : ''}${result.message ? ' | ' + result.message : ''}`);
  return result;
}

async function interrupt(reqId, zylosDir) {
  const c4Control = c4ControlPath(zylosDir);
  log(reqId, `enqueue control: [KEYSTROKE]Escape (priority=0, bypass-state) via ${c4Control}`);
  try {
    const { stdout, stderr } = await execFileAsync(
      'node',
      [c4Control, 'enqueue', '--content', '[KEYSTROKE]Escape', '--priority', '0', '--bypass-state', '--no-ack-suffix'],
      { timeout: 5000 }
    );
    const out = (stdout || '').trim() + (stderr ? ` | stderr: ${stderr.trim()}` : '');
    log(reqId, `c4-control done${out ? ': ' + out : ''}`);
    return { ok: true, message: 'Interrupt signal sent', messageKey: 'result.interrupt_ok' };
  } catch (err) {
    log(reqId, `c4-control failed: ${err.message}`);
    return { ok: false, error: 'interrupt_failed', message: err.message, messageKey: 'result.interrupt_failed', messageParams: { error: err.message } };
  }
}

async function chopChop(reqId, zylosDir) {
  const interrupted = await interrupt(reqId, zylosDir);
  if (!interrupted.ok) {
    return {
      ...interrupted, error: 'chop_chop_escape_failed',
      messageKey: 'result.chop_chop_escape_failed',
      escape_enqueued: false, continue_enqueued: false
    };
  }

  // Match interrupt's enqueue guarantee; delivery to the runtime is asynchronous.
  await delay(500);
  const c4Control = c4ControlPath(zylosDir);
  try {
    log(reqId, 'enqueue control: continue (priority=0, bypass-state)');
    await execFileAsync('node', [
      c4Control, 'enqueue', '--content', 'continue', '--priority', '0',
      '--bypass-state', '--no-ack-suffix'
    ], { timeout: 5000 });
    return {
      ok: true, message: 'Escape and continue controls queued',
      messageKey: 'result.chop_chop_ok',
      escape_enqueued: true, continue_enqueued: true
    };
  } catch (err) {
    log(reqId, `continue enqueue failed: ${err.message}`);
    return {
      ok: false, error: 'chop_chop_continue_failed',
      message: `Escape queued, but continue could not be queued: ${err.message}`,
      messageKey: 'result.chop_chop_continue_failed', messageParams: { error: err.message },
      escape_enqueued: true, continue_enqueued: false
    };
  }
}

async function restartSession(reqId, config) {
  const runtime = config.runtime || process.env.ZYLOS_RUNTIME || 'claude';
  const session = runtime === 'codex' ? 'codex-main' : 'claude-main';
  log(reqId, `exec: tmux kill-session -t ${session}`);
  try {
    await execFileAsync('tmux', ['kill-session', '-t', session], { timeout: 5000 });
    log(reqId, `tmux session "${session}" killed`);
    return { ok: true, message: `Session "${session}" terminated. Activity monitor will restart it.`, messageKey: 'result.restart_ok', messageParams: { session } };
  } catch (err) {
    if (err.message?.includes('no server running') || err.message?.includes("can't find session")) {
      log(reqId, `tmux: no active session "${session}"`);
      return { ok: true, message: 'No active session found. Activity monitor will start a new one.', messageKey: 'result.restart_no_session' };
    }
    log(reqId, `tmux kill-session failed: ${err.message}`);
    return { ok: false, error: 'restart_failed', message: err.message, messageKey: 'result.restart_failed', messageParams: { error: err.message } };
  }
}

async function switchRuntime(reqId, body, config) {
  const target = body?.runtime;
  if (!target || !['claude', 'codex'].includes(target)) {
    return { ok: false, error: 'invalid_runtime', message: 'runtime must be "claude" or "codex"', messageKey: 'result.invalid_runtime' };
  }

  const current = config.runtime || process.env.ZYLOS_RUNTIME || 'claude';
  if (target === current) {
    return { ok: false, error: 'already_active', message: `Already running ${target}`, messageKey: 'result.already_active', messageParams: { value: target } };
  }

  log(reqId, `runtime switch: ${current} → ${target}`);
  try {
    await execFileAsync('which', [target], { timeout: 3000 });
  } catch {
    log(reqId, `${target} CLI not found in PATH`);
    return { ok: false, error: 'not_installed', message: `${target} CLI not found. Install it first.`, messageKey: 'result.not_installed', messageParams: { value: target } };
  }

  log(reqId, `spawn detached: zylos runtime ${target}`);
  const child = spawn('zylos', ['runtime', target], {
    detached: true, stdio: 'ignore', env: { ...process.env }
  });
  child.unref();

  setTimeout(() => {
    log(reqId, 'self-restart: pm2 restart zylos-dashboard');
    const restart = spawn('pm2', ['restart', 'zylos-dashboard'], {
      detached: true, stdio: 'ignore',
    });
    restart.unref();
  }, 15_000);

  return { ok: true, message: `Switching to ${target}. Dashboard will restart in ~15s.`, detached: true, messageKey: 'result.switching_runtime', messageParams: { value: target } };
}

async function switchModel(reqId, body, config, zylosDir) {
  const model = body?.model;
  if (!model || typeof model !== 'string') {
    return { ok: false, error: 'invalid_model', message: 'model is required', messageKey: 'result.invalid_model' };
  }

  const runtime = config.runtime || process.env.ZYLOS_RUNTIME || 'claude';

  if (runtime === 'claude') {
    const settings = readSettings(zylosDir);
    const prev = settings.model;
    if (prev === model) {
      log(reqId, `no-op: settings.model already "${model}"`);
      return { ok: false, error: 'already_set', message: `Model already set to ${model}`, messageKey: 'result.already_set_model', messageParams: { value: model } };
    }
    settings.model = model;
    log(reqId, `write ${settingsPath(zylosDir)}: model "${prev ?? '(unset)'}" → "${model}"`);
    writeSettings(zylosDir, settings);

    return { ok: true, message: `Model changed to ${model}.`, previous: prev, requires_restart: true, messageKey: 'result.model_changed', messageParams: { value: model } };
  }

  const prev = readCodexRootString('model', zylosDir);
  if (prev === model) {
    log(reqId, `no-op: codex model already "${model}"`);
    return { ok: false, error: 'already_set', message: `Model already set to ${model}`, messageKey: 'result.already_set_model', messageParams: { value: model } };
  }
  writeCodexRootString('model', model, zylosDir);
  log(reqId, `write ${codexProjectConfigPath(zylosDir)}: model "${prev ?? '(unset)'}" → "${model}"`);
  return { ok: true, message: `Model changed to ${model}.`, previous: prev, requires_restart: true, messageKey: 'result.model_changed', messageParams: { value: model } };
}

function effortsForModel(model) {
  if (/^(fable|claude-fable-|opus|claude-opus-5|claude-opus-4-[89]|claude-opus-4-[1-9]\d|claude-sonnet-5)/.test(model)) {
    return ['low', 'medium', 'high', 'xhigh'];
  }
  if (/^(haiku|claude-haiku-)/.test(model)) {
    return [];
  }
  return ['low', 'medium', 'high'];
}

async function switchEffort(reqId, body, config, zylosDir) {
  const effort = body?.effort;
  const runtime = config.runtime || process.env.ZYLOS_RUNTIME || 'claude';

  if (runtime === 'claude') {
    const settings = readSettings(zylosDir);
    const valid = effortsForModel(settings.model || '');
    if (!effort || !valid.includes(effort)) {
      return { ok: false, error: 'invalid_effort', message: `effort must be one of: ${valid.join(', ')}`, messageKey: 'result.invalid_effort', messageParams: { values: valid.join(', ') } };
    }

    const prev = settings.effortLevel;
    if (prev === effort) {
      log(reqId, `no-op: settings.effortLevel already "${effort}"`);
      return { ok: false, error: 'already_set', message: `Effort already set to ${effort}`, messageKey: 'result.already_set_effort', messageParams: { value: effort } };
    }
    settings.effortLevel = effort;
    log(reqId, `write ${settingsPath(zylosDir)}: effortLevel "${prev ?? '(unset)'}" → "${effort}"`);
    writeSettings(zylosDir, settings);

    return { ok: true, message: `Effort changed to ${effort}.`, previous: prev, requires_restart: true, messageKey: 'result.effort_changed', messageParams: { value: effort } };
  }

  const currentModel = readCodexRootString('model', zylosDir);
  const valid = codexEffortsForModel(currentModel);
  if (!valid.length) {
    return { ok: false, error: 'unknown_model_capabilities', message: 'Effort capabilities are unknown for the configured model.', messageKey: 'result.unknown_model_capabilities' };
  }
  if (!effort || !valid.includes(effort)) {
    return { ok: false, error: 'invalid_effort', message: `effort must be one of: ${valid.join(', ')}`, messageKey: 'result.invalid_effort', messageParams: { values: valid.join(', ') } };
  }

  const prev = readCodexRootString('model_reasoning_effort', zylosDir);
  if (prev === effort) {
    log(reqId, `no-op: codex model_reasoning_effort already "${effort}"`);
    return { ok: false, error: 'already_set', message: `Effort already set to ${effort}`, messageKey: 'result.already_set_effort', messageParams: { value: effort } };
  }
  writeCodexRootString('model_reasoning_effort', effort, zylosDir);
  log(reqId, `write ${codexProjectConfigPath(zylosDir)}: model_reasoning_effort "${prev ?? '(unset)'}" → "${effort}"`);
  return { ok: true, message: `Effort changed to ${effort}.`, previous: prev, requires_restart: true, messageKey: 'result.effort_changed', messageParams: { value: effort } };
}

function fetchLatestGitHubTag(repo) {
  return new Promise((resolve, reject) => {
    const req = https.get(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { 'User-Agent': 'zylos-dashboard', Accept: 'application/vnd.github.v3+json' },
      timeout: 10000,
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 404) return resolve(null);
        if (res.statusCode !== 200) return reject(new Error(`GitHub API ${res.statusCode}`));
        try {
          const tag = JSON.parse(data).tag_name;
          resolve(tag ? tag.replace(/^v/, '') : null);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('GitHub API timeout')); });
  });
}

async function upgradeZylos(reqId, zylosDir) {
  let currentVersion;
  try {
    const { stdout } = await execFileAsync('zylos', ['--version'], { timeout: 5000 });
    currentVersion = (stdout || '').trim();
  } catch {
    currentVersion = null;
  }

  let latestVersion;
  try {
    latestVersion = await fetchLatestGitHubTag('zylos-ai/zylos-core');
  } catch (err) {
    log(reqId, `version check failed: ${err.message}, proceeding with upgrade`);
  }

  if (currentVersion && latestVersion && !isNewerVersion(latestVersion, currentVersion)) {
    log(reqId, `already up to date: v${currentVersion}`);
    return { ok: false, error: 'already_up_to_date', message: `Already on the latest version (v${currentVersion}).`, messageKey: 'result.already_up_to_date', messageParams: { version: currentVersion } };
  }

  const upgradeMsg = latestVersion && currentVersion
    ? `Upgrading v${currentVersion} → v${latestVersion}. All services will restart.`
    : 'Upgrade started. All services will restart.';
  const upgradeMsgKey = latestVersion && currentVersion ? 'result.upgrading_zylos' : 'result.upgrading_zylos_simple';
  const upgradeMsgParams = latestVersion && currentVersion ? { from: currentVersion, to: latestVersion } : undefined;

  const markerPath = zylosUpgradeMarkerPath(zylosDir);
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(markerPath, JSON.stringify({
    action: 'upgrade-zylos',
    fromVersion: currentVersion,
    targetVersion: latestVersion,
    startedAt: new Date().toISOString()
  }, null, 2) + '\n');

  const script = `
    const { spawn } = require('node:child_process');
    const child = spawn('zylos', ['upgrade', '--self', '-y'], {
      detached: true,
      stdio: 'ignore',
      env: process.env
    });
    child.unref();
  `;

  log(reqId, `spawn double-fork detached: zylos upgrade --self -y (${currentVersion || '?'} → ${latestVersion || '?'})`);
  const child = spawn(process.execPath, ['-e', script], {
    detached: true, stdio: 'ignore', env: { ...process.env }
  });
  child.unref();

  return { ok: true, message: upgradeMsg, detached: true, messageKey: upgradeMsgKey, messageParams: upgradeMsgParams };
}

async function upgradeRuntimeCli(reqId, config) {
  const runtime = config.runtime || process.env.ZYLOS_RUNTIME || 'claude';
  if (runtime === 'codex') {
    log(reqId, `exec: codex update`);
    try {
      const { stdout, stderr } = await execFileAsync('codex', ['update'], { timeout: 60000 });
      const output = (stdout || '') + (stderr || '');
      log(reqId, `codex update done (${output.trim().slice(0, 200)})`);
      return { ok: true, message: 'Codex CLI updated. Restart session to apply.', output: output.trim(), requires_restart: true, messageKey: 'result.codex_updated' };
    } catch (err) {
      const fallbackMsg = err.stderr || err.stdout || err.message;
      log(reqId, `codex update failed: ${(fallbackMsg || '').slice(0, 200)}`);
      return { ok: false, error: 'upgrade_failed', message: fallbackMsg, messageKey: 'result.upgrade_failed', messageParams: { error: fallbackMsg } };
    }
  }

  log(reqId, `exec: claude update`);
  try {
    const { stdout, stderr } = await execFileAsync('claude', ['update'], { timeout: 60000 });
    const output = (stdout || '') + (stderr || '');
    log(reqId, `claude update done (${output.trim().slice(0, 200)})`);
    return { ok: true, message: 'Claude Code updated. Restart session to apply.', output: output.trim(), requires_restart: true, messageKey: 'result.cc_updated' };
  } catch (err) {
    const fallbackMsg = err.stderr || err.stdout || err.message;
    log(reqId, `claude update failed: ${(fallbackMsg || '').slice(0, 200)}`);
    return { ok: false, error: 'upgrade_failed', message: fallbackMsg, messageKey: 'result.upgrade_failed', messageParams: { error: fallbackMsg } };
  }
}

async function setThreshold(reqId, body, config, zylosDir) {
  const value = parseInt(body?.value, 10);
  if (!value || value < 10 || value > 95) {
    return { ok: false, error: 'invalid_value', message: 'Threshold must be between 10 and 95', messageKey: 'result.invalid_threshold' };
  }
  const runtime = config.runtime || process.env.ZYLOS_RUNTIME || 'claude';
  const key = runtime === 'codex' ? 'codex_new_session_threshold' : 'new_session_threshold';
  log(reqId, `exec: zylos config set ${key} ${value}`);
  try {
    const { stdout } = await execFileAsync('zylos', ['config', 'set', key, String(value)], { timeout: 5000 });
    log(reqId, `threshold set: ${stdout.trim()}`);
    return { ok: true, message: `New session threshold set to ${value}%`, messageKey: 'result.threshold_set', messageParams: { value } };
  } catch (err) {
    log(reqId, `set threshold failed: ${err.message}`);
    return { ok: false, error: 'set_failed', message: err.message, messageKey: 'result.set_failed', messageParams: { error: err.message } };
  }
}

export function getActionsMeta(config, runtimeInfo) {
  const runtime = config.runtime || process.env.ZYLOS_RUNTIME || 'claude';
  const codexModels = runtime === 'codex' ? getCodexModels() : [];

  const claudeModels = [
    { id: 'fable[1m]', display_name: 'Fable [1M] (latest)' },
    { id: 'opus', display_name: 'Opus (latest)' },
    { id: 'opus[1m]', display_name: 'Opus [1M] (latest)' },
    { id: 'sonnet', display_name: 'Sonnet (latest)' },
    { id: 'sonnet[1m]', display_name: 'Sonnet [1M] (latest)' },
    { id: 'haiku', display_name: 'Haiku (latest)' },
    { id: 'claude-fable-5-1[1m]' },
    { id: 'claude-fable-5[1m]' },
    { id: 'claude-opus-5-5' },
    { id: 'claude-opus-5-5[1m]' },
    { id: 'claude-opus-5' },
    { id: 'claude-opus-5[1m]' },
    { id: 'claude-sonnet-5' },
    { id: 'claude-opus-4-8' },
    { id: 'claude-opus-4-8[1m]' },
    { id: 'claude-opus-4-7' },
    { id: 'claude-opus-4-7[1m]' },
    { id: 'claude-opus-4-6' },
    { id: 'claude-opus-4-6[1m]' },
    { id: 'claude-sonnet-4-6' },
    { id: 'claude-haiku-4-5-20251001' },
  ];

  const models = runtime === 'claude'
    ? claudeModels
    : codexModels.map(m => ({ id: m.id, display_name: m.display_name }));

  const efforts_by_model = runtime === 'claude'
    ? Object.fromEntries([
        ...claudeModels.map(m => [m.id, effortsForModel(m.id)]),
        ['*', ['low', 'medium', 'high']]
      ])
    : Object.fromEntries(codexModels.map(m => [m.id, m.efforts]));

  const zylosDir = config.zylosDir || path.join(os.homedir(), 'zylos');
  const settings = runtime === 'claude' ? readSettings(zylosDir) : {};
  const codexModel = runtime === 'codex' ? readCodexRootString('model', zylosDir) : null;
  const codexEffort = runtime === 'codex' ? readCodexRootString('model_reasoning_effort', zylosDir) : null;
  const currentCodexModel = runtime === 'codex'
    ? codexModel || null
    : null;
  if (runtime === 'codex') {
    for (const id of [codexModel, runtimeInfo?.model_id]) {
      if (id && !models.some(model => model.id === id)) {
        models.push({ id, display_name: id });
        efforts_by_model[id] = [];
      }
    }
  }

  const thresholdKey = runtime === 'codex' ? 'codex_new_session_threshold' : 'new_session_threshold';
  const defaultThreshold = runtime === 'codex' ? 75 : 70;
  const newSessionThreshold = parseInt(config[thresholdKey], 10) || defaultThreshold;

  return {
    runtime,
    current_model: runtime === 'claude' ? settings.model || null : currentCodexModel,
    current_effort: runtime === 'claude'
      ? runtimeInfo?.effort || settings.effortLevel || null
      : codexEffort || null,
    running_model: runtime === 'codex' ? runtimeInfo?.model_id || null : null,
    running_effort: runtime === 'codex' ? runtimeInfo?.effort || null : null,
    models,
    efforts_by_model,
    new_session_threshold: newSessionThreshold
  };
}
