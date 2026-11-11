import { prepareUpstreams, withUpstreamSnapshot } from '../lib/upstreams.js';
/**
 * zylos doctor — diagnose installation health and auto-fix via Claude.
 *
 * Design: https://github.com/zylos-ai/zylos-core/issues/202
 *
 * Layer 1: Diagnose all checks. Ensure Claude CLI is reachable.
 * Layer 2: If Claude is available, delegate all fixes to `claude -p`.
 *          If not, show manual hints.
 */

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import dns from 'node:dns/promises';
import { ZYLOS_DIR, CONFIG_DIR, SKILLS_DIR, COMPONENTS_FILE, ENV_FILE, readSessionMode } from '../lib/config.js';
import { readEnvFile, ensureEnvFilePrivate } from '../lib/env.js';
import { loadComponents } from '../lib/components.js';
import { fetchLatestTagAsync, compareSemverDesc } from '../lib/github.js';
import { getCurrentVersion } from '../lib/self-upgrade.js';
import { commandExists } from '../lib/shell-utils.js';
import { parseSkillMd } from '../lib/skill.js';
import { bold, dim, green, red, yellow, heading } from '../lib/colors.js';
import { getTmuxCapability, describeTmuxSendKeys } from '../lib/tmux-send-keys.js';
import { resolveCliSession } from '../lib/cli-session.js';
import { collectStatus } from '../lib/status-view.js';
import { resolveTargetRuntime } from '../lib/session-state-reader.js';
import { describeOrigin, formatOriginDescription } from '../lib/origin-presence.js';
import { TMUX_COMMAND as C } from '../lib/runtime/tmux-protocol.js';
import { alertTargetNotice, formatAlertTargetNotice } from '../lib/alert-target-notice.js';
import { readPoolCapacity } from '../lib/session-pool-config.js';
import { dashboardAccessAddress } from '../lib/dashboard-access.js';
import { readSessionModeStatus } from '../lib/session-mode-status.js';

const LOG_DIR = path.join(ZYLOS_DIR, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'doctor.log');
const VERSION_CHECK_CONCURRENCY = 3;
const CLAUDE_FIX_TIMEOUT = 300000; // 5 minutes

export const isDiagnosticOnlyIssue = issue => issue.id.startsWith('origin_') || issue.id.startsWith('session_mode_');

// ── Logging ──────────────────────────────────────────────────────

let _logDirReady = false;

function logToFile(message) {
  try {
    if (!_logDirReady) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      _logDirReady = true;
    }
    const ts = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
    fs.appendFileSync(LOG_FILE, `[${ts}] ${message}\n`);
  } catch {}
}

// ── Display helpers ──────────────────────────────────────────────

const SKIP = (label) => `  ${dim('⊘')} ${label}`;
const SUB = (label) => `  ${dim('├')} ${label}`;
const SUB_LAST = (label) => `  ${dim('└')} ${label}`;
const BULLET_ON = (label) => `  ${green('●')} ${label}`;
const BULLET_OFF = (label) => `  ${dim('○')} ${label}`;

function groupHeader(name, status) {
  const icon = status === 'pass' ? green('✓')
    : status === 'fail' ? red('✗')
    : status === 'skip' ? dim('⊘')
    : dim('…');
  return `\n${icon} ${bold(name)}`;
}

function separator(title) {
  const line = '─'.repeat(40);
  return `\n${dim(line)}\n  ${bold(title)}\n${dim(line)}`;
}

function displayCheckGroup(name, status, checks) {
  console.log(groupHeader(name, status));
  for (let i = 0; i < checks.length; i++) {
    console.log(i < checks.length - 1 ? SUB(checks[i]) : SUB_LAST(checks[i]));
  }
}

// ── Concurrency helper ───────────────────────────────────────────

async function concurrentMap(items, fn, limit = 3) {
  const results = new Array(items.length);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i], i);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return results;
}

// ── Check implementations ────────────────────────────────────────

function checkTmuxInstalled() {
  if (!commandExists('tmux')) return { installed: false };
  return { installed: true, ...getTmuxCapability() };
}

