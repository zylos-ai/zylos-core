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
        CLAUDE_BYPASS_PERMISSIONS
      },
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s'
    },
    // Component services (telegram, lark, etc.) are managed by `zylos add/remove`
  ]
};
