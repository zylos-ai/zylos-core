/**
 * zylos doctor — diagnose installation health, repair startup chain,
 * and guide the user to connect with their Claude agent.
 *
 * Design: https://github.com/zylos-ai/zylos-core/issues/202
 */

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import dns from 'node:dns/promises';
import { ZYLOS_DIR, ENV_FILE, CONFIG_DIR, SKILLS_DIR, COMPONENTS_FILE } from '../lib/config.js';
import { readEnvFile } from '../lib/env.js';
import { loadComponents } from '../lib/components.js';
import { fetchLatestTagAsync, compareSemverDesc } from '../lib/github.js';
import { getCurrentVersion } from '../lib/self-upgrade.js';
import { commandExists } from '../lib/shell-utils.js';
import { promptYesNo } from '../lib/prompts.js';
import { parseSkillMd } from '../lib/skill.js';
import { bold, dim, green, red, yellow, heading } from '../lib/colors.js';

const SESSION = 'claude-main';
const LOG_DIR = path.join(ZYLOS_DIR, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'doctor.log');
const API_HOST = 'api.anthropic.com';
const VERSION_CHECK_CONCURRENCY = 3;

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
  return commandExists('tmux');
}

function checkPm2Installed() {
  if (!commandExists('pm2')) return { installed: false };
  let version = 'unknown';
  try {
    version = execFileSync('pm2', ['--version'], {
      encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {}
  return { installed: true, version };
}

async function checkNetwork(env) {
  const results = { dns: false, proxy: null, reachable: false, details: {} };
  const proxy = env.get('HTTPS_PROXY') || env.get('https_proxy') || process.env.HTTPS_PROXY || '';

  if (proxy) {
    results.proxy = proxy;
  }

  // DNS check
  try {
    const addrs = await dns.resolve4(API_HOST);
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
      curlArgs.push(`https://${API_HOST}/`);
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
            '-o', '/dev/null', '-w', '%{http_code}', `https://${API_HOST}/`];
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
          hostname: API_HOST, port: 443, path: '/', method: 'HEAD', timeout: 10000,
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

function checkClaudeAuth() {
  try {
    const result = spawnSync('claude', ['auth', 'status'], {
      stdio: 'pipe', encoding: 'utf8', timeout: 30000,
    });
    return result.status === 0;
  } catch {
    return false;
  }
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

function checkTmuxSession() {
  try {
    execFileSync('tmux', ['has-session', '-t', SESSION], {
      stdio: 'pipe', timeout: 30000,
    });
    return true;
  } catch {
    return false;
  }
}

// ── Grouped check runners ────────────────────────────────────────

function runAiChecks() {
  const checks = [];
  const failed = [];
  const issues = [];

  const cli = checkClaudeCli();
  if (cli.installed) {
    checks.push(`Claude CLI ${dim(cli.version)}`);
  } else {
    failed.push('CLI not installed');
    checks.push(red('Claude CLI not installed'));
    issues.push({
      label: 'Claude CLI is not installed',
      detail: 'The Claude CLI is required for Zylos to function.',
      fixLabel: 'install Claude CLI',
      fix: fixClaudeCli,
    });
  }

  if (cli.installed) {
    const authOk = checkClaudeAuth();
    if (authOk) {
      checks.push('authorized');
    } else {
      failed.push('not authorized');
      checks.push(red('not authorized'));
      issues.push({
        label: 'Claude is not authorized',
        detail: 'Claude needs authorization to work with Zylos.',
        hint: `Run ${bold('zylos init')} to authenticate.`,
      });
    }
    if (authOk) {
      const autoMode = checkAutonomousMode();
      if (autoMode) {
        checks.push('autonomous mode accepted');
      } else {
        failed.push('autonomous mode');
        checks.push(red('autonomous mode not accepted'));
        issues.push({
          label: 'Autonomous mode not accepted',
          detail: 'Claude needs autonomous mode enabled to run unattended.',
          fixLabel: 'enable autonomous mode in Claude settings',
          fix: fixAutonomousMode,
        });
      }
    }
  } else {
    checks.push(dim('auth check skipped (requires CLI)'));
  }

  return { checks, failed, passed: failed.length === 0, issues };
}

function runServiceChecks() {
  const checks = [];
  const failed = [];
  const issues = [];

  const pm2Result = checkPm2Services();
  if (pm2Result.running && pm2Result.activityMonitor) {
    checks.push(`activity-monitor: ${green('online')}`);
  } else if (pm2Result.running) {
    failed.push('activity-monitor not running');
    checks.push(red('activity-monitor: not running'));
  } else {
    failed.push('PM2 services not started');
    checks.push(red('PM2 services not started'));
  }

  if (!pm2Result.running || !pm2Result.activityMonitor) {
    issues.push({
      label: 'Zylos services are not running',
      detail: 'The activity monitor keeps Claude alive.',
      fixLabel: 'start all services',
      fix: fixServices,
    });
  }

  const sessionOk = checkTmuxSession();
  if (sessionOk) {
    checks.push(`Claude session: ${green('active')}`);
  } else if (pm2Result.activityMonitor) {
    checks.push(yellow('Claude session: starting...'));
  } else {
    failed.push('session not running');
    checks.push(dim('Claude session: waiting'));
  }

  return { checks, failed, passed: failed.length === 0, issues, pm2Result };
}

// ── Fix implementations ──────────────────────────────────────────
// Each fix returns { ok: boolean, error?: string }

function installSystemPackage(pkg) {
  const platform = os.platform();
  const isRoot = process.getuid?.() === 0;

  if (platform === 'darwin') {
    try {
      execFileSync('brew', ['install', pkg], { stdio: 'inherit', timeout: 600000 });
      return { ok: true };
    } catch {
      return { ok: false, error: 'brew install failed — is Homebrew installed?' };
    }
  }

  // Linux: try apt-get first, then yum
  const sequences = [
    { cmds: [['apt-get', 'update'], ['apt-get', 'install', '-y', pkg]], name: 'apt-get' },
    { cmds: [['yum', 'install', '-y', pkg]], name: 'yum' },
  ];

  for (const { cmds, name } of sequences) {
    try {
      for (const args of cmds) {
        if (isRoot) {
          execFileSync(args[0], args.slice(1), { stdio: 'inherit', timeout: 600000 });
        } else {
          execFileSync('sudo', args, { stdio: 'inherit', timeout: 600000 });
        }
      }
      return { ok: true };
    } catch {
      // Try next package manager
    }
  }

  return { ok: false, error: 'package install failed (tried apt-get, yum)' };
}

function fixTmux() {
  const result = installSystemPackage('tmux');
  if (result.ok) return { ok: commandExists('tmux') };
  return { ok: false, error: result.error };
}

function fixPm2() {
  try {
    execFileSync('npm', ['install', '-g', 'pm2'], { stdio: 'inherit', timeout: 600000 });
    return { ok: commandExists('pm2') };
  } catch (err) {
    return { ok: false, error: 'npm install failed' };
  }
}

function fixClaudeCli() {
  const tmpFile = path.join(os.tmpdir(), 'claude-install.sh');
  try {
    execFileSync('curl', ['-fsSL', '-o', tmpFile, 'https://claude.ai/install.sh'], {
      stdio: 'pipe', timeout: 600000,
    });
    execFileSync('sh', [tmpFile], { stdio: 'inherit', timeout: 600000 });
    return { ok: commandExists('claude') };
  } catch (err) {
    return { ok: false, error: 'install script failed' };
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}


function fixAutonomousMode() {
  try {
    const claudeDir = path.join(os.homedir(), '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    const settingsPath = path.join(claudeDir, 'settings.json');
    let settings = {};
    try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch {}
    settings.skipDangerousModePermissionPrompt = true;
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `failed to write settings: ${err.message}` };
  }
}

function fixServices() {
  try {
    const ecosystemFile = path.join(ZYLOS_DIR, 'pm2', 'ecosystem.config.cjs');
    if (fs.existsSync(ecosystemFile)) {
      execFileSync('pm2', ['start', ecosystemFile], { stdio: 'pipe', timeout: 60000 });
      execFileSync('pm2', ['save'], { stdio: 'pipe', timeout: 60000 });
    } else {
      execFileSync('zylos', ['start'], { stdio: 'pipe', timeout: 60000 });
    }
    // Verify activity-monitor actually came online
    const verify = checkPm2Services();
    if (!verify.activityMonitor) {
      return { ok: false, error: 'services started but activity-monitor is not online' };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message?.split('\n')[0] || 'start failed' };
  }
}

// ── Channel discovery ────────────────────────────────────────────

function getNetworkIP() {
  const interfaces = os.networkInterfaces();
  for (const addrs of Object.values(interfaces)) {
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return '';
}

function discoverChannels(pm2Procs, env, tmuxSession, components) {
  const channels = [];

  // tmux is always a channel if session exists
  channels.push({
    name: 'tmux',
    action: 'zylos attach',
    type: 'terminal',
    online: tmuxSession,
  });

  // Web console — built-in, check PM2
  const webConsole = pm2Procs.find(p => p.name === 'web-console');
  const caddy = pm2Procs.find(p => p.name === 'caddy');
  if (webConsole) {
    const caddyOnline = caddy?.pm2_env?.status === 'online';
    const wcOnline = webConsole.pm2_env?.status === 'online';
    const hasPassword = !!(env.get('ZYLOS_WEB_PASSWORD') || env.get('WEB_CONSOLE_PASSWORD'));

    // Use domain URL if Caddy is running, otherwise localhost + network IP
    const port = process.env.WEB_CONSOLE_PORT || '3456';
    let action, secondaryAction, warning, hint;
    warning = null;
    hint = null;
    secondaryAction = null;
    if (caddyOnline) {
      const domain = env.get('DOMAIN') || 'localhost';
      const protocol = env.get('PROTOCOL') || 'https';
      action = `${protocol}://${domain}/console/`;
      if (!hasPassword) warning = 'no password set';
    } else {
      action = `http://localhost:${port}/console/`;
      const ip = getNetworkIP();
      if (ip) secondaryAction = `http://${ip}:${port}/console/`;
    }

    channels.push({
      name: 'Web Console',
      action,
      secondaryAction,
      type: 'web',
      online: wcOnline,
      warning,
      hint,
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

// ── Re-check after fixes ─────────────────────────────────────────

async function recheckAfterFixes(networkOk, attempted, fixed, failed, checkOnly) {
  if (fixed.length === 0) return { pm2Result: null };

  console.log(`\n${dim('Re-checking...')}`);

  const newIssues = [];

  // Re-check AI Service (may reveal auth/autonomous issues after CLI install)
  if (networkOk) {
    const ai = runAiChecks();
    displayCheckGroup('AI Service', ai.passed ? 'pass' : 'fail', ai.checks);
    logToFile(`re-check: ai_service — ${ai.passed ? 'passed' : 'failed'}`);
    // Only collect issues not already attempted
    newIssues.push(...ai.issues.filter(i => !attempted.has(i.label)));
  }

  // Re-check Services
  const svc = runServiceChecks();
  displayCheckGroup('Services', svc.passed ? 'pass' : 'fail', svc.checks);
  logToFile(`re-check: services — ${svc.passed ? 'passed' : 'failed'}`);
  newIssues.push(...svc.issues.filter(i => !attempted.has(i.label)));

  // Offer to fix new issues (batch, same UX as initial)
  const fixable = newIssues.filter(i => i.fix);
  if (fixable.length > 0 && !checkOnly) {
    console.log(separator('Additional Issues'));
    for (let i = 0; i < newIssues.length; i++) {
      const issue = newIssues[i];
      console.log(`\n  ${bold(`[${i + 1}]`)} ${issue.label}`);
      if (issue.detail) console.log(`      ${dim(issue.detail)}`);
      if (issue.fixLabel) console.log(`      Fix: ${issue.fixLabel}`);
      if (issue.hint) console.log(`\n      ${issue.hint}`);
    }

    console.log('');
    const fixPrompt = fixable.length === 1
      ? `Fix this issue? [y/N] `
      : `Fix all ${fixable.length} issues? [y/N] `;
    const shouldFix = await promptYesNo(fixPrompt);

    if (shouldFix) {
      for (let i = 0; i < fixable.length; i++) {
        const issue = fixable[i];
        const progress = fixable.length > 1 ? `[${i + 1}/${fixable.length}] ` : '';
        process.stdout.write(`\n  ${progress}${issue.fixLabel}... `);
        logToFile(`fix: ${issue.label} — user confirmed (re-check)`);

        const result = await issue.fix();
        if (result.ok) {
          console.log(green('✓'));
          logToFile(`fix: ${issue.label} — success (re-check)`);
          fixed.push(issue.label);
        } else {
          console.log(red('✗'));
          if (result.error) console.log(`      ${dim(result.error)}`);
          logToFile(`fix: ${issue.label} — failed (re-check)`);
          failed.push(issue.label);
        }
      }

      // Final re-check Services after additional fixes
      const finalSvc = runServiceChecks();
      return { pm2Result: finalSvc.pm2Result };
    } else {
      for (const issue of fixable) {
        failed.push(`${issue.label} (user declined)`);
      }
      logToFile('re-check: user declined fixes');
    }
  } else if (fixable.length > 0 && checkOnly) {
    console.log(`\n  ${dim(`${fixable.length} additional fixable issue(s).`)}`);
  }

  return { pm2Result: svc.pm2Result };
}

// ── Main doctor flow ─────────────────────────────────────────────

export async function doctorCommand(args) {
  const checkOnly = args.includes('--check');

  const coreVersion = getCurrentVersion();
  const versionLabel = coreVersion.success ? ` ${dim(`(v${coreVersion.version})`)}` : '';
  console.log(`\n${heading('Checking your Zylos setup...')}${versionLabel}\n`);
  logToFile('doctor started' + (checkOnly ? ' (--check)' : '') + (coreVersion.success ? ` v${coreVersion.version}` : ''));

  // ── Pre-check: has init been run? ─────────────────────────────
  const initMarkers = [CONFIG_DIR, SKILLS_DIR, COMPONENTS_FILE];
  const initMarkersFound = initMarkers.filter(m => fs.existsSync(m)).length;

  if (initMarkersFound === 0) {
    console.log(`${yellow('Zylos has not been initialized yet.')}\n`);
    console.log(`  Run ${bold('zylos init')} to set up your environment.`);
    console.log(`  ${dim('This will install dependencies (tmux, PM2, Claude CLI),')}`);
    console.log(`  ${dim('configure services, and get everything running.')}\n`);
    logToFile('result: not initialized — suggested zylos init');
    process.exit(1);
  }

  if (initMarkersFound < initMarkers.length) {
    console.log(`${yellow('Zylos initialization appears incomplete.')}\n`);
    console.log(`  Run ${bold('zylos init')} to complete the setup.\n`);
    logToFile('result: incomplete init — suggested zylos init');
    process.exit(1);
  }

  const env = readEnvFile();
  const components = loadComponents();
  const issues = [];
  let networkOk = true;

  // ── Group 1: System ──────────────────────────────────────────

  // Fire async network check early — overlaps with sync checks below
  const networkPromise = checkNetwork(env);

  const systemChecks = [];
  const systemFailed = [];
  let systemPassed = true;

  // 1a. tmux
  const tmuxOk = checkTmuxInstalled();
  systemChecks.push(tmuxOk ? 'tmux installed' : red('tmux not installed'));
  if (!tmuxOk) {
    systemPassed = false;
    systemFailed.push('tmux missing');
    const isMac = os.platform() === 'darwin';
    const isRoot = process.getuid?.() === 0;
    const tmuxHint = isMac ? 'brew install tmux' : isRoot ? 'apt install tmux' : 'sudo apt install tmux';
    issues.push({
      label: 'tmux is not installed',
      detail: 'tmux is required for the Claude session.',
      fixLabel: `install tmux (${tmuxHint})`,
      fix: fixTmux,
    });
  }

  // 1b. PM2
  const pm2Check = checkPm2Installed();
  const pm2Ok = pm2Check.installed;
  systemChecks.push(pm2Ok ? `PM2 ${dim(`v${pm2Check.version}`)}` : red('PM2 not installed'));
  if (!pm2Ok) {
    systemPassed = false;
    systemFailed.push('PM2 missing');
    issues.push({
      label: 'PM2 is not installed',
      detail: 'PM2 manages Zylos background services.',
      fixLabel: 'install PM2 (npm install -g pm2)',
      fix: fixPm2,
    });
  }

  // 1c. Network — await the already-in-flight promise
  const net = await networkPromise;
  if (net.reachable) {
    let netLabel = `network: ${API_HOST} reachable`;
    if (net.proxy) netLabel += dim(` (via proxy)`);
    systemChecks.push(netLabel);
  } else {
    systemPassed = false;
    systemFailed.push('network unreachable');
    const netDetail = [];
    if (!net.dns) {
      systemChecks.push(red(`network: DNS failed for ${API_HOST}`));
      netDetail.push(`DNS resolution: ${red('failed')} ${dim(`(${net.details.dnsError})`)}`);
    } else {
      systemChecks.push(red(`network: cannot reach ${API_HOST}`));
      netDetail.push(`DNS resolution: ${green('✓')} resolved to ${net.details.resolved}`);
    }
    if (net.proxy) {
      netDetail.push(`Proxy (HTTPS_PROXY): ${net.proxy}`);
      if (net.details.proxyIssue) {
        netDetail.push(`Proxy reachable: ${red('✗')} (direct connection works — proxy may be down)`);
      }
    }
    let netHint;
    if (net.proxy) {
      netHint = `Check HTTPS_PROXY in ${ENV_FILE}\n      Current value: ${net.proxy}`;
      if (net.details.noCurl) {
        netHint += `\n      ${dim('Note: curl not found — proxy diagnostics limited')}`;
      }
    } else {
      netHint = 'Check your internet connection and firewall settings.';
    }
    issues.push({
      label: `Cannot reach AI service (${API_HOST})`,
      detail: netDetail.join('\n      '),
      fixLabel: null, // Cannot auto-fix
      fix: null,
      hint: netHint,
    });
  }

  // Display Group 1
  displayCheckGroup('System', systemPassed ? 'pass' : 'fail', systemChecks);
  logToFile(`check: system — ${systemPassed ? 'passed' : `failed (${systemFailed.join(', ')})`}`);

  // If network failed, skip network-dependent groups
  if (!net.reachable) {
    networkOk = false;
  }

  // ── Group 2: AI Service ──────────────────────────────────────

  if (!networkOk) {
    console.log(groupHeader('AI Service', 'skip'));
    console.log(SKIP('skipped (requires network)'));
    logToFile('check: ai_service — skipped');
  } else {
    const ai = runAiChecks();
    issues.push(...ai.issues);
    displayCheckGroup('AI Service', ai.passed ? 'pass' : 'fail', ai.checks);
    logToFile(`check: ai_service — ${ai.passed ? 'passed' : `failed (${ai.failed.join(', ')})`}`);
  }

  // ── Group 3: Services ────────────────────────────────────────

  let pm2Result = null;

  {
    const svc = runServiceChecks();
    issues.push(...svc.issues);
    pm2Result = svc.pm2Result;
    displayCheckGroup('Services', svc.passed ? 'pass' : 'fail', svc.checks);
    logToFile(`check: services — ${svc.passed ? 'passed' : `failed (${svc.failed.join(', ')})`}`);
  }

  // ── Handle issues ────────────────────────────────────────────

  const failed = [];
  const fixed = [];
  let manual = [];

  if (issues.length > 0) {
    const fixable = issues.filter(i => i.fix);
    manual = issues.filter(i => !i.fix);

    console.log(separator('Issues'));

    for (let i = 0; i < issues.length; i++) {
      const issue = issues[i];
      console.log(`\n  ${bold(`[${i + 1}]`)} ${issue.label}`);
      if (issue.detail) {
        console.log(`      ${dim(issue.detail)}`);
      }
      if (issue.fixLabel) {
        console.log(`      Fix: ${issue.fixLabel}`);
      }
      if (issue.hint) {
        console.log(`\n      ${issue.hint}`);
      }
    }

    // Manual-only issues — can't fix, just report
    if (fixable.length === 0) {
      console.log(`\n  ${yellow('Cannot proceed — fix the issues above and run')} ${bold('zylos doctor')} ${yellow('again.')}`);
      logToFile('result: issues found, no auto-fix available');
      process.exit(1);
    }

    // Check-only mode
    if (checkOnly) {
      console.log(`\n  ${dim(`${fixable.length} fixable issue(s). Run`)} ${bold('zylos doctor')} ${dim('(without --check) to fix.')}`);
      logToFile('result: issues found, --check mode');
      process.exit(1);
    }

    // Ask to fix
    console.log('');
    const fixPrompt = fixable.length === 1
      ? `Fix this issue? [y/N] `
      : `Fix all ${fixable.length} issues? [y/N] `;
    const shouldFix = await promptYesNo(fixPrompt);

    if (!shouldFix) {
      console.log(`\n  ${dim('Skipped. Run')} ${bold('zylos doctor')} ${dim('when ready.')}`);
      logToFile('result: user declined fixes');
      process.exit(1);
    }

    // Apply fixes
    for (let i = 0; i < fixable.length; i++) {
      const issue = fixable[i];
      const progress = fixable.length > 1 ? `[${i + 1}/${fixable.length}] ` : '';
      process.stdout.write(`\n  ${progress}${issue.fixLabel}... `);
      logToFile(`fix: ${issue.label} — user confirmed`);

      const result = await issue.fix();
      if (result.ok) {
        console.log(green('✓'));
        logToFile(`fix: ${issue.label} — success`);
        fixed.push(issue.label);
      } else {
        console.log(red('✗'));
        if (result.error) {
          console.log(`      ${dim(result.error)}`);
        }
        logToFile(`fix: ${issue.label} — failed${result.error ? ` (${result.error})` : ''}`);
        failed.push(issue.label);
      }
    }

    // Re-check after fixes (may reveal new issues, e.g. auth after CLI install)
    const attempted = new Set([...fixed, ...failed]);
    const recheck = await recheckAfterFixes(networkOk, attempted, fixed, failed, checkOnly);
    if (recheck.pm2Result) {
      pm2Result = recheck.pm2Result;
    }
  }

  // ── Group 4: Channels ────────────────────────────────────────

  let offlineChannels = [];
  const procs = pm2Result?.procs || [];
  const tmuxSession = checkTmuxSession();
  if (procs.length > 0 || tmuxSession) {
    const channels = discoverChannels(procs, env, tmuxSession, components);
    const onlineChannels = channels.filter(c => c.online);
    offlineChannels = channels.filter(c => !c.online);

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

  // ── Group 5: Updates ────────────────────────────────────────

  if (networkOk) {
    try {
      const targets = [];

      // Check zylos-core itself
      if (coreVersion.success) {
        targets.push({ name: 'zylos-core', repo: 'zylos-ai/zylos-core', current: coreVersion.version });
      }

      // Check installed components
      for (const [name, info] of Object.entries(components)) {
        if (!info.repo || !info.version) continue;
        targets.push({ name, repo: info.repo, current: info.version });
      }

      // Fetch all versions concurrently with limit
      const results = await concurrentMap(targets, async (target) => {
        try {
          const latest = await fetchLatestTagAsync(target.repo);
          // Only show update when latest is strictly newer (semver comparison)
          if (latest && compareSemverDesc(target.current, latest) > 0) {
            return { ...target, latest };
          }
        } catch (err) {
          logToFile(`warn: version check failed for ${target.name}: ${err.message}`);
        }
        return null;
      }, VERSION_CHECK_CONCURRENCY);

      const updates = results.filter(Boolean);

      if (updates.length > 0) {
        console.log(`\n${bold('Updates available')}`);
        for (const u of updates) {
          console.log(`  ${u.name.padEnd(16)} ${dim(u.current)} → ${green(u.latest)}`);
        }
        console.log(`\n  ${dim("Run")} ${bold('zylos upgrade --all')} ${dim('to update.')}`);
      }
    } catch {}
  }

  // ── Summary ─────────────────────────────────────────────────

  const hasFixActivity = fixed.length > 0 || failed.length > 0 || manual.length > 0;

  if (hasFixActivity) {
    console.log(separator('Summary'));

    if (fixed.length > 0) {
      console.log(`\n  ${green('Fixed:')}`);
      fixed.forEach(f => console.log(`    ${green('✓')} ${f}`));
    }
    if (failed.length > 0) {
      console.log(`\n  ${red('Failed:')}`);
      failed.forEach(f => console.log(`    ${red('✗')} ${f}`));
    }
    if (manual.length > 0 || offlineChannels.length > 0) {
      console.log(`\n  ${yellow('Needs attention:')}`);
      manual.forEach(m => console.log(`    ${yellow('○')} ${m.label}`));
      offlineChannels.forEach(ch => console.log(`    ${yellow('○')} ${ch.name} offline`));
    }
  }

  // ── Final status ─────────────────────────────────────────────

  if (issues.length === 0) {
    console.log(`\n${green('✓ Everything is working.')}\n`);
    logToFile('result: all checks passed');
    process.exit(0);
  } else if (!checkOnly && failed.length === 0 && manual.length === 0) {
    console.log(`\n${green('✓ All issues fixed.')}\n`);
    logToFile('result: all issues fixed');
    process.exit(0);
  } else {
    console.log('');
    logToFile('result: issues remain');
    process.exit(1);
  }
}
