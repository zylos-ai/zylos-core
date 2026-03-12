/**
 * zylos doctor — diagnose installation health and auto-fix via Claude.
 *
 * Design: https://github.com/zylos-ai/zylos-core/issues/202
 *
 * Layer 1: Diagnose all checks. Ensure Claude CLI is reachable.
 * Layer 2: If Claude is available, delegate all fixes to `claude -p`.
 *          If not, show manual hints.
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import dns from 'node:dns/promises';
import { ZYLOS_DIR, CONFIG_DIR, SKILLS_DIR, COMPONENTS_FILE } from '../lib/config.js';
import { readEnvFile } from '../lib/env.js';
import { loadComponents } from '../lib/components.js';
import { fetchLatestTagAsync, compareSemverDesc } from '../lib/github.js';
import { getCurrentVersion } from '../lib/self-upgrade.js';
import { commandExists } from '../lib/shell-utils.js';
import { parseSkillMd } from '../lib/skill.js';
import { bold, dim, green, red, yellow, heading } from '../lib/colors.js';

const SESSION = 'claude-main';
const LOG_DIR = path.join(ZYLOS_DIR, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'doctor.log');
const API_HOST = 'api.anthropic.com';
const VERSION_CHECK_CONCURRENCY = 3;
const CLAUDE_FIX_TIMEOUT = 300000; // 5 minutes

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
  let version = '';
  try {
    const output = execFileSync('tmux', ['-V'], {
      encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    // "tmux 3.4" → "3.4"
    const match = output.match(/(\d+\.\d+\w*)/);
    if (match) version = match[1];
  } catch {}
  return { installed: true, version };
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

// ── Diagnostics collection ───────────────────────────────────────

async function collectDiagnostics(env) {
  const networkPromise = checkNetwork(env);

  const tmux = checkTmuxInstalled();
  const pm2 = checkPm2Installed();
  const net = await networkPromise;

  const cli = checkClaudeCli();
  // auth check may contact the API — skip when network is down
  const auth = cli.installed && net.reachable ? checkClaudeAuth() : false;
  const autonomous = cli.installed ? checkAutonomousMode() : false;

  const services = pm2.installed
    ? checkPm2Services()
    : { running: false, total: 0, online: 0, activityMonitor: false, procs: [] };
  const session = tmux.installed ? checkTmuxSession() : false;

  return {
    system: { tmux, pm2, network: net },
    ai: { cli, auth, autonomous, networkSkipped: !net.reachable },
    services: { ...services, session },
  };
}

// ── JSON builder ─────────────────────────────────────────────────

function buildDiagnosticJson(diag, coreVersion) {
  const issues = [];

  if (!diag.system.tmux.installed) {
    issues.push({ id: 'tmux_missing', label: 'tmux not installed', hint: 'Run zylos init' });
  }
  if (!diag.system.pm2.installed) {
    issues.push({ id: 'pm2_missing', label: 'PM2 not installed', hint: 'Run zylos init' });
  }
  if (!diag.system.network.reachable) {
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
    issues.push({ id: 'network_unreachable', label: `Cannot reach ${API_HOST}`, hint });
  }
  if (!diag.ai.cli.installed) {
    issues.push({ id: 'cli_missing', label: 'Claude CLI not installed', hint: 'Run zylos init' });
  }
  if (diag.ai.cli.installed && !diag.ai.networkSkipped && !diag.ai.auth) {
    issues.push({ id: 'cli_not_authed', label: 'Claude not authorized', hint: 'Run zylos init to authenticate' });
  }
  if (diag.ai.cli.installed && diag.ai.auth && !diag.ai.autonomous) {
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

  return {
    version: coreVersion.success ? coreVersion.version : null,
    timestamp: new Date().toISOString(),
    passed: issues.length === 0,
    groups: {
      system: {
        passed: diag.system.tmux.installed && diag.system.pm2.installed && diag.system.network.reachable,
        checks: {
          tmux: { ok: diag.system.tmux.installed, version: diag.system.tmux.version || null },
          pm2: { ok: diag.system.pm2.installed, version: diag.system.pm2.version || null },
          network: { ok: diag.system.network.reachable, host: API_HOST, proxy: diag.system.network.proxy || null },
        },
      },
      ai_service: {
        passed: diag.ai.networkSkipped ? null : (diag.ai.cli.installed && diag.ai.auth && diag.ai.autonomous),
        skipped: diag.ai.networkSkipped,
        checks: {
          cli: { ok: diag.ai.cli.installed, version: diag.ai.cli.version || null },
          auth: { ok: diag.ai.auth },
          autonomous: { ok: diag.ai.autonomous },
        },
      },
      services: {
        passed: diag.services.running && diag.services.total > 0 &&
          diag.services.procs.every(p => p.pm2_env?.status === 'online'),
        procs: diag.services.procs.map(p => ({ name: p.name, status: p.pm2_env?.status || 'unknown' })),
        session: { active: diag.services.session },
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
    checks.push(tmux.version ? `tmux ${dim(tmux.version)}` : 'tmux installed');
  } else {
    checks.push(red('tmux not installed'));
  }

  if (pm2Info.installed) {
    checks.push(`PM2 ${dim(`v${pm2Info.version}`)}`);
  } else {
    checks.push(red('PM2 not installed'));
  }

  if (net.reachable) {
    let label = `network: ${API_HOST} reachable`;
    if (net.proxy) label += dim(' (via proxy)');
    checks.push(label);
  } else {
    if (!net.dns) {
      checks.push(red(`network: DNS failed for ${API_HOST}`));
    } else {
      checks.push(red(`network: cannot reach ${API_HOST}`));
    }
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
  const { cli, auth, autonomous } = diag.ai;

  if (cli.installed) {
    checks.push(`Claude CLI ${dim(cli.version)}`);
  } else {
    checks.push(red('Claude CLI not installed'));
  }

  if (cli.installed) {
    if (auth) {
      checks.push('authorized');
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
  if (!diag.system.pm2.installed) {
    console.log(groupHeader('Services', 'skip'));
    console.log(SKIP('skipped (requires PM2)'));
    logToFile('check: services — skipped');
    return;
  }

  const checks = [];
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

  if (session) {
    checks.push(`Claude session: ${green('active')}`);
  } else if (activityMonitor) {
    checks.push(yellow('Claude session: starting...'));
  } else {
    checks.push(dim('Claude session: waiting'));
  }

  displayCheckGroup('Services', jsonGroup.passed ? 'pass' : 'fail', checks);
  logToFile(`check: services — ${jsonGroup.passed ? 'passed' : 'failed'}`);
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

  // tmux channel — only show when session is active
  if (tmuxSession) {
    channels.push({
      name: 'tmux',
      action: 'zylos attach',
      type: 'terminal',
      online: true,
    });
  }

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
      action = `http://localhost:${port}/`;
      const ip = getNetworkIP();
      if (ip) secondaryAction = `http://${ip}:${port}/`;
      hint = `Tip: ${bold('zylos init')} can set up a custom domain for remote access.`;
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

// ── Claude auto-fix (Layer 2) ────────────────────────────────────

function isClaudeReady(diag) {
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

export async function doctorCommand(args) {
  const jsonMode = args.includes('--json');

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

      const results = await concurrentMap(targets, async (target) => {
        try {
          const latest = await fetchLatestTagAsync(target.repo);
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

  // ── Phase 6: Handle issues ────────────────────────────────────

  if (diagnostic.passed) {
    const sessionStarting = diag.services.activityMonitor && !diag.services.session;
    console.log(`\n${green('✓ Everything is working.')}`);
    if (sessionStarting) {
      console.log(`\n  ${dim('Claude session is starting — run')} ${bold('zylos attach')} ${dim('in a moment to connect.')}`);
    }
    console.log('');
    logToFile('result: all checks passed');
    process.exit(0);
  }

  const claudeReady = isClaudeReady(diag);

  // Show issues — hide hints when Claude will auto-fix
  console.log(separator('Issues'));
  for (let i = 0; i < diagnostic.issues.length; i++) {
    const issue = diagnostic.issues[i];
    console.log(`\n  ${bold(`[${i + 1}]`)} ${issue.label}`);
    if (!claudeReady && issue.hint) console.log(`      ${dim(issue.hint)}`);
  }

  // Layer 2: attempt auto-fix via Claude
  if (claudeReady) {
    console.log('');
    logToFile('layer2: starting claude auto-fix');

    const fixResult = await runClaudeFix(diagnostic);

    // Show error if fix failed
    if (!fixResult.ok && fixResult.error) {
      console.log(`\n  ${red(fixResult.error)}`);
    }

    // Re-verify
    console.log(`\n  ${dim('Re-checking...')}`);
    const rediag = await collectDiagnostics(readEnvFile());
    const reverify = buildDiagnosticJson(rediag, coreVersion);

    if (reverify.passed) {
      const sessionStarting = rediag.services.activityMonitor && !rediag.services.session;
      console.log(`\n${green('✓ All issues fixed — everything is working. Enjoy your Zylos!')}`);
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

  // Claude not available — bottom message based on why
  if (!diag.system.network.reachable) {
    console.log(`\n  ${yellow('Check your network connection and run')} ${bold('zylos doctor')} ${yellow('again.')}\n`);
  } else {
    console.log(`\n  ${yellow('Run')} ${bold('zylos init')} ${yellow('to set up your environment.')}\n`);
  }
  logToFile('result: issues found, claude not available for auto-fix');
  process.exit(1);
}
