import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CADDYFILE, COMPONENTS_DIR, ENV_FILE, ZYLOS_DIR, getZylosConfig } from '../lib/config.js';
import { loadComponents } from '../lib/components.js';
import { commandExists } from '../lib/shell-utils.js';
import { bold, cyan, dim, green, red, yellow } from '../lib/colors.js';

const CORE_PM2_SERVICES = new Set([
  'scheduler',
  'web-console',
  'c4-dispatcher',
  'activity-monitor',
  'caddy',
]);

const SECRET_KEY_RE = /(token|secret|password|passphrase|credential|api[_-]?key|auth)/i;
const AUTH_DIRECTIVE_RE = /\b(basic_auth|basicauth|forward_auth|jwt)\b/;

export async function securityCommand(args = []) {
  const subcommand = args[0] || 'audit';

  if (subcommand === 'audit') {
    await securityAuditCommand(args.slice(1));
    return;
  }

  if (subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    showSecurityHelp();
    return;
  }

  console.error(`Unknown security subcommand: ${subcommand}`);
  showSecurityHelp();
  process.exitCode = 1;
}

export async function securityAuditCommand(args = []) {
  const json = args.includes('--json');
  const report = runSecurityAudit();

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printAuditReport(report);
  }

  if (report.summary.critical > 0) {
    process.exitCode = 1;
  }
}

export function runSecurityAudit() {
  const findings = [];
  const checks = [];
  const components = loadComponents();
  const zylosConfig = getZylosConfig();
  const telegramConfig = readJson(path.join(COMPONENTS_DIR, 'telegram', 'config.json'));
  const caddyfile = readText(CADDYFILE);

  pushPermissionCheck(checks, findings, ENV_FILE, '.env', {
    remediation: `chmod 600 ${ENV_FILE}`,
    assumeSensitive: true,
  });

  for (const componentName of Object.keys(components)) {
    const configPath = path.join(COMPONENTS_DIR, componentName, 'config.json');
    pushPermissionCheck(checks, findings, configPath, `${componentName} config`, {
      remediation: `chmod 600 ${configPath}`,
      inspectJsonSecrets: true,
    });
  }

  const claudeJsonPath = path.join(os.homedir(), '.claude.json');
  pushPermissionCheck(checks, findings, claudeJsonPath, '~/.claude.json', {
    remediation: `chmod 600 ${claudeJsonPath}`,
    assumeSensitive: true,
  });

  checks.push('gitignore');
  findings.push(...checkGitIgnoreCoverage(components));

  checks.push('telegram-dm-policy');
  findings.push(...checkTelegramDmPolicy(telegramConfig));

  checks.push('telegram-group-policy');
  findings.push(...checkTelegramGroupPolicy(telegramConfig));

  checks.push('web-console-auth');
  findings.push(...checkWebConsoleExposure(caddyfile));

  checks.push('caddy-exposure');
  findings.push(...checkCaddyExposure(caddyfile, zylosConfig));

  checks.push('claude-dangerous-mode');
  findings.push(...checkClaudeDangerousMode());

  checks.push('pm2-health');
  findings.push(...checkPm2Health(components));

  checks.push('pm2-startup');
  findings.push(...checkPm2Startup());

  const summary = {
    checks: checks.length,
    findings: findings.length,
    critical: findings.filter((f) => f.severity === 'critical').length,
    warn: findings.filter((f) => f.severity === 'warn').length,
    info: findings.filter((f) => f.severity === 'info').length,
  };

  return {
    command: 'zylos security audit',
    generatedAt: new Date().toISOString(),
    target: ZYLOS_DIR,
    summary,
    findings: sortFindings(findings),
  };
}

function showSecurityHelp() {
  console.log(`
Usage: zylos security audit [--json]

Checks the local Zylos installation for common security misconfigurations.

Options:
  --json   Emit machine-readable JSON
`);
}

