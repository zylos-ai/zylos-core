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

// Core service names — components must not collide with these
const CORE_SERVICE_NAMES = new Set([
  'scheduler', 'web-console', 'c4-dispatcher', 'activity-monitor', 'caddy',
]);

// Parse SKILL.md YAML frontmatter service block.
// Returns { name, entry } or null if no service declared.
function parseSkillService(skillMdPath) {
  const content = fs.readFileSync(skillMdPath, 'utf8');
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return null;

  const lines = fmMatch[1].split('\n');
  let inService = false;
  let serviceIndent = 0;
  const serviceProps = {};

  for (const line of lines) {
    // Detect "service:" block start
    const serviceStart = line.match(/^(\s*)service:\s*(.*)$/);
    if (serviceStart) {
      const value = serviceStart[2].trim();
      // "service: null" or "service: ~" means no service
      if (value === 'null' || value === '~' || value === 'false') return null;
      // Inline value (not a block) — skip
      if (value && value !== '') return null;
      inService = true;
      serviceIndent = serviceStart[1].length;
      continue;
    }

    if (!inService) continue;

    // Check if we've exited the service block (dedented or new top-level key)
    const lineIndent = line.match(/^(\s*)/)[1].length;
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    if (lineIndent <= serviceIndent) break;

    // Parse key: value within service block
    const kv = line.match(/^\s+(\w+):\s*(.+)$/);
    if (kv) serviceProps[kv[1].trim()] = kv[2].trim().replace(/^["']|["']$/g, '');
  }

  if (!serviceProps.name || !serviceProps.entry) return null;
  return { name: serviceProps.name, entry: serviceProps.entry };
}

// Load PM2 configs for installed components that declare a service.
// Each component can provide its own ecosystem.config.cjs in its skill directory.
// Falls back to generating a config from SKILL.md frontmatter if no ecosystem file exists.
function loadComponentServices() {
  const componentsFile = path.join(ZYLOS_META_DIR, 'components.json');
  try {
    const components = JSON.parse(fs.readFileSync(componentsFile, 'utf8'));
    const apps = [];
    const usedNames = new Set(CORE_SERVICE_NAMES);

    for (const [name, meta] of Object.entries(components)) {
      try {
        // Skip components that haven't finished setup (AI-mode install in progress)
        if (meta && meta.setupComplete === false) continue;

        const skillDir = (meta && meta.skillDir) || path.join(SKILLS_DIR, name);

        // Try loading the component's own ecosystem.config.cjs
        const ecoPath = path.join(skillDir, 'ecosystem.config.cjs');
        if (fs.existsSync(ecoPath)) {
          try {
            const componentConfig = require(ecoPath);
            const componentApps = componentConfig.apps || [];
            for (const app of componentApps) {
              if (usedNames.has(app.name)) {
                console.warn(`[ecosystem] Skipping component "${name}" service "${app.name}": conflicts with existing service`);
                continue;
              }
              // Copy app to avoid mutating the require() cached object
              const safeApp = { ...app, env: { ...app.env, PATH: ENHANCED_PATH } };
              usedNames.add(safeApp.name);
              apps.push(safeApp);
            }
            continue;
          } catch (err) {
            console.warn(`[ecosystem] Failed to load ${ecoPath}: ${err.message}, trying SKILL.md fallback`);
          }
        }

        // Fallback: parse SKILL.md frontmatter for service declaration
        const skillMd = path.join(skillDir, 'SKILL.md');
        if (!fs.existsSync(skillMd)) continue;
        const service = parseSkillService(skillMd);
        if (!service) continue;
        if (usedNames.has(service.name)) {
          console.warn(`[ecosystem] Skipping component "${name}" service "${service.name}": conflicts with existing service`);
          continue;
        }
        const dataDir = (meta && meta.dataDir) || path.join(ZYLOS_DIR, 'components', name);
        usedNames.add(service.name);
        apps.push({
          name: service.name,
          script: service.entry,
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
      } catch (err) {
        console.warn(`[ecosystem] Skipping component "${name}": ${err.message}`);
      }
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
    // Component services — dynamically loaded from components.json
    ...loadComponentServices(),
  ]
};
