// PM2 Ecosystem Configuration for Zylos
// This file defines all PM2-managed services with proper environment setup
//
// Usage:
//   pm2 start ~/zylos/pm2/ecosystem.config.cjs
//   pm2 save
//   pm2 startup  # Configure boot auto-start

const path = require('path');
const os = require('os');

const fs = require('fs');

const HOME = os.homedir();
const ZYLOS_DIR = path.join(HOME, 'zylos');
const SKILLS_DIR = path.join(HOME, 'zylos', '.claude', 'skills');
const BIN_DIR = path.join(ZYLOS_DIR, 'bin');
const HTTP_DIR = path.join(ZYLOS_DIR, 'http');

// Read a value from .env file
function readEnvValue(key, defaultValue = '') {
  try {
    const content = fs.readFileSync(path.join(ZYLOS_DIR, '.env'), 'utf8');
    const match = content.match(new RegExp(`^${key}=(.+)$`, 'm'));
    if (match) return match[1];
  } catch {}
  return defaultValue;
}

// Build PATH: Claude locations + user's full shell PATH + PM2's own PATH
const ENHANCED_PATH = [
  path.join(HOME, '.local', 'bin'),
  path.join(HOME, '.claude', 'bin'),
  readEnvValue('SYSTEM_PATH'),
  process.env.PATH
].filter(Boolean).join(':');

// Whether Claude should run with --dangerously-skip-permissions
const CLAUDE_BYPASS_PERMISSIONS = readEnvValue('CLAUDE_BYPASS_PERMISSIONS', 'true');
// Whether Codex should run with --dangerously-bypass-approvals-and-sandbox
const CODEX_BYPASS_PERMISSIONS = readEnvValue('CODEX_BYPASS_PERMISSIONS', 'true');

// Resolve the zylos package root so deployed skills can import CLI modules.
// activity-monitor.js imports from cli/lib/runtime/, which is part of the
// zylos npm package — not the skill's deployed directory.
let ZYLOS_PACKAGE_ROOT = '';
try {
  const { execSync } = require('child_process');
  const zylosBin = execSync(
    'command -v zylos 2>/dev/null || true',
    { encoding: 'utf8', env: { ...process.env, PATH: ENHANCED_PATH }, stdio: ['pipe', 'pipe', 'pipe'] }
  ).trim();
  if (zylosBin) {
    // Follow symlinks: npm installs a wrapper in .bin/ pointing to the package main file
    const realPath = fs.realpathSync(zylosBin);
    // Installed path: <prefix>/lib/node_modules/zylos/cli/zylos.js → package root 2 dirs up
    const candidate = path.dirname(path.dirname(realPath));
    if (fs.existsSync(path.join(candidate, 'cli', 'lib', 'runtime', 'index.js'))) {
      ZYLOS_PACKAGE_ROOT = candidate;
    }
  }
} catch { /* ZYLOS_PACKAGE_ROOT stays empty — activity-monitor uses relative path fallback */ }

module.exports = {
  apps: [
    {
      name: 'scheduler',
      script: path.join(SKILLS_DIR, 'scheduler', 'scripts', 'daemon.js'),
      cwd: ZYLOS_DIR,
      env: {
        PATH: ENHANCED_PATH,
        NODE_ENV: 'production'
      },
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s'
    },
    {
      name: 'web-console',
      script: path.join(SKILLS_DIR, 'web-console', 'scripts', 'server.js'),
      cwd: HOME,
      env: {
        PATH: ENHANCED_PATH,
        NODE_ENV: 'production'
      },
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s'
    },
    {
      name: 'c4-dispatcher',
      script: path.join(SKILLS_DIR, 'comm-bridge', 'scripts', 'c4-dispatcher.js'),
      cwd: path.join(SKILLS_DIR, 'comm-bridge', 'scripts'),
      env: {
        PATH: ENHANCED_PATH,
        NODE_ENV: 'production'
      },
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s'
    },
    {
      name: 'activity-monitor',
      script: path.join(SKILLS_DIR, 'activity-monitor', 'scripts', 'activity-monitor.js'),
      cwd: HOME,
      env: {
        PATH: ENHANCED_PATH,
        NODE_ENV: 'production',
        CLAUDE_BYPASS_PERMISSIONS,
        CODEX_BYPASS_PERMISSIONS,
        ...(ZYLOS_PACKAGE_ROOT ? { ZYLOS_PACKAGE_ROOT } : {}),
      },
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s'
    },
    // Caddy web server (only if set up via `zylos init`)
    ...(fs.existsSync(path.join(BIN_DIR, 'caddy')) && fs.existsSync(path.join(HTTP_DIR, 'Caddyfile'))
      ? [{
          name: 'caddy',
          script: path.join(BIN_DIR, 'caddy'),
          args: `run --config ${path.join(HTTP_DIR, 'Caddyfile')} --adapter caddyfile`,
          cwd: ZYLOS_DIR,
          env: {
            PATH: ENHANCED_PATH,
            HOME: HOME,
          },
          autorestart: true,
          max_restarts: 10,
          min_uptime: '10s',
          kill_timeout: 5000,
        }]
      : []),
    // Component services (telegram, lark, etc.) are managed by `zylos add/remove`
  ]
};