function printAuditReport(report) {
  console.log(`${bold('Zylos Security Audit')}`);
  console.log(`${dim(`Target: ${report.target}`)}`);
  console.log(`${dim(`Generated: ${report.generatedAt}`)}`);
  console.log('');

  if (report.findings.length === 0) {
    console.log(green('✓ No findings'));
    console.log(dim(`Completed ${report.summary.checks} checks with no critical, warning, or info findings.`));
    return;
  }

  for (const finding of report.findings) {
    const severity = formatSeverity(finding.severity);
    console.log(`${severity} ${bold(finding.id)}`);
    console.log(`  ${finding.description}`);
    console.log(`  ${dim(`Remediation: ${finding.remediation}`)}`);
    if (finding.details) {
      console.log(`  ${dim(`Details: ${finding.details}`)}`);
    }
    console.log('');
  }

  const parts = [
    report.summary.critical ? red(`${report.summary.critical} critical`) : dim('0 critical'),
    report.summary.warn ? yellow(`${report.summary.warn} warn`) : dim('0 warn'),
    report.summary.info ? cyan(`${report.summary.info} info`) : dim('0 info'),
  ];
  console.log(`${bold('Summary')}: ${parts.join(', ')} across ${report.summary.checks} checks`);
  if (report.summary.critical > 0) {
    console.log(dim('Exit code 1 because critical findings were detected.'));
  }
}

function formatSeverity(severity) {
  if (severity === 'critical') return red('[critical]');
  if (severity === 'warn') return yellow('[warn]');
  return cyan('[info]');
}

function sortFindings(findings) {
  const rank = { critical: 0, warn: 1, info: 2 };
  return [...findings].sort((a, b) => {
    const severityDiff = rank[a.severity] - rank[b.severity];
    if (severityDiff !== 0) return severityDiff;
    return a.id.localeCompare(b.id);
  });
}

function pushPermissionCheck(checks, findings, filePath, label, options = {}) {
  checks.push(`permissions:${label}`);
  const finding = checkFilePermissions(filePath, label, options);
  if (finding) findings.push(finding);
}

export function checkFilePermissions(filePath, label, options = {}) {
  if (!fs.existsSync(filePath)) return null;

  const stat = fs.statSync(filePath);
  if (!stat.isFile()) return null;

  const mode = stat.mode & 0o777;
  const containsSecrets = options.assumeSensitive || (
    options.inspectJsonSecrets && fileContainsJsonSecrets(filePath)
  );
  const severity = classifyPermissionSeverity(mode, containsSecrets);
  if (!severity) return null;

  return {
    id: `permissions:${label}`,
    severity,
    description: `${label} uses mode ${formatMode(mode)}, which grants group or world access to a sensitive file.`,
    remediation: options.remediation || `chmod 600 ${filePath}`,
    details: filePath,
  };
}

export function classifyPermissionSeverity(mode, containsSecrets = false) {
  const worldBits = mode & 0o007;
  const groupBits = mode & 0o070;

  if (worldBits !== 0) return 'critical';
  if (groupBits !== 0) return containsSecrets ? 'critical' : 'warn';
  return null;
}

export function formatMode(mode) {
  return `0${(mode & 0o777).toString(8).padStart(3, '0')}`;
}

function fileContainsJsonSecrets(filePath) {
  const parsed = readJson(filePath);
  return parsed ? objectContainsSecrets(parsed) : false;
}

export function objectContainsSecrets(value, key = '') {
  if (key && SECRET_KEY_RE.test(key)) return true;
  if (!value || typeof value !== 'object') return false;

  if (Array.isArray(value)) {
    return value.some((entry) => objectContainsSecrets(entry, key));
  }

  return Object.entries(value).some(([childKey, childValue]) => objectContainsSecrets(childValue, childKey));
}

function checkGitIgnoreCoverage(components) {
  const repoRoot = getGitRepoRoot(ZYLOS_DIR);
  if (!repoRoot) {
    return [{
      id: 'gitignore',
      severity: 'info',
      description: 'The Zylos install directory is not inside a git repository, so secret-file gitignore checks were skipped.',
      remediation: 'If you later manage this install in git, ignore .env and component config.json files before committing.',
      details: ZYLOS_DIR,
    }];
  }

  const sensitivePaths = [ENV_FILE];
  for (const componentName of Object.keys(components)) {
    sensitivePaths.push(path.join(COMPONENTS_DIR, componentName, 'config.json'));
  }

  const findings = [];
  for (const absolutePath of sensitivePaths) {
    const relative = path.relative(repoRoot, absolutePath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) continue;

    if (gitFileIsTracked(repoRoot, relative)) {
      findings.push({
        id: `git:${relative}`,
        severity: 'critical',
        description: `${relative} is tracked by git even though it may contain secrets.`,
        remediation: `git rm --cached ${relative} && add an ignore rule for it`,
        details: repoRoot,
      });
      continue;
    }

    if (!gitFileIsIgnored(repoRoot, relative)) {
      findings.push({
        id: `git:${relative}`,
        severity: 'warn',
        description: `${relative} is not ignored by git, so secrets can be committed accidentally.`,
        remediation: `Add ${relative} to ${path.join(repoRoot, '.gitignore')}`,
        details: repoRoot,
      });
    }
  }

  return findings;
}

