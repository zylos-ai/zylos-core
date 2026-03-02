/**
 * zylos doctor — diagnose installation health, repair startup chain,
 * and guide the user to connect with their Claude agent.
 *
 * Design: https://github.com/zylos-ai/zylos-core/issues/202
 */

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dns from 'node:dns/promises';
import { ZYLOS_DIR, ENV_FILE } from '../lib/config.js';
import { readEnvFile } from '../lib/env.js';
import { loadComponents } from '../lib/components.js';
import { fetchLatestTag } from '../lib/github.js';
import { getCurrentVersion } from '../lib/self-upgrade.js';
import { commandExists } from '../lib/shell-utils.js';
import { promptYesNo } from '../lib/prompts.js';
import { parseSkillMd } from '../lib/skill.js';
import { bold, dim, green, red, yellow, heading } from '../lib/colors.js';

const SESSION = 'claude-main';
const LOG_DIR = path.join(ZYLOS_DIR, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'doctor.log');
const API_HOST = 'api.anthropic.com';

// ── Logging ──────────────────────────────────────────────────────

function logToFile(message) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
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

  // Reachability check — try a lightweight HTTPS request
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
  } catch (err) {
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

// ── Fix implementations ──────────────────────────────────────────
// Each fix returns { ok: boolean, error?: string }

function fixTmux() {
  const platform = os.platform();
  try {
    if (platform === 'darwin') {
      execFileSync('brew', ['install', 'tmux'], { stdio: 'inherit', timeout: 600000 });
    } else {
      execFileSync('sudo', ['apt-get', 'install', '-y', 'tmux'], { stdio: 'inherit', timeout: 600000 });
    }
    return { ok: commandExists('tmux') };
  } catch (err) {
    const hint = platform === 'darwin'
      ? 'brew install failed — is Homebrew installed?'
      : 'apt-get install failed';
    return { ok: false, error: hint };
  }
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

function fixClaudeAuth() {
  try {
    spawnSync('claude', ['login'], { stdio: 'inherit' });
    const ok = checkClaudeAuth();
    return { ok, error: ok ? undefined : 'login completed but auth check still fails' };
  } catch (err) {
    return { ok: false, error: 'claude login failed' };
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

function discoverChannels(pm2Procs, env, tmuxSession) {
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
    const domain = env.get('DOMAIN') || 'localhost';
    const protocol = env.get('PROTOCOL') || 'https';
    const hasPassword = !!(env.get('ZYLOS_WEB_PASSWORD') || env.get('WEB_CONSOLE_PASSWORD'));
    channels.push({
      name: 'Web Console',
      action: `${protocol}://${domain}`,
      type: 'web',
      online: webConsole.pm2_env?.status === 'online' && caddy?.pm2_env?.status === 'online',
      warning: !hasPassword ? 'no password set' : null,
    });
  }

  // Dynamic channels from components.json — use SKILL.md frontmatter type
  const components = loadComponents();

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

// ── Main doctor flow ─────────────────────────────────────────────

export async function doctorCommand(args) {
  const checkOnly = args.includes('--check');

  console.log(`\n${heading('Checking your Zylos setup...')}\n`);
  logToFile('doctor started' + (checkOnly ? ' (--check)' : ''));

  const env = readEnvFile();
  const issues = [];
  let skipRemaining = false;

  // ── Group 1: System ──────────────────────────────────────────

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
    issues.push({
      label: 'tmux is not installed',
      detail: 'tmux is required for the Claude session.',
      fixLabel: isMac ? 'install tmux (brew install tmux)' : 'install tmux (sudo apt install tmux)',
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

  // 1c. Network
  const net = await checkNetwork(env);
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
    issues.push({
      label: `Cannot reach AI service (${API_HOST})`,
      detail: netDetail.join('\n      '),
      fixLabel: null, // Cannot auto-fix
      fix: null,
      hint: net.proxy
        ? `Check HTTPS_PROXY in ${ENV_FILE}\n      Current value: ${net.proxy}`
        : 'Check your internet connection and firewall settings.',
    });
  }

  // Display Group 1
  console.log(groupHeader('System', systemPassed ? 'pass' : 'fail'));
  for (let i = 0; i < systemChecks.length; i++) {
    console.log(i < systemChecks.length - 1 ? SUB(systemChecks[i]) : SUB_LAST(systemChecks[i]));
  }
  logToFile(`check: system — ${systemPassed ? 'passed' : `failed (${systemFailed.join(', ')})`}`);

  // If network failed, skip remaining groups
  if (!net.reachable) {
    skipRemaining = true;
  }

  // ── Group 2: AI Service ──────────────────────────────────────

  const aiChecks = [];
  const aiFailed = [];
  let aiPassed = true;

  if (skipRemaining) {
    console.log(groupHeader('AI Service', 'skip'));
    console.log(SKIP('skipped (requires network)'));
    logToFile('check: ai_service — skipped');
  } else {
    const cli = checkClaudeCli();
    if (cli.installed) {
      aiChecks.push(`Claude CLI ${dim(cli.version)}`);
    } else {
      aiPassed = false;
      aiFailed.push('CLI not installed');
      aiChecks.push(red('Claude CLI not installed'));
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
        aiChecks.push('authorized');
      } else {
        aiPassed = false;
        aiFailed.push('not authorized');
        aiChecks.push(red('not authorized'));
        issues.push({
          label: 'Claude is not authorized',
          detail: 'Claude needs API authorization to work.',
          fixLabel: 'opens the Claude login flow (interactive)',
          fix: fixClaudeAuth,
        });
      }
      // Check autonomous mode (terms acceptance)
      if (authOk) {
        const autoMode = checkAutonomousMode();
        if (autoMode) {
          aiChecks.push('autonomous mode accepted');
        } else {
          aiPassed = false;
          aiFailed.push('autonomous mode');
          aiChecks.push(red('autonomous mode not accepted'));
          issues.push({
            label: 'Autonomous mode not accepted',
            detail: 'Claude needs autonomous mode enabled to run unattended.',
            fixLabel: 'enable autonomous mode in Claude settings',
            fix: fixAutonomousMode,
          });
        }
      }
    } else {
      aiChecks.push(dim('auth check skipped (requires CLI)'));
    }

    console.log(groupHeader('AI Service', aiPassed ? 'pass' : 'fail'));
    for (let i = 0; i < aiChecks.length; i++) {
      console.log(i < aiChecks.length - 1 ? SUB(aiChecks[i]) : SUB_LAST(aiChecks[i]));
    }
    logToFile(`check: ai_service — ${aiPassed ? 'passed' : `failed (${aiFailed.join(', ')})`}`);

    if (!aiPassed) skipRemaining = true;
  }

  // ── Group 3: Services ────────────────────────────────────────

  const svcChecks = [];
  const svcFailed = [];
  let svcPassed = true;
  let pm2Result = null;

  if (skipRemaining) {
    console.log(groupHeader('Services', 'skip'));
    console.log(SKIP('skipped (requires AI Service)'));
    logToFile('check: services — skipped');
  } else {
    pm2Result = checkPm2Services();
    if (pm2Result.running && pm2Result.activityMonitor) {
      svcChecks.push(`activity-monitor: ${green('online')}`);
    } else if (pm2Result.running) {
      svcPassed = false;
      svcFailed.push('activity-monitor not running');
      svcChecks.push(red('activity-monitor: not running'));
    } else {
      svcPassed = false;
      svcFailed.push('PM2 services not started');
      svcChecks.push(red('PM2 services not started'));
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
      svcChecks.push(`Claude session: ${green('active')}`);
    } else if (pm2Result.activityMonitor) {
      // activity-monitor is running but session isn't up yet — might be starting
      svcChecks.push(yellow('Claude session: starting...'));
    } else {
      svcPassed = false;
      svcFailed.push('session not running');
      svcChecks.push(dim('Claude session: waiting'));
    }

    console.log(groupHeader('Services', svcPassed ? 'pass' : 'fail'));
    for (let i = 0; i < svcChecks.length; i++) {
      console.log(i < svcChecks.length - 1 ? SUB(svcChecks[i]) : SUB_LAST(svcChecks[i]));
    }
    logToFile(`check: services — ${svcPassed ? 'passed' : `failed (${svcFailed.join(', ')})`}`);
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

    // Re-check skipped groups after fixes
    if (fixed.length > 0 && skipRemaining) {
      console.log(`\n${dim('Continuing checks...')}`);

      // Re-check what was skipped (network issues are manual-only, so
      // skipRemaining here means AI Service was the blocker)
      if (net.reachable) {
        const cli2 = checkClaudeCli();
        const auth2 = cli2.installed ? checkClaudeAuth() : false;

        if (cli2.installed && auth2) {
          // Check autonomous mode too
          let autoMode2 = checkAutonomousMode();
          if (!autoMode2) {
            const enableOk = await promptYesNo('Autonomous mode not accepted. Enable it? [y/N] ');
            if (enableOk) {
              logToFile('fix: autonomous mode — user confirmed (re-check)');
              const autoResult = fixAutonomousMode();
              if (autoResult.ok) {
                autoMode2 = true;
              } else {
                failed.push('Enable autonomous mode');
                logToFile(`fix: autonomous mode — failed (re-check)${autoResult.error ? ` (${autoResult.error})` : ''}`);
              }
            } else {
              failed.push('Autonomous mode (user declined)');
              logToFile('fix: autonomous mode — user declined (re-check)');
            }
          }

          const aiPass2 = autoMode2;
          console.log(groupHeader('AI Service', aiPass2 ? 'pass' : 'fail'));
          console.log(SUB(`Claude CLI ${dim(cli2.version)}`));
          console.log(SUB('authorized'));
          console.log(SUB_LAST(autoMode2 ? 'autonomous mode accepted' : red('autonomous mode not accepted')));
          logToFile(`re-check: ai_service — ${aiPass2 ? 'passed' : 'failed'}`);

          // Now check services
          const svc2 = checkPm2Services();

          if (!svc2.activityMonitor) {
            const startOk = await promptYesNo('Services are not running. Start them? [y/N] ');
            if (startOk) {
              logToFile('fix: services — user confirmed (re-check)');
              const svcResult = fixServices();
              if (svcResult.ok) {
                // Wait a moment for activity-monitor to create session
                await new Promise(r => setTimeout(r, 3000));
              } else {
                failed.push('Start services');
                logToFile(`fix: services — failed (re-check)${svcResult.error ? ` (${svcResult.error})` : ''}`);
              }
            } else {
              failed.push('Start services (user declined)');
              logToFile('fix: services — user declined (re-check)');
            }
          }

          const svc3 = checkPm2Services();
          const session3 = checkTmuxSession();

          console.log(groupHeader('Services', svc3.activityMonitor ? 'pass' : 'fail'));
          console.log(SUB(`activity-monitor: ${svc3.activityMonitor ? green('online') : red('offline')}`));
          console.log(SUB_LAST(`Claude session: ${session3 ? green('active') : yellow('starting...')}`));
          logToFile(`re-check: services — ${svc3.activityMonitor ? 'passed' : 'failed'}`);

          if (!svc3.activityMonitor) {
            failed.push('Services still not running after re-check');
          }

          pm2Result = svc3;
        } else {
          // AI Service re-check failed
          console.log(groupHeader('AI Service', 'fail'));
          if (cli2.installed) {
            console.log(SUB(`Claude CLI ${dim(cli2.version)}`));
            console.log(SUB_LAST(red('not authorized')));
          } else {
            console.log(SUB_LAST(red('Claude CLI not installed')));
          }
          logToFile('re-check: ai_service — failed');
          failed.push('AI Service still not working after fixes');
        }
      }
    }

  }

  // ── Group 4: Channels ────────────────────────────────────────

  let offlineChannels = [];
  const procs = pm2Result?.procs || [];
  const tmuxSession = checkTmuxSession();
  if (procs.length > 0 || tmuxSession) {
    const channels = discoverChannels(procs, env, tmuxSession);
    const onlineChannels = channels.filter(c => c.online);
    offlineChannels = channels.filter(c => !c.online);

    console.log(`\n${bold('Channels')}`);
    for (const ch of onlineChannels) {
      const warn = ch.warning ? ` ${yellow(`(${ch.warning})`)}` : '';
      console.log(BULLET_ON(`${ch.name.padEnd(16)} ${dim(ch.action)}${warn}`));
    }
    for (const ch of offlineChannels) {
      console.log(BULLET_OFF(`${ch.name.padEnd(16)} ${dim('offline')}`));
    }

    if (offlineChannels.length > 0 && onlineChannels.length > 0) {
      console.log(`\n  ${dim('Offline channels can be fixed after connecting — ask Claude.')}`);
    }
  }

  // ── Group 5: Updates ────────────────────────────────────────

  if (!skipRemaining) {
    try {
      const updates = [];

      // Check zylos-core itself
      const coreVersion = getCurrentVersion();
      if (coreVersion.success) {
        try {
          const latest = fetchLatestTag('zylos-ai/zylos-core');
          if (latest && latest !== coreVersion.version) {
            updates.push({ name: 'zylos-core', current: coreVersion.version, latest });
          }
        } catch (err) {
          logToFile(`warn: version check failed for zylos-core: ${err.message}`);
        }
      }

      // Check installed components
      const components = loadComponents();
      for (const [name, info] of Object.entries(components)) {
        if (!info.repo || !info.version) continue;
        try {
          const latest = fetchLatestTag(info.repo);
          if (latest && latest !== info.version) {
            updates.push({ name, current: info.version, latest });
          }
        } catch (err) {
          logToFile(`warn: version check failed for ${name}: ${err.message}`);
        }
      }

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
      offlineChannels.forEach(ch => console.log(`    ${yellow('○')} ${ch.name} offline — connect via any working channel, ask Claude to fix`));
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