function checkPm2Installed() {
  if (!commandExists('pm2')) return { installed: false };
  let version = 'unknown';
  try {
    const output = execFileSync('pm2', ['--version'], {
      encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    // PM2 prints ASCII banner on first daemon spawn; extract the semver line
    const match = output.match(/(\d+\.\d+\.\d+)/);
    if (match) version = match[1];
  } catch {}
  return { installed: true, version };
}

async function checkNetwork(env, apiHost) {
  const results = { dns: false, proxy: null, reachable: false, details: {} };
  const proxy = env.get('HTTPS_PROXY') || env.get('https_proxy') || process.env.HTTPS_PROXY || '';

  if (proxy) {
    results.proxy = proxy;
  }

  // DNS check
  try {
    const addrs = await dns.resolve4(apiHost);
    results.dns = true;
    results.details.resolved = addrs[0];
  } catch (err) {
    results.details.dnsError = err.code || err.message;
    return results;
  }

  // Reachability check
  if (commandExists('curl')) {
    try {
      const curlArgs = ['-s', '--connect-timeout', '5', '--max-time', '10',
        '-o', '/dev/null', '-w', '%{http_code}'];
      if (proxy) curlArgs.push('--proxy', proxy);
      curlArgs.push(`https://${apiHost}/`);
      const code = execFileSync('curl', curlArgs, {
        encoding: 'utf8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      // Any HTTP response (even 4xx) means network works
      results.reachable = true;
      results.details.httpCode = code;
    } catch {
      // If curl itself fails, check if proxy is the issue
      if (proxy) {
        try {
          const directArgs = ['-s', '--connect-timeout', '5', '--max-time', '10',
            '-o', '/dev/null', '-w', '%{http_code}', `https://${apiHost}/`];
          execFileSync('curl', directArgs, {
            encoding: 'utf8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'],
          });
          results.details.proxyIssue = true;
        } catch {
          results.details.proxyIssue = false;
        }
      }
    }
  } else {
    // Fallback: node https (no proxy support)
    try {
      await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: apiHost, port: 443, path: '/', method: 'HEAD', timeout: 10000,
        }, (res) => {
          results.reachable = true;
          results.details.httpCode = String(res.statusCode);
          res.resume();
          resolve();
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        req.end();
      });
    } catch {
      // Cannot reach — note proxy can't be tested without curl
      if (proxy) {
        results.details.noCurl = true;
      }
    }
  }

  return results;
}

function checkClaudeCli() {
  if (!commandExists('claude')) return { installed: false };
  let version = 'unknown';
  try {
    version = execFileSync('claude', ['--version'], {
      encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {}
  return { installed: true, version };
}

function checkCodexCli() {
  if (!commandExists('codex')) return { installed: false };
  let version = 'unknown';
  try {
    version = execFileSync('codex', ['--version'], {
      encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'],
    }).trim().split('\n')[0];
  } catch {}
  return { installed: true, version };
}

function checkAutonomousMode() {
  try {
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    return !!settings.skipDangerousModePermissionPrompt;
  } catch {
    return false;
  }
}

function checkPm2Services() {
  try {
    const output = execFileSync('pm2', ['jlist'], {
      encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const procs = JSON.parse(output);
    const activityMon = procs.find(p => p.name === 'activity-monitor');
    return {
      running: true,
      total: procs.length,
      online: procs.filter(p => p.pm2_env?.status === 'online').length,
      activityMonitor: activityMon?.pm2_env?.status === 'online',
      procs,
    };
  } catch {
    return { running: false, total: 0, online: 0, activityMonitor: false, procs: [] };
  }
}

function checkTmuxSession(session) {
  try {
    execFileSync('tmux', [C.hasSession, '-t', `=${session}`], {
      stdio: 'pipe', timeout: 30000,
    });
    return true;
  } catch {
    return false;
  }
}

// ── Diagnostics collection ───────────────────────────────────────

export async function readDoctorSessionModeStatus({ readStatus = readSessionModeStatus,
  databaseExists = () => fs.statSync(path.join(ZYLOS_DIR, 'comm-bridge', 'c4.db'), { throwIfNoEntry: false }) !== undefined } = {}) {
  try {
    if (!databaseExists()) return { status: null, error: { code: 'DB_NOT_FOUND', message: 'C4 database is not initialized' }, skipped: true };
    return { status: await readStatus(), error: null, skipped: false };
  } catch (error) {
    return { status: null, error: { code: error.code ?? 'READ_FAILED', message: error.message }, skipped: false };
  }
}

export function formatDoctorSessionModeStatus(value) {
  if (!value) return [];
  if (value.error) return [`Session mode status unavailable: ${value.error.code}: ${value.error.message}`];
  const { transition, globalGate, blocked } = value.status;
  const lines = [`Mode transition: ${transition ? `${transition.sourceMode} -> ${transition.targetMode} (${transition.phase})` : 'none'}`,
    `Global gate: ${globalGate.present ? 'present' : 'absent'}`];
  if (blocked) lines.push(`Mode transition blocked: ${blocked.reason}`);
  return lines;
}

export async function collectDiagnostics(env, { resolve = resolveCliSession, network = checkNetwork,
  pm2Check = checkPm2Installed, tmuxCheck = checkTmuxInstalled, modeStatus = readDoctorSessionModeStatus } = {}) {
  const selected = await resolve();
  const runtime = selected.runtime;
  const display = runtime === 'unknown' ? 'Unknown runtime' : runtime === 'codex' ? 'Codex' : 'Claude';
  const apiHost = runtime === 'unknown' ? null : runtime === 'codex' ? 'api.openai.com' : 'api.anthropic.com';
  const networkPromise = apiHost ? network(env, apiHost) : Promise.resolve({ dns: false, proxy: null, reachable: false, reason: 'runtime_unknown', details: {} });

  const tmux = tmuxCheck();
  const pm2 = pm2Check();
  const envFile = ensureEnvFilePrivate();
  const net = await networkPromise;

  // Runtime-specific CLI/auth checks.
  // Both runtimes use adapter.checkAuth() for consistency with the running process.
  let cli, authStatus, autonomous;
  if (runtime === 'unknown') {
    cli = { installed: false, reason: 'runtime_unknown' };
    authStatus = 'uncertain';
    autonomous = false;
  } else if (runtime !== 'codex') {
    cli = checkClaudeCli();
    authStatus = cli.installed ? (await selected.adapter.checkAuth()).status : 'failure';
    autonomous = cli.installed ? checkAutonomousMode() : false;
  } else {
    // Codex runtime — check Codex CLI and auth status.
    cli = checkCodexCli();
    authStatus = cli.installed ? (await selected.adapter.checkAuth()).status : 'failure';
    autonomous = true; // not applicable for Codex
  }
  const auth = authStatus === 'success';

  const services = pm2.installed
    ? checkPm2Services()
    : { running: false, total: 0, online: 0, activityMonitor: false, procs: [] };
  const session = tmux.installed ? checkTmuxSession(selected.live.tmuxName) : false;
  const sessionMode = selected.sessionGroup == null ? 'single' : 'multi';
  const sessionModeStatus = await modeStatus();
  let origin = null, targetRuntime = null, originNeed = null;
  if (sessionMode === 'multi' && selected.sessionGroup === 'origin' && !session) {
    const status = await collectStatus();
    originNeed = status.originNeed;
    try { targetRuntime = await resolveTargetRuntime('origin'); } catch { /* Unknown target leaves health undecided. */ }
    origin = describeOrigin({ ...status, targetRuntime, nowSec: Math.floor(status.readAt / 1000) });
  }

  return {
    runtime, display, apiHost, sessionMode, sessionModeStatus, sessionGroup: selected.sessionGroup ?? null, origin, targetRuntime, originNeed,
    system: { tmux, pm2, network: net, envFile },
    ai: { cli, auth, authStatus, autonomous, networkSkipped: !net.reachable },
    services: { ...services, session },
  };
}

// ── JSON builder ─────────────────────────────────────────────────

export function buildDiagnosticJson(diag, coreVersion) {
  const issues = [];
  const modeStatus = diag.sessionModeStatus;
  if (modeStatus?.error && !modeStatus.skipped) {
    issues.push({ id: 'session_mode_status_unavailable', label: `Session mode status unavailable: ${modeStatus.error.code}: ${modeStatus.error.message}`,
      hint: 'Run: zylos session-mode status --json' });
  } else if (modeStatus?.status?.blocked) {
    const transition = modeStatus.status.transition;
    issues.push({ id: 'session_mode_transition_blocked',
      label: `Mode transition ${transition.sourceMode} -> ${transition.targetMode} (${transition.phase}) blocked: ${modeStatus.status.blocked.reason}`,
      hint: 'Run: zylos session-mode status --json; inspect the blocker before retrying' });
  }

  if (!diag.system.tmux.installed) {
    issues.push({ id: 'tmux_missing', label: 'tmux not installed', hint: 'Run zylos init' });
  }
  if (!diag.system.pm2.installed) {
    issues.push({ id: 'pm2_missing', label: 'PM2 not installed', hint: 'Run zylos init' });
  }
  if (diag.runtime === 'unknown') {
    issues.push({ id: 'runtime_unknown', label: 'Runtime identity unavailable', hint: 'Inspect the session launch identity before runtime-specific checks' });
  } else if (!diag.system.network.reachable) {
    const net = diag.system.network;
    let hint = 'Check internet connection and firewall settings.';
    if (net.proxy) {
      hint = `Check HTTPS_PROXY in .env (current: ${net.proxy})`;
      if (net.details.proxyIssue) {
        hint += ' — proxy appears down, direct connection works';
      }
    }
    if (!net.dns && net.details.dnsError) {
      hint += ` (DNS: ${net.details.dnsError})`;
    }
    issues.push({ id: 'network_unreachable', label: `Cannot reach ${diag.apiHost}`, hint });
  }
  if (diag.system.envFile?.ok === false) {
    issues.push({ id: 'env_permissions', label: `${ENV_FILE} is accessible to other users (mode ${diag.system.envFile.mode})`,
      hint: `Could not tighten it automatically; as the file's owner run: chmod 600 ${ENV_FILE}` });
  }
  const runtimeLabel = diag.display;
  if (diag.runtime !== 'unknown' && !diag.ai.cli.installed) {
    issues.push({ id: 'cli_missing', label: `${runtimeLabel} CLI not installed`, hint: 'Run zylos init' });
  }
  if (diag.ai.cli.installed && !diag.ai.networkSkipped && diag.ai.authStatus === 'failure') {
    const hint = diag.runtime === 'codex' ? 'Run: codex login' : 'Run zylos init to authenticate';
    issues.push({ id: 'cli_not_authed', label: `${runtimeLabel} not authorized`, hint });
  }
  if (diag.ai.cli.installed && !diag.ai.networkSkipped && diag.ai.authStatus === 'uncertain') {
    issues.push({ id: 'cli_auth_unverified', label: `${runtimeLabel} auth check inconclusive`, hint: 'Retry after network/API health is stable' });
  }
  if (diag.runtime !== 'codex' && diag.ai.cli.installed && diag.ai.auth && !diag.ai.autonomous) {
    issues.push({ id: 'autonomous_off', label: 'Autonomous mode not accepted', hint: 'Set skipDangerousModePermissionPrompt in ~/.claude/settings.json' });
  }
  if (diag.system.pm2.installed) {
    if (!diag.services.running || diag.services.total === 0) {
      issues.push({ id: 'services_down', label: 'PM2 services not started', hint: 'Run: pm2 start ~/zylos/pm2/ecosystem.config.cjs && pm2 save' });
    } else {
      for (const p of diag.services.procs) {
        if (p.pm2_env?.status !== 'online') {
          issues.push({ id: `svc_${p.name}`, label: `${p.name} offline`, hint: `Check: pm2 logs ${p.name}` });
        }
      }
    }
  }

  if (diag.origin?.failure) {
    const descriptions = {
      wake_overdue: { id: 'origin_wake_overdue',
        label: 'Origin has pending work but has not started for over 5 minutes',
        hint: 'Check router startup diagnostics: ~/zylos/comm-bridge/router-events.jsonl (start_always, activate_failed, wait_health)' },
      auth_wait: { id: 'origin_auth_wait',
        label: `Origin is waiting for ${diag.targetRuntime === 'codex' ? 'Codex' : 'Claude'} authentication`,
        hint: diag.targetRuntime === 'codex' ? 'Run: codex login' : 'Run zylos init to authenticate' },
      need_unreadable: { id: 'origin_status_unavailable', label: 'Origin wake status unavailable', hint: 'Run: zylos status --json' },
    };
    if (descriptions[diag.origin.state]) issues.push(descriptions[diag.origin.state]);
  }

  return {
    version: coreVersion.success ? coreVersion.version : null,
    timestamp: new Date().toISOString(),
    passed: issues.length === 0,
    groups: {
      system: {
        passed: diag.system.tmux.installed && diag.system.pm2.installed && diag.system.network.reachable &&
          diag.system.envFile?.ok !== false,
        checks: {
          tmux: { ok: diag.system.tmux.installed, version: diag.system.tmux.version || null,
            sendKeysClientFlag: diag.system.tmux.useClientFlag ?? false,
            versionReason: diag.system.tmux.reason ?? null },
          pm2: { ok: diag.system.pm2.installed, version: diag.system.pm2.version || null },
          network: { ok: diag.system.network.reachable, host: diag.apiHost, proxy: diag.system.network.proxy || null },
          envFile: { ok: diag.system.envFile?.ok !== false, mode: diag.system.envFile?.mode ?? null,
            fixed: diag.system.envFile?.fixed === true },
        },
      },
      ai_service: {
        passed: diag.ai.networkSkipped ? null : (diag.ai.cli.installed && diag.ai.auth && diag.ai.autonomous),
        skipped: diag.ai.networkSkipped,
        checks: {
          cli: { ok: diag.ai.cli.installed, version: diag.ai.cli.version || null },
          auth: { ok: diag.ai.auth, status: diag.ai.authStatus },
          autonomous: { ok: diag.ai.autonomous },
        },
      },
      services: {
        passed: diag.services.running && diag.services.total > 0 &&
          diag.services.procs.every(p => p.pm2_env?.status === 'online') && !diag.origin?.failure &&
          !(modeStatus?.error && !modeStatus.skipped) && !modeStatus?.status?.blocked,
        procs: diag.services.procs.map(p => ({ name: p.name, status: p.pm2_env?.status || 'unknown' })),
        session: { active: diag.services.session, origin: diag.origin?.state ?? null },
        sessionModeStatus: modeStatus ?? null,
      },
    },
    issues,
  };
}

// ── Display builders ─────────────────────────────────────────────

function displaySystemGroup(diag, jsonGroup) {
  const checks = [];
  const { tmux, pm2: pm2Info, network: net } = diag.system;

  if (tmux.installed) {
    checks.push(describeTmuxSendKeys(tmux));
  } else {
    checks.push(red('tmux not installed'));
  }

  if (pm2Info.installed) {
    checks.push(`PM2 ${dim(`v${pm2Info.version}`)}`);
  } else {
    checks.push(red('PM2 not installed'));
  }

  if (net.reachable) {
    let label = `network: ${diag.apiHost} reachable`;
    if (net.proxy) label += dim(' (via proxy)');
    checks.push(label);
  } else {
    if (!net.dns) {
      checks.push(red(`network: DNS failed for ${diag.apiHost}`));
    } else {
      checks.push(red(`network: cannot reach ${diag.apiHost}`));
    }
  }

  if (diag.system.envFile?.ok === false) {
    checks.push(red(`.env accessible to other users (mode ${diag.system.envFile.mode})`));
  } else if (diag.system.envFile?.fixed) {
    checks.push(`.env permissions: ${green('fixed')} ${dim(`(${diag.system.envFile.previousMode} → ${diag.system.envFile.mode})`)}`);
  }

  displayCheckGroup('System', jsonGroup.passed ? 'pass' : 'fail', checks);
  logToFile(`check: system — ${jsonGroup.passed ? 'passed' : 'failed'}`);
}

function displayAiGroup(diag, jsonGroup) {
  if (jsonGroup.skipped) {
    console.log(groupHeader('AI Service', 'skip'));
    console.log(SKIP('skipped (requires network)'));
    logToFile('check: ai_service — skipped');
    return;
  }

  const checks = [];
  const { cli, auth, authStatus, autonomous } = diag.ai;

  const cliLabel = diag.runtime === 'codex' ? 'Codex CLI' : 'Claude CLI';
  if (cli.installed) {
    checks.push(`${cliLabel} ${dim(cli.version ?? '')}`);
  } else {
    checks.push(red(`${cliLabel} not installed`));
  }

  if (cli.installed) {
    if (authStatus === 'success') {
      checks.push('authorized');
    } else if (authStatus === 'uncertain') {
      checks.push(yellow('auth check inconclusive'));
    } else {
      checks.push(red('not authorized'));
    }
    if (auth) {
      if (autonomous) {
        checks.push('autonomous mode accepted');
      } else {
        checks.push(red('autonomous mode not accepted'));
      }
    }
  } else {
    checks.push(dim('auth check skipped (requires CLI)'));
  }

  const status = jsonGroup.passed ? 'pass' : 'fail';
  displayCheckGroup('AI Service', status, checks);
  logToFile(`check: ai_service — ${jsonGroup.passed ? 'passed' : 'failed'}`);
}

function displayServiceGroup(diag, jsonGroup) {
  const modeChecks = formatDoctorSessionModeStatus(diag.sessionModeStatus);
  if (!diag.system.pm2.installed) {
    console.log(groupHeader('Services', 'skip'));
    console.log(SKIP('skipped (requires PM2)'));
    for (const check of modeChecks) console.log(SUB_LAST(check));
    logToFile('check: services — skipped');
    return;
  }

  const checks = [...modeChecks];
  const { running, total, procs, activityMonitor, session } = diag.services;

  if (!running || total === 0) {
    checks.push(red('no services running'));
  } else {
    for (const proc of procs) {
      const status = proc.pm2_env?.status;
      if (status === 'online') {
        checks.push(`${proc.name}: ${green('online')}`);
      } else {
        checks.push(red(`${proc.name}: ${status || 'stopped'}`));
      }
    }
  }

  const originMessage = diag.origin && formatOriginDescription(diag.origin, diag.targetRuntime, diag.originNeed);
  if (session) {
    checks.push(`${diag.display} session: ${green('active')}`);
  } else if (originMessage) {
    const color = diag.origin.failure ? red : yellow;
    checks.push(color(originMessage));
  } else if (diag.sessionMode === 'multi') {
    checks.push(dim('session: not running (starts on the next message for this group)'));
  } else if (activityMonitor) {
    checks.push(yellow(`${diag.display} session: starting...`));
  } else {
    checks.push(dim(`${diag.display} session: waiting`));
  }

  displayCheckGroup('Services', jsonGroup.passed ? 'pass' : 'fail', checks);
  logToFile(`check: services — ${jsonGroup.passed ? 'passed' : 'failed'}`);
}

// ── Channel discovery ────────────────────────────────────────────

export function webConsoleRemovalWarnings({ skillsDir = SKILLS_DIR, env = readEnvFile() } = {}) {
  const warnings = [];
  if (fs.existsSync(path.join(skillsDir, 'web-console'))) warnings.push('Old Web Console code remains. Run zylos init to retry cleanup.');
  if (env.has('WEB_CONSOLE_MAX_UPLOAD_MB')) warnings.push('WEB_CONSOLE_MAX_UPLOAD_MB remains in .env. Run zylos init to retry its rename to DASHBOARD_MAX_UPLOAD_MB.');
  return warnings;
}

export function discoverChannels(pm2Procs, env, tmuxSession, components, { zylosDir = ZYLOS_DIR } = {}) {
  const channels = [];

  // tmux channel — only show when session is active
  if (tmuxSession) {
    channels.push({
      name: 'tmux',
      action: 'zylos attach',
      type: 'terminal',
      online: true,
    });
  }

  const caddy = pm2Procs.find(p => p.name === 'caddy');
  // Dashboard — built-in, check PM2. The address is the one init prints: the public route when Caddy runs,
  // otherwise the local port.
  const dashboard = pm2Procs.find(p => p.name === 'zylos-dashboard');
  if (dashboard) {
    let action, warning = null;
    try {
      action = dashboardAccessAddress({ zylosDir, routed: caddy?.pm2_env?.status === 'online' }).url;
    } catch (error) {
      action = 'address unknown';
      warning = error.message;
    }
    channels.push({
      name: 'Dashboard',
      action,
      type: 'web',
      online: dashboard.pm2_env?.status === 'online',
      warning,
    });
  }

  // Dynamic channels from components.json — use SKILL.md frontmatter type
  for (const [name, info] of Object.entries(components)) {
    const pm2Name = `zylos-${name}`;
    const proc = pm2Procs.find(p => p.name === pm2Name);
    if (!proc) continue;

    // Primary: check SKILL.md frontmatter type field
    let isChannel = false;
    const skillDir = info.skillDir;
    if (skillDir) {
      try {
        const parsed = parseSkillMd(skillDir);
        isChannel = parsed?.frontmatter?.type === 'communication';
      } catch {}
    }

    // Fallback: known channel name patterns (for components without SKILL.md)
    if (!isChannel) {
      isChannel = /^(telegram|lark|feishu|discord|slack|whatsapp|wechat|matrix|botshub)$/i.test(name);
    }

    if (!isChannel) continue;

    channels.push({
      name: name.charAt(0).toUpperCase() + name.slice(1),
      action: `@zylos (${name})`,
      type: 'external',
      online: proc.pm2_env?.status === 'online',
    });
  }

  return channels;
}

// ── Claude auto-fix (Layer 2) ────────────────────────────────────

function isClaudeReady(diag) {
  // Auto-fix via `claude -p` is only available when Claude is the active runtime.
  if (diag.runtime !== 'claude') return false;
  return diag.ai.cli.installed && diag.ai.auth && diag.ai.autonomous && diag.system.network.reachable;
}

function runClaudeFix(diagnosticJson) {
  const issueList = diagnosticJson.issues.map(i => `- ${i.label}`).join('\n');
  const prompt = [
    `You are a Zylos repair agent. Working directory: ${ZYLOS_DIR}`,
    '',
    'Diagnostic report from `zylos doctor --json`:',
    JSON.stringify(diagnosticJson, null, 2),
    '',
    'Fix all issues listed above:',
    issueList,
    '',
    'After fixing, verify by running: zylos doctor --json',
    'Check the output — if "passed" is true, you\'re done. If issues remain, try again (max 2 attempts).',
    '',
    'Rules:',
    '- For missing packages (tmux, PM2): install via apt-get or brew',
    '- For Claude CLI missing: curl -fsSL https://claude.ai/install.sh | bash',
    '- For services offline: pm2 start ~/zylos/pm2/ecosystem.config.cjs && pm2 save',
    '- For autonomous mode: set skipDangerousModePermissionPrompt:true in ~/.claude/settings.json',
    '- For auth issues: you cannot fix these — just note it',
    '',
    'Output a brief summary of each step as you go.',
  ].join('\n');

  logToFile(`claude-fix: starting (${diagnosticJson.issues.length} issues)`);
  console.log(`  ${dim('Claude is fixing issues...')}\n`);

  return new Promise((resolve) => {
    const isRoot = process.getuid?.() === 0;
    const permArgs = isRoot
      ? ['--allowedTools', 'Bash(*)', 'Read', 'Write', 'Edit']
      : ['--dangerously-skip-permissions'];
    const proc = spawn('claude', ['-p', prompt, ...permArgs], {
      cwd: ZYLOS_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let lineBuffer = '';

    proc.stdout.on('data', (d) => {
      const chunk = String(d);
      stdout += chunk;
      // Stream output line by line, strip markdown formatting
      lineBuffer += chunk;
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop(); // keep incomplete last line in buffer
      for (const line of lines) {
        const clean = line.replace(/\*\*/g, '').replace(/`/g, '');
        console.log(`  ${dim(clean)}`);
      }
    });
    proc.stderr.on('data', (d) => { stderr += d; });

    const timer = setTimeout(() => { proc.kill('SIGTERM'); }, CLAUDE_FIX_TIMEOUT);

    proc.on('close', (code, signal) => {
      clearTimeout(timer);
      // Flush remaining buffer
      if (lineBuffer.trim()) {
        console.log(`  ${dim(lineBuffer)}`);
      }

      const output = stdout.trim();
      const error = stderr.trim();

      if (output) logToFile(`claude-fix output: ${output.slice(0, 1000)}`);

      if (signal) {
        logToFile(`claude-fix: killed by ${signal}`);
        resolve({ ok: false, error: `Timed out (${CLAUDE_FIX_TIMEOUT / 1000}s)` });
        return;
      }
      if (code === 0) {
        logToFile('claude-fix: completed');
        resolve({ ok: true });
      } else {
        logToFile(`claude-fix: failed (exit ${code}): ${error.slice(0, 200)}`);
        resolve({ ok: false, error: error || `claude -p exited with code ${code}` });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      logToFile(`claude-fix: exception: ${err.message}`);
      resolve({ ok: false, error: err.message });
    });
  });
}

// ── Main doctor flow ─────────────────────────────────────────────

export async function doctorCommand(args, upstreamSource) {
  const jsonMode = args.includes('--json');
  const checkOnly = args.includes('--check');

  const coreVersion = getCurrentVersion();

  // ── Pre-check: has init been run? ─────────────────────────────

  const initMarkers = [CONFIG_DIR, SKILLS_DIR, COMPONENTS_FILE];
  const initMarkersFound = initMarkers.filter(m => fs.existsSync(m)).length;

  if (initMarkersFound === 0) {
    if (jsonMode) {
      console.log(JSON.stringify({ passed: false, error: 'not_initialized', hint: 'Run zylos init' }));
      process.exit(1);
    }
    console.log(`\n${yellow('Zylos has not been initialized yet.')}\n`);
    console.log(`  Run ${bold('zylos init')} to set up your environment.`);
    console.log(`  ${dim('This will install dependencies (tmux, PM2, Claude CLI),')}`);
    console.log(`  ${dim('configure services, and get everything running.')}\n`);
    logToFile('result: not initialized — suggested zylos init');
    process.exit(1);
  }

  if (initMarkersFound < initMarkers.length) {
    if (jsonMode) {
      console.log(JSON.stringify({ passed: false, error: 'incomplete_init', hint: 'Run zylos init' }));
      process.exit(1);
    }
    console.log(`\n${yellow('Zylos initialization appears incomplete.')}\n`);
    console.log(`  Run ${bold('zylos init')} to complete the setup.\n`);
    logToFile('result: incomplete init — suggested zylos init');
    process.exit(1);
  }

  const env = readEnvFile();
  const components = loadComponents();

  // ── Phase 1: Collect diagnostics ──────────────────────────────

  if (!jsonMode) {
    const versionLabel = coreVersion.success ? ` ${dim(`(v${coreVersion.version})`)}` : '';
    console.log(`\n${heading('Checking your Zylos setup...')}${versionLabel}\n`);
  }
  logToFile('doctor started' + (jsonMode ? ' (--json)' : '') + (coreVersion.success ? ` v${coreVersion.version}` : ''));

  const diag = await collectDiagnostics(env);

  // ── Phase 2: --json mode ──────────────────────────────────────

  if (jsonMode) {
    const json = buildDiagnosticJson(diag, coreVersion);
    console.log(JSON.stringify(json, null, 2));
    logToFile(`result (json): ${json.passed ? 'passed' : `failed (${json.issues.length} issues)`}`);
    process.exit(json.passed ? 0 : 1);
  }

  // ── Phase 3: Build diagnostic JSON + display groups ───────────

  const diagnostic = buildDiagnosticJson(diag, coreVersion);

  displaySystemGroup(diag, diagnostic.groups.system);
  displayAiGroup(diag, diagnostic.groups.ai_service);
  displayServiceGroup(diag, diagnostic.groups.services);
  console.log(`  ${formatAlertTargetNotice(alertTargetNotice())}`);
  for (const warning of webConsoleRemovalWarnings()) console.log(`  ${yellow(warning)}`);
  try {
    if (readSessionMode().mode === 'multi') {
      const capacity = readPoolCapacity();
      if (capacity.valid && capacity.fresh && capacity.record.reason === 'floor') {
        console.log('  Memory fits only Origin; running at most 1 conversation at a time');
      }
    }
  } catch { /* Capacity is informational and does not change diagnostic results. */ }

  // ── Phase 4: Channels ─────────────────────────────────────────

  const procs = diag.services.procs || [];
  if (procs.length > 0 || diag.services.session) {
    const channels = discoverChannels(procs, env, diag.services.session, components);
    const onlineChannels = channels.filter(c => c.online);
    const offlineChannels = channels.filter(c => !c.online);

    console.log(`\n${bold('Channels')}`);
    for (const ch of onlineChannels) {
      const warn = ch.warning ? ` ${yellow(`(${ch.warning})`)}` : '';
      console.log(BULLET_ON(`${ch.name.padEnd(16)} ${dim(ch.action)}${warn}`));
      if (ch.secondaryAction) console.log(`  ${''.padEnd(18)} ${dim(ch.secondaryAction)}`);
      if (ch.hint) console.log(`  ${''.padEnd(18)} ${dim(ch.hint)}`);
    }
    for (const ch of offlineChannels) {
      console.log(BULLET_OFF(`${ch.name.padEnd(16)} ${dim('offline')}`));
    }

    if (offlineChannels.length > 0) {
      if (onlineChannels.length > 0) {
        console.log(`\n  ${dim('To configure offline channels, connect via:')}`);
        for (const ch of onlineChannels) {
          console.log(`    ${dim(ch.action)}`);
        }
      } else {
        console.log(`\n  ${dim('Run')} ${bold('zylos init')} ${dim('to set up channels.')}`);
      }
    }
  }

  // ── Phase 5: Updates ──────────────────────────────────────────

  if (diag.system.network.reachable) {
    try {
      const targets = [];

      if (coreVersion.success) {
        targets.push({ name: 'zylos-core', repo: 'zylos-ai/zylos-core', current: coreVersion.version });
      }

      for (const [name, info] of Object.entries(components)) {
        if (!info.repo || !info.version) continue;
        targets.push({ name, repo: info.repo, current: info.version });
      }

      let prepared;
      try {
        prepared = await prepareUpstreams({ source: upstreamSource });
      } catch (err) {
        console.error(`Upstream version check unavailable: ${err.message}`);
        throw err;
      }
      const results = await withUpstreamSnapshot(prepared, () => concurrentMap(targets, async (target) => {
        try {
          const latest = await fetchLatestTagAsync(target.repo, target.name === 'zylos-core'
            ? { major: target.current.replace(/^v/, '').split('.')[0] } : {});
          if (latest && compareSemverDesc(target.current, latest) > 0) {
            return { ...target, latest };
          }
        } catch (err) {
          logToFile(`warn: version check failed for ${target.name}: ${err.message}`);
        }
        return null;
      }, VERSION_CHECK_CONCURRENCY));

      const updates = results.filter(Boolean);

      if (updates.length > 0) {
        console.log(`\n${bold('Updates available')}`);
        for (const u of updates) {
          console.log(`  ${u.name.padEnd(16)} ${dim(u.current)} → ${green(u.latest)}`);
        }
        console.log(`\n  ${dim("Run")} ${bold('zylos upgrade --all')} ${dim('to update.')}`);
      }
    } catch {} // Optional version checks remain silent; profile setup errors are reported above.
  }

  // ── Phase 6: Handle issues ────────────────────────────────────

  if (diagnostic.passed) {
    const sessionStarting = diag.sessionMode !== 'multi' && diag.services.activityMonitor && !diag.services.session;
    console.log(`\n${green('✓ Everything is working.')}`);
    const originMessage = diag.origin && formatOriginDescription(diag.origin, diag.targetRuntime, diag.originNeed);
    if (originMessage) console.log(`\n  ${dim(originMessage)}`);
    if (sessionStarting) {
      console.log(`\n  ${dim('Claude session is starting — run')} ${bold('zylos attach')} ${dim('in a moment to connect.')}`);
    }
    console.log('');
    logToFile('result: all checks passed');
    process.exit(0);
  }

  const fixable = diagnostic.issues.filter(issue => !isDiagnosticOnlyIssue(issue));
  const claudeReady = !checkOnly && isClaudeReady(diag) && fixable.length > 0;

  // Show issues — hide hints when Claude will auto-fix
  console.log(separator('Issues'));
  for (let i = 0; i < diagnostic.issues.length; i++) {
    const issue = diagnostic.issues[i];
    console.log(`\n  ${bold(`[${i + 1}]`)} ${issue.label}`);
    if ((!claudeReady || isDiagnosticOnlyIssue(issue)) && issue.hint) console.log(`      ${dim(issue.hint)}`);
  }

  // Layer 2: attempt auto-fix via Claude
  if (claudeReady) {
    console.log('');
    logToFile('layer2: starting claude auto-fix');

    const fixResult = await runClaudeFix({ ...diagnostic, issues: fixable });

    // Show error if fix failed
    if (!fixResult.ok && fixResult.error) {
      console.log(`\n  ${red(fixResult.error)}`);
    }

    // Re-verify
    console.log(`\n  ${dim('Re-checking...')}`);
    const rediag = await collectDiagnostics(readEnvFile());
    const reverify = buildDiagnosticJson(rediag, coreVersion);

    if (reverify.passed) {
      const sessionStarting = rediag.sessionMode !== 'multi' && rediag.services.activityMonitor && !rediag.services.session;
      console.log(`\n${green('✓ All issues fixed — everything is working. Enjoy your Zylos!')}`);
      const originMessage = rediag.origin && formatOriginDescription(rediag.origin, rediag.targetRuntime, rediag.originNeed);
      if (originMessage) console.log(`\n  ${dim(originMessage)}`);
      if (sessionStarting) {
        console.log(`\n  ${dim('Claude session is starting — run')} ${bold('zylos attach')} ${dim('in a moment to connect.')}`);
      }
      console.log('');
      logToFile('result: all issues fixed by claude');
      process.exit(0);
    }

    // Still issues — show hints so user knows what to do
    console.log(`\n  ${yellow(`${reverify.issues.length} issue(s) remain:`)}`);
    for (const issue of reverify.issues) {
      console.log(`    ${yellow('○')} ${issue.label}`);
      if (issue.hint) console.log(`      ${dim(issue.hint)}`);
    }
    console.log('');
    logToFile(`result: ${reverify.issues.length} issues remain after claude fix`);
    process.exit(1);
  }

  // No auto-fix — bottom message based on network availability
  if (!diag.system.network.reachable) {
    console.log(`\n  ${yellow('Check your network connection and run')} ${bold('zylos doctor')} ${yellow('again.')}\n`);
  } else {
    console.log(`\n  ${yellow('Run')} ${bold('zylos init')} ${yellow('to set up your environment.')}\n`);
  }
  logToFile('result: issues found, claude not available for auto-fix');
  process.exit(1);
}