function getGitRepoRoot(cwd) {
  if (!commandExists('git')) return null;
  try {
    return execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
    }).trim();
  } catch {
    return null;
  }
}

function gitFileIsTracked(repoRoot, relativePath) {
  try {
    execFileSync('git', ['-C', repoRoot, 'ls-files', '--error-unmatch', relativePath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
    });
    return true;
  } catch {
    return false;
  }
}

function gitFileIsIgnored(repoRoot, relativePath) {
  try {
    execFileSync('git', ['-C', repoRoot, 'check-ignore', relativePath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
    });
    return true;
  } catch {
    return false;
  }
}

function checkTelegramDmPolicy(config) {
  if (!config?.enabled) return [];
  if (config.dmPolicy !== 'open') return [];
  return [{
    id: 'telegram:dm-policy',
    severity: 'warn',
    description: 'Telegram direct messages are open to anyone who can message the bot.',
    remediation: 'Set telegram dmPolicy to owner or allowlist, and configure dmAllowFrom.',
    details: path.join(COMPONENTS_DIR, 'telegram', 'config.json'),
  }];
}

function checkTelegramGroupPolicy(config) {
  if (!config?.enabled) return [];
  if (config.groupPolicy === 'allowlist') return [];
  return [{
    id: 'telegram:group-policy',
    severity: 'warn',
    description: 'Telegram group access is not restricted by an allowlist.',
    remediation: 'Set telegram groupPolicy to allowlist and explicitly approve trusted group IDs.',
    details: path.join(COMPONENTS_DIR, 'telegram', 'config.json'),
  }];
}

function checkWebConsoleExposure(caddyfile) {
  if (!caddyfile || !caddyfile.includes('/console')) return [];
  if (hasAuthDirective(caddyfile)) return [];

  const address = getCaddySiteAddress(caddyfile);
  if (address && !isPublicAddress(address)) return [];

  return [{
    id: 'web-console:auth',
    severity: 'critical',
    description: 'The web console is exposed through Caddy without any obvious authentication directive.',
    remediation: 'Protect /console with basic_auth or forward_auth before exposing it on a public host.',
    details: CADDYFILE,
  }];
}

function checkCaddyExposure(caddyfile, zylosConfig) {
  if (!caddyfile) return [];

  const address = getCaddySiteAddress(caddyfile) || zylosConfig.domain || '';
  if (!isPublicAddress(address)) return [];
  if (hasAuthDirective(caddyfile)) return [];
  if (String(zylosConfig.protocol || '').toLowerCase() !== 'http') return [];

  return [{
    id: 'caddy:public-http',
    severity: 'warn',
    description: 'Caddy appears to be serving a public host over plain HTTP without authentication.',
    remediation: 'Use HTTPS and add authentication before exposing the installation publicly.',
    details: address,
  }];
}

export function hasAuthDirective(caddyfile) {
  return AUTH_DIRECTIVE_RE.test(caddyfile);
}

export function getCaddySiteAddress(caddyfile) {
  if (!caddyfile) return '';
  for (const rawLine of caddyfile.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.endsWith('{')) return line.slice(0, -1).trim();
  }
  return '';
}

export function isPublicAddress(address) {
  if (!address) return false;

  const raw = address.split(',')[0].trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '');
  if (raw.startsWith(':')) return true;

  const first = raw
    .replace(/\:\d+$/, '')
    .replace(/^\[|\]$/g, '');

  if (!first) return false;
  if (first === '0.0.0.0' || first === '::') return true;
  if (first === 'localhost') return false;
  if (/^127\./.test(first)) return false;
  if (/^10\./.test(first)) return false;
  if (/^192\.168\./.test(first)) return false;

  const private172 = first.match(/^172\.(\d+)\./);
  if (private172) {
    const octet = Number(private172[1]);
    if (octet >= 16 && octet <= 31) return false;
  }

  const lower = first.toLowerCase();
  if (lower === '::1') return false;
  if (lower.startsWith('fe80:')) return false;
  if (lower.startsWith('fc') || lower.startsWith('fd')) return false;

  return true;
}

