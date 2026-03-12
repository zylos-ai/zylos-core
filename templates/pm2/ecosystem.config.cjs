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
const ZYLOS_META_DIR = path.join(ZYLOS_DIR, '.zylos');
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

// Load PM2 configs for installed components that declare a service.
// Each component can provide its own ecosystem.config.cjs in its skill directory.
// Falls back to generating a config from SKILL.md frontmatter if no ecosystem file exists.
function loadComponentServices() {
  const componentsFile = path.join(ZYLOS_META_DIR, 'components.json');
  try {
    const components = JSON.parse(fs.readFileSync(componentsFile, 'utf8'));
    const apps = [];
    for (const [name, meta] of Object.entries(components)) {
      const skillDir = meta.skillDir || path.join(SKILLS_DIR, name);

      // Try loading the component's own ecosystem.config.cjs
      const ecoPath = path.join(skillDir, 'ecosystem.config.cjs');
      if (fs.existsSync(ecoPath)) {
        try {
          const componentConfig = require(ecoPath);
          const componentApps = componentConfig.apps || [];
          for (const app of componentApps) {
            // Inject ENHANCED_PATH so component services can find claude, node, etc.
            app.env = { ...app.env, PATH: ENHANCED_PATH };
            apps.push(app);
          }
          continue;
        } catch {}
      }

      // Fallback: parse SKILL.md frontmatter for service declaration
      const skillMd = path.join(skillDir, 'SKILL.md');
      if (!fs.existsSync(skillMd)) continue;
      try {
        const content = fs.readFileSync(skillMd, 'utf8');
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
        if (!fmMatch) continue;
        const fm = fmMatch[1];
        // Extract service.name and service.entry from YAML (simple parsing)
        const nameMatch = fm.match(/service:\s*\n\s+(?:type:\s*\w+\s*\n\s+)?name:\s*(.+)/);
        const entryMatch = fm.match(/service:\s*\n(?:\s+\w+:.*\n)*?\s+entry:\s*(.+)/);
        if (!nameMatch || !entryMatch) continue;
        const serviceName = nameMatch[1].trim();
        const entry = entryMatch[1].trim();
        const dataDir = meta.dataDir || path.join(ZYLOS_DIR, 'components', name);
        apps.push({
          name: serviceName,
          script: entry,
          cwd: skillDir,
          env: {
            PATH: ENHANCED_PATH,
            NODE_ENV: 'production',
          },
          autorestart: true,
          max_restarts: 10,
          min_uptime: '10s',
          error_file: path.join(dataDir, 'logs', 'error.log'),
          out_file: path.join(dataDir, 'logs', 'out.log'),
          log_date_format: 'YYYY-MM-DD HH:mm:ss',
        });
      } catch {}
    }
    return apps;
  } catch {
    // components.json missing or malformed — return empty, core services still start
    return [];
  }
}

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
    // Component services — dynamically loaded from components.json
    ...loadComponentServices(),
  ]
};
