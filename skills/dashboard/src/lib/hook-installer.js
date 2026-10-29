import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CLAUDE_HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'PermissionRequest', 'SubagentStart', 'SubagentStop'];
const CODEX_HOOK_EVENTS = ['SessionStart', 'PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'PermissionRequest'];
const CODEX_HOOK_FEATURE = 'hooks';
const CODEX_HOOK_EVENT_KEYS = {
  SessionStart: 'session_start',
  PreToolUse: 'pre_tool_use',
  PostToolUse: 'post_tool_use',
  UserPromptSubmit: 'user_prompt_submit',
  Stop: 'stop',
  PermissionRequest: 'permission_request'
};

const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse']);

export class HookInstaller {
  constructor(projectRoot, zylosDir) {
    this.projectRoot = projectRoot || path.resolve(__dirname, '..', '..');
    this.zylosDir = zylosDir || process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
    this.hookScript = path.join(this.projectRoot, 'src', 'lib', 'hook-ingest.cjs');
    this.statuslineScript = path.join(this.projectRoot, 'src', 'lib', 'statusline-ingest.cjs');
  }

  detectRuntime() {
    const rt = process.env.ZYLOS_RUNTIME;
    if (rt === 'claude' || rt === 'codex') return rt;
    return rt ? null : 'claude';
  }

  _command() {
    return `node ${this.hookScript}`;
  }

  _isOwn(command) {
    if (!command) return false;
    return command.includes(this.hookScript) ||
      (command.includes('hook-ingest.cjs') && command.includes('dashboard'));
  }

  // --- Claude Code ---

  _claudePath() {
    return path.join(this.zylosDir, '.claude', 'settings.json');
  }

  _readClaude() {
    try {
      return JSON.parse(fs.readFileSync(this._claudePath(), 'utf8'));
    } catch {
      return {};
    }
  }

  _writeClaude(settings) {
    const p = this._claudePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(settings, null, 2) + '\n');
  }

  installClaudeHooks() {
    const settings = this._readClaude();
    if (!settings.hooks) settings.hooks = {};

    const cmd = this._command();
    let added = 0;

    for (const event of CLAUDE_HOOK_EVENTS) {
      if (!Array.isArray(settings.hooks[event])) {
        settings.hooks[event] = [];
      }

      const existingGroup = settings.hooks[event].find(g =>
        g.hooks?.some(h => this._isOwn(h.command))
      );

      if (existingGroup) {
        for (const h of existingGroup.hooks) {
          if (this._isOwn(h.command)) {
            if (h.timeout !== 5 || h.async !== true) {
              h.timeout = 5;
              h.async = true;
              added++;
            }
          }
        }
        continue;
      }

      const entry = {
        hooks: [{ type: 'command', command: cmd, timeout: 5, async: true }]
      };
      if (TOOL_EVENTS.has(event)) entry.matcher = '';
      settings.hooks[event].push(entry);
      added++;
    }

    if (added > 0) this._writeClaude(settings);
    return { runtime: 'claude', added, total: CLAUDE_HOOK_EVENTS.length, path: this._claudePath() };
  }

  uninstallClaudeHooks() {
    const settings = this._readClaude();
    if (!settings.hooks) return { runtime: 'claude', removed: 0 };

    let removed = 0;
    for (const event of Object.keys(settings.hooks)) {
      if (!Array.isArray(settings.hooks[event])) continue;
      const before = settings.hooks[event].length;
      settings.hooks[event] = settings.hooks[event].filter(g =>
        !g.hooks?.some(h => this._isOwn(h.command))
      );
      removed += before - settings.hooks[event].length;
      if (settings.hooks[event].length === 0) delete settings.hooks[event];
    }

    if (removed > 0) this._writeClaude(settings);
    return { runtime: 'claude', removed, path: this._claudePath() };
  }

  // --- Codex ---
  // Codex hooks.json uses the same nested format as Claude settings.json hooks.
  // Codex 0.130 skips command hooks marked async, so Dashboard hooks stay sync
  // and rely on hook-ingest.cjs to return quickly or spool on failure.

  _codexHome() {
    return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  }

  _codexPath() {
    return path.join(this.zylosDir, '.codex', 'hooks.json');
  }

  _codexConfigPath() {
    return path.join(this._codexHome(), 'config.toml');
  }

  _codexConfigPaths() {
    return Array.from(new Set([
      this._codexConfigPath(),
      path.join(this.zylosDir, '.codex', 'config.toml')
    ]));
  }

  _readCodex() {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this._codexPath(), 'utf8'));
    } catch {
      return {};
    }
    if (!Array.isArray(raw)) return raw;
    // Migrate old flat-array format [{ event, command, ... }] to nested
    const config = { hooks: {} };
    for (const entry of raw) {
      if (!entry.event || !entry.command) continue;
      const event = entry.event;
      if (!config.hooks[event]) config.hooks[event] = [];
      const group = { hooks: [{ type: 'command', command: entry.command }] };
      if (entry.timeout != null) group.hooks[0].timeout = entry.timeout;
      if (entry.async != null) group.hooks[0].async = entry.async;
      if (TOOL_EVENTS.has(event)) group.matcher = '';
      config.hooks[event].push(group);
    }
    return config;
  }

  _writeCodex(config) {
    const p = this._codexPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(config, null, 2) + '\n');
  }

  _enableCodexHookFeatureAtPath(p) {
    let text = '';
    try {
      text = fs.readFileSync(p, 'utf8');
    } catch {
      text = '';
    }

    const flagPattern = new RegExp(`^${CODEX_HOOK_FEATURE}\\s*=\\s*(true|false)\\s*$`, 'm');
    const existingFlag = flagPattern.exec(text);
    if (existingFlag?.[1] === 'true') {
      return { enabled: true, changed: false, path: p };
    }

    let next;
    if (existingFlag) {
      next = text.replace(flagPattern, `${CODEX_HOOK_FEATURE} = true`);
    } else if (/^\[features\]\s*$/m.test(text)) {
      next = text.replace(/^(\[features\]\s*)$/m, `$1\n${CODEX_HOOK_FEATURE} = true`);
    } else {
      const trimmed = text.replace(/\s*$/, '');
      next = `${trimmed}${trimmed ? '\n\n' : ''}[features]\n${CODEX_HOOK_FEATURE} = true\n`;
    }

    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, next.endsWith('\n') ? next : `${next}\n`);
    return { enabled: true, changed: true, path: p };
  }

  _enableCodexHookFeature() {
    const results = this._codexConfigPaths().map(p => this._enableCodexHookFeatureAtPath(p));
    return {
      enabled: results.every(r => r.enabled),
      changed: results.some(r => r.changed),
      path: results[0]?.path,
      paths: results.map(r => r.path),
      results
    };
  }

  _codexCommand() {
    return `ZYLOS_RUNTIME=codex ZYLOS_DIR=${this.zylosDir} node ${this.hookScript}`;
  }

  _codexTrustStateFromHooksList(data) {
    const state = {};
    for (const entry of data || []) {
      for (const hook of entry.hooks || []) {
        if (hook.isManaged || !hook.key || !hook.currentHash) continue;
        if (!this._isOwn(hook.command)) continue;
        state[hook.key] = {
          enabled: true,
          trusted_hash: hook.currentHash
        };
      }
    }
    return state;
  }

  _codexHookKey(event, groupIndex, hookIndex) {
    const eventKey = CODEX_HOOK_EVENT_KEYS[event] || String(event || '').replace(/[A-Z]/g, (m, i) => `${i ? '_' : ''}${m.toLowerCase()}`);
    return `${this._codexPath()}:${eventKey}:${groupIndex}:${hookIndex}`;
  }

  _removeCodexTrustState(hookKeys = []) {
    const p = this._codexConfigPath();
    const keys = new Set(hookKeys.filter(Boolean));
    if (keys.size === 0) return { removed: 0, path: p };

    let text;
    try {
      text = fs.readFileSync(p, 'utf8');
    } catch {
      return { removed: 0, path: p };
    }

    let removed = 0;
    let skip = false;
    const lines = text.split('\n');
    const kept = [];
    for (const line of lines) {
      if (/^\[/.test(line)) {
        const match = line.match(/^\[hooks\.state\."([^"]+)"\]$/);
        skip = match ? keys.has(match[1]) : false;
        if (skip) {
          removed++;
          continue;
        }
      }
      if (!skip) kept.push(line);
    }
    const next = kept.join('\n').replace(/\n{3,}/g, '\n\n');

    if (removed > 0) {
      fs.writeFileSync(p, next.endsWith('\n') ? next : `${next}\n`);
    }
    return { removed, path: p };
  }

  _trustCodexHooks() {
    const script = String.raw`
const { spawn } = require('node:child_process');

const cwd = process.env.ZYLOS_DASHBOARD_CODEX_CWD;
const hookScript = process.env.ZYLOS_DASHBOARD_HOOK_SCRIPT;
const clientName = 'zylos_dashboard_hook_installer';

const app = spawn('codex', ['app-server', '--listen', 'stdio://'], {
  cwd,
  stdio: ['pipe', 'pipe', 'pipe']
});

let stdout = '';
let stderr = '';
let finished = false;
let nextId = 0;
let trustedCount = 0;

function send(method, params) {
  const id = nextId++;
  app.stdin.write(JSON.stringify({ method, id, params }) + '\n');
  return id;
}

function notify(method, params) {
  app.stdin.write(JSON.stringify({ method, params }) + '\n');
}

function finish(result) {
  if (finished) return;
  finished = true;
  try { app.kill('SIGTERM'); } catch {}
  process.stdout.write(JSON.stringify(result) + '\n');
}

function own(command) {
  return command && (
    command.includes(hookScript) ||
    (command.includes('hook-ingest.cjs') && command.includes('dashboard'))
  );
}

const timer = setTimeout(() => {
  finish({ trusted: 0, skipped: true, reason: 'codex_app_server_timeout', stderr });
}, 12000);

app.stderr.on('data', d => { stderr += d.toString(); });
app.on('error', err => {
  clearTimeout(timer);
  finish({ trusted: 0, skipped: true, reason: 'codex_app_server_error', error: String(err) });
});
app.on('exit', code => {
  if (!finished) {
    clearTimeout(timer);
    finish({ trusted: 0, skipped: true, reason: 'codex_app_server_exit', code, stderr });
  }
});

app.stdout.on('data', chunk => {
  stdout += chunk.toString();
  const lines = stdout.split('\n');
  stdout = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }

    if (msg.id === 0) {
      notify('initialized', {});
      send('hooks/list', { cwds: [cwd] });
      continue;
    }

    if (msg.id === 1) {
      if (msg.error) {
        clearTimeout(timer);
        finish({ trusted: 0, skipped: true, reason: 'hooks_list_error', error: msg.error });
        return;
      }

      const state = {};
      for (const entry of msg.result?.data || []) {
        for (const hook of entry.hooks || []) {
          if (hook.isManaged || !hook.key || !hook.currentHash || !own(hook.command)) continue;
          state[hook.key] = { enabled: true, trusted_hash: hook.currentHash };
        }
      }

      if (Object.keys(state).length === 0) {
        clearTimeout(timer);
        finish({ trusted: 0, skipped: true, reason: 'no_dashboard_hooks_discovered' });
        return;
      }

      trustedCount = Object.keys(state).length;
      send('config/batchWrite', {
        edits: [{
          keyPath: 'hooks.state',
          value: state,
          mergeStrategy: 'upsert'
        }],
        reloadUserConfig: true
      });
      continue;
    }

    if (msg.id === 2) {
      clearTimeout(timer);
      if (msg.error) {
        finish({ trusted: 0, skipped: true, reason: 'config_batch_write_error', error: msg.error });
      } else {
        finish({ trusted: trustedCount, status: msg.result?.status || 'ok' });
      }
    }
  }
});

send('initialize', {
  clientInfo: {
    name: clientName,
    title: 'Zylos Dashboard Hook Installer',
    version: '0.1.1'
  },
  capabilities: { experimentalApi: true }
});
`;

    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: this.zylosDir,
      env: {
        ...process.env,
        ZYLOS_DASHBOARD_CODEX_CWD: this.zylosDir,
        ZYLOS_DASHBOARD_HOOK_SCRIPT: this.hookScript
      },
      encoding: 'utf8',
      timeout: 15000
    });

    if (result.error) {
      return { trusted: 0, skipped: true, reason: 'trust_helper_error', error: String(result.error) };
    }
    if (result.status !== 0) {
      return {
        trusted: 0,
        skipped: true,
        reason: 'trust_helper_exit',
        status: result.status,
        stderr: result.stderr?.trim()
      };
    }

    const line = result.stdout.trim().split('\n').filter(Boolean).pop();
    if (!line) {
      return { trusted: 0, skipped: true, reason: 'trust_helper_no_output' };
    }

    try {
      return JSON.parse(line);
    } catch (err) {
      return {
        trusted: 0,
        skipped: true,
        reason: 'trust_helper_bad_output',
        error: String(err),
        stdout: result.stdout.trim()
      };
    }
  }

  installCodexHooks() {
    const config = this._readCodex();
    if (!config.hooks) config.hooks = {};
    const feature = this._enableCodexHookFeature();

    const cmd = this._codexCommand();
    let added = 0;

    for (const event of CODEX_HOOK_EVENTS) {
      if (!Array.isArray(config.hooks[event])) {
        config.hooks[event] = [];
      }

      const existingGroup = config.hooks[event].find(g =>
        g.hooks?.some(h => this._isOwn(h.command))
      );

      if (existingGroup) {
        for (const h of existingGroup.hooks) {
          if (this._isOwn(h.command)) {
            const needsUpdate = h.timeout !== 5 || h.async !== undefined || h.command !== cmd;
            if (needsUpdate) {
              h.timeout = 5;
              delete h.async;
              h.command = cmd;
              added++;
            }
          }
        }
        continue;
      }

      const entry = {
        hooks: [{ type: 'command', command: cmd, timeout: 5 }]
      };
      if (TOOL_EVENTS.has(event)) entry.matcher = '';
      config.hooks[event].push(entry);
      added++;
    }

    if (added > 0) this._writeCodex(config);
    const trust = this._trustCodexHooks();
    return { runtime: 'codex', added, total: CODEX_HOOK_EVENTS.length, path: this._codexPath(), feature, trust };
  }

  uninstallCodexHooks() {
    const config = this._readCodex();
    if (!config.hooks) {
      return { runtime: 'codex', removed: 0, trust: this._removeCodexTrustState() };
    }

    let removed = 0;
    const removedHookKeys = [];
    for (const event of Object.keys(config.hooks)) {
      if (!Array.isArray(config.hooks[event])) continue;
      const nextGroups = [];
      config.hooks[event].forEach((group, groupIndex) => {
        const hooks = group.hooks || [];
        const shouldRemove = hooks.some(h => this._isOwn(h.command));
        if (shouldRemove) {
          removed++;
          hooks.forEach((hook, hookIndex) => {
            if (this._isOwn(hook.command)) removedHookKeys.push(this._codexHookKey(event, groupIndex, hookIndex));
          });
        } else {
          nextGroups.push(group);
        }
      });
      config.hooks[event] = nextGroups;
      if (config.hooks[event].length === 0) delete config.hooks[event];
    }

    if (removed > 0) this._writeCodex(config);
    const trust = this._removeCodexTrustState(removedHookKeys);
    return { runtime: 'codex', removed, path: this._codexPath(), trust };
  }

  // --- StatusLine ---

  _isOwnStatusline(command) {
    if (!command) return false;
    return command.includes(this.statuslineScript) ||
      (command.includes('statusline-ingest.cjs') && command.includes('dashboard'));
  }

  installStatusline() {
    const settings = this._readClaude();
    const cmd = `node ${this.statuslineScript}`;

    if (settings.statusLine?.command && this._isOwnStatusline(settings.statusLine.command)) {
      return { installed: false, reason: 'already_installed', path: this._claudePath() };
    }

    if (settings.statusLine?.command && !this._isOwnStatusline(settings.statusLine.command)) {
      return { installed: false, reason: 'existing_statusline', path: this._claudePath() };
    }

    settings.statusLine = {
      type: 'command',
      command: cmd,
      refreshInterval: 5
    };

    this._writeClaude(settings);
    return { installed: true, path: this._claudePath() };
  }

  uninstallStatusline() {
    const settings = this._readClaude();
    if (!settings.statusLine || !this._isOwnStatusline(settings.statusLine.command)) {
      return { removed: false };
    }

    delete settings.statusLine;
    this._writeClaude(settings);
    return { removed: true, path: this._claudePath() };
  }

  // --- Combined ---

  install() {
    return {
      claude: this.installClaudeHooks(),
      codex: this.installCodexHooks(),
      statusline: this.installStatusline()
    };
  }

  uninstall() {
    return {
      claude: this.uninstallClaudeHooks(),
      codex: this.uninstallCodexHooks(),
      statusline: this.uninstallStatusline()
    };
  }
}