function checkClaudeDangerousMode() {
  const settingsPath = path.join(ZYLOS_DIR, '.claude', 'settings.json');
  const settings = readJson(settingsPath);

  if (settings?.skipDangerousModePermissionPrompt) {
    return [{
      id: 'claude:dangerous-mode',
      severity: 'info',
      description: 'Claude dangerous-mode permission prompts are bypassed for this install.',
      remediation: 'Keep this enabled only on trusted machines and trusted channels.',
      details: settingsPath,
    }];
  }

  return [];
}

function checkPm2Health(components) {
  if (!commandExists('pm2')) {
    return [{
      id: 'pm2:missing',
      severity: 'warn',
      description: 'PM2 is not installed, so service health cannot be supervised.',
      remediation: 'Install PM2 and start the Zylos services with zylos init.',
      details: 'pm2',
    }];
  }

  let procs;
  try {
    procs = JSON.parse(execFileSync('pm2', ['jlist'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30000,
    }));
  } catch {
    return [{
      id: 'pm2:unavailable',
      severity: 'warn',
      description: 'PM2 is installed but its process list could not be queried.',
      remediation: 'Check the PM2 daemon with pm2 ping or restart the daemon.',
      details: 'pm2 jlist',
    }];
  }

  const expectedCore = [...CORE_PM2_SERVICES].filter((serviceName) => {
    if (serviceName !== 'caddy') return true;
    return fs.existsSync(CADDYFILE);
  });
  const findings = [];

  for (const serviceName of expectedCore) {
    const proc = procs.find((entry) => entry.name === serviceName);
    if (!proc) {
      findings.push({
        id: `pm2:${serviceName}`,
        severity: 'warn',
        description: `${serviceName} is expected but not registered in PM2.`,
        remediation: 'Restart managed services and save the PM2 process list.',
        details: 'pm2 start ~/zylos/pm2/ecosystem.config.cjs && pm2 save',
      });
      continue;
    }

    const status = proc.pm2_env?.status || 'unknown';
    if (status !== 'online') {
      findings.push({
        id: `pm2:${serviceName}`,
        severity: 'warn',
        description: `${serviceName} is registered in PM2 but not healthy (status: ${status}).`,
        remediation: `Inspect logs with: pm2 logs ${serviceName}`,
        details: 'pm2 jlist',
      });
    }
  }

  const managedComponentProcs = procs.filter((proc) => isManagedComponentProc(proc, components));
  for (const proc of managedComponentProcs) {
    const status = proc.pm2_env?.status || 'unknown';
    if (status !== 'online') {
      findings.push({
        id: `pm2:${proc.name}`,
        severity: 'warn',
        description: `${proc.name} is registered in PM2 but not healthy (status: ${status}).`,
        remediation: `Inspect logs with: pm2 logs ${proc.name}`,
        details: 'pm2 jlist',
      });
    }
  }

  return findings;
}

function isManagedComponentProc(proc, components) {
  const name = proc.name || '';
  if (CORE_PM2_SERVICES.has(name)) return false;
  if (name.startsWith('zylos-')) return true;

  const env = proc.pm2_env?.env || {};
  if (env.ZYLOS_COMPONENT && components[env.ZYLOS_COMPONENT]) return true;

  const execPath = proc.pm2_env?.pm_exec_path || '';
  const cwd = proc.pm2_env?.pm_cwd || '';
  return execPath.startsWith(ZYLOS_DIR) || cwd.startsWith(ZYLOS_DIR);
}

function checkPm2Startup() {
  if (!commandExists('pm2')) return [];

  const dumpPath = path.join(os.homedir(), '.pm2', 'dump.pm2');
  const hasDump = fs.existsSync(dumpPath) && fs.statSync(dumpPath).size > 0;

  let unitEnabled = null;
  if (process.platform === 'linux' && commandExists('systemctl') && fs.existsSync('/run/systemd/system')) {
    const unit = `pm2-${os.userInfo().username}`;
    const result = spawnSync('systemctl', ['is-enabled', unit], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 15000,
    });
    unitEnabled = result.status === 0;
  }

  if (hasDump && unitEnabled !== false) return [];

  return [{
    id: 'pm2:startup',
    severity: 'warn',
    description: 'PM2 boot persistence does not appear to be configured completely.',
    remediation: 'Run pm2 save and pm2 startup, then execute the sudo command PM2 prints if required.',
    details: dumpPath,
  }];
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}
