import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const COMPOSIO_SERVER_NAME = 'composio';
export const COMPOSIO_API_KEY_ENV = 'COMPOSIO_API_KEY';
export const COMPOSIO_MCP_URL_ENV = 'COMPOSIO_MCP_URL';
export const COMPOSIO_USER_ID_ENV = 'COMPOSIO_USER_ID';
export const COMPOSIO_SESSION_ENDPOINT = 'https://backend.composio.dev/api/v3/tool_router/session';
export const CLAUDE_COMPOSIO_MCP_MARKER_FILE = '.mcp.zylos.json';
export const CODEX_COMPOSIO_MCP_MARKER_FILE = 'composio.zylos.json';

export const COMPOSIO_META_TOOLS = [
  'COMPOSIO_SEARCH_TOOLS',
  'COMPOSIO_GET_TOOL_SCHEMAS',
  'COMPOSIO_MULTI_EXECUTE_TOOL',
  'COMPOSIO_MANAGE_CONNECTIONS',
];

export const COMPOSIO_REMOTE_CODE_TOOLS = [
  'COMPOSIO_REMOTE_BASH_TOOL',
  'COMPOSIO_REMOTE_WORKBENCH',
];

export const CLAUDE_COMPOSIO_ALLOWED_TOOLS = COMPOSIO_META_TOOLS.map(
  (tool) => `mcp__${COMPOSIO_SERVER_NAME}__${tool}`,
);

export const CLAUDE_COMPOSIO_DENIED_TOOLS = [
  `mcp__${COMPOSIO_SERVER_NAME}__*BASH*`,
  `mcp__${COMPOSIO_SERVER_NAME}__*WORKBENCH*`,
  ...COMPOSIO_REMOTE_CODE_TOOLS.map((tool) => `mcp__${COMPOSIO_SERVER_NAME}__${tool}`),
];

function parseEnvContent(content = '') {
  const vars = {};
  for (const rawLine of content.split('\n')) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    vars[key] = value;
  }
  return vars;
}

function upsertEnvValue(content, key, value, comment = null) {
  const line = `${key}=${value}`;
  if (content.match(new RegExp(`^${key}=.*$`, 'm'))) {
    return content.replace(new RegExp(`^${key}=.*$`, 'm'), line);
  }
  const prefix = comment ? `\n\n# ${comment}\n` : '\n';
  return content.trimEnd() + `${prefix}${line}\n`;
}

function isValidHttpUrl(value) {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !!url.host;
  } catch {
    return false;
  }
}

function readEnvVars(envPath) {
  try {
    return parseEnvContent(fs.readFileSync(envPath, 'utf8'));
  } catch {
    return {};
  }
}

export function writeTextFileAtomic(filePath, content, { mode = 0o600 } = {}) {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, content, { mode });
  fs.renameSync(tmpPath, filePath);
  try { fs.chmodSync(filePath, mode); } catch {}
}

export function readJsonFile(filePath, readFileSync = fs.readFileSync) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function renderComposioMarker(mcpUrl) {
  return JSON.stringify({
    version: 1,
    managedMcpServers: {
      [COMPOSIO_SERVER_NAME]: {
        source: 'zylos-core',
        url: mcpUrl,
        apiKeyEnv: COMPOSIO_API_KEY_ENV,
      },
    },
  }, null, 2) + '\n';
}

function getComposioMarker(marker) {
  const server = marker?.managedMcpServers?.[COMPOSIO_SERVER_NAME];
  if (!server || typeof server !== 'object') return null;
  if (server.source !== 'zylos-core') return null;
  if (server.apiKeyEnv !== COMPOSIO_API_KEY_ENV) return null;
  if (!isValidHttpUrl(String(server.url || ''))) return null;
  return server;
}

function matchesComposioMarker(server, marker) {
  const managed = getComposioMarker(marker);
  if (!server || typeof server !== 'object' || !managed) return false;
  return String(server.url || '') === managed.url;
}

export function renderClaudeComposioMarker(mcpUrl) {
  return renderComposioMarker(mcpUrl);
}

export function getClaudeComposioMarker(marker) {
  return getComposioMarker(marker);
}

export function matchesClaudeComposioMarker(server, marker) {
  return matchesComposioMarker(server, marker);
}

export function renderCodexComposioMarker(mcpUrl) {
  return renderComposioMarker(mcpUrl);
}

export function getCodexComposioMarker(marker) {
  return getComposioMarker(marker);
}

export function matchesCodexComposioMarker(server, marker) {
  return matchesComposioMarker(server, marker);
}

export function isDesiredCodexComposioServer(server, mcpUrl) {
  if (!server || typeof server !== 'object') return false;
  return String(server.url || '') === mcpUrl &&
    String(server.bearer_token_env_var || '') === COMPOSIO_API_KEY_ENV &&
    Array.isArray(server.disabled_tools) &&
    COMPOSIO_REMOTE_CODE_TOOLS.every((tool) => server.disabled_tools.includes(tool));
}

function quoteCurlConfigValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function deriveComposioUserId({ projectDir, envVars = {} } = {}) {
  const explicitUserId = String(envVars[COMPOSIO_USER_ID_ENV] || '').trim();
  if (explicitUserId) return explicitUserId;
  const stableInput = path.resolve(projectDir || process.env.ZYLOS_DIR || process.cwd());
  const digest = crypto.createHash('sha256').update(stableInput).digest('hex').slice(0, 24);
  return `zylos-${digest}`;
}

export function createComposioToolRouterSession(apiKey, {
  userId,
  projectDir,
  execFile = execFileSync,
  endpoint = COMPOSIO_SESSION_ENDPOINT,
} = {}) {
  const resolvedUserId = userId || deriveComposioUserId({ projectDir });
  const payload = JSON.stringify({
    user_id: resolvedUserId,
    workbench: {
      enable: false,
    },
  });
  const curlConfig = [
    `header = "x-api-key: ${quoteCurlConfigValue(apiKey)}"`,
    'header = "content-type: application/json"',
  ].join('\n') + '\n';
  const output = execFile('curl', [
    '-fsS',
    '-X', 'POST',
    endpoint,
    '--config', '-',
    '--data', payload,
  ], { encoding: 'utf8', timeout: 30000, input: curlConfig });
  const parsed = JSON.parse(output);
  const toolNames = Array.isArray(parsed?.tool_router_tools)
    ? parsed.tool_router_tools.map((tool) => typeof tool === 'string' ? tool : tool?.name).filter(Boolean)
    : [];
  const exposedRemoteCodeTools = COMPOSIO_REMOTE_CODE_TOOLS.filter((tool) => toolNames.includes(tool));
  if (exposedRemoteCodeTools.length > 0) {
    throw new Error(`Composio session still exposes remote code tools: ${exposedRemoteCodeTools.join(', ')}`);
  }
  const mcpUrl = parsed?.mcp?.url || parsed?.url || '';
  if (!isValidHttpUrl(mcpUrl)) {
    throw new Error('Composio session response did not include a valid MCP URL.');
  }
  return mcpUrl;
}

export function resolveComposioMcpUrl({
  projectDir,
  envPath = path.join(projectDir, '.env'),
  createSession = createComposioToolRouterSession,
  createMissingSession = true,
  writeFileAtomic = writeTextFileAtomic,
  readFileSync = fs.readFileSync,
  mkdirSync = fs.mkdirSync,
} = {}) {
  let content = '';
  try { content = readFileSync(envPath, 'utf8'); } catch {}
  const vars = parseEnvContent(content);
  const apiKey = (vars[COMPOSIO_API_KEY_ENV] || '').trim();
  const userId = deriveComposioUserId({ projectDir, envVars: vars });
  let mcpUrl = (vars[COMPOSIO_MCP_URL_ENV] || '').trim();

  if (!apiKey) {
    return { enabled: false, reason: 'missing_api_key', mcpUrl: '' };
  }

  if (!mcpUrl) {
    if (!createMissingSession) {
      return { enabled: false, reason: 'missing_mcp_url', mcpUrl: '' };
    }
    try {
      mcpUrl = createSession(apiKey, { userId, projectDir });
    } catch (err) {
      return { enabled: false, reason: 'session_create_failed', mcpUrl: '', error: err.message };
    }
    const nextContent = upsertEnvValue(
      content,
      COMPOSIO_MCP_URL_ENV,
      mcpUrl,
      'Composio Tool Router MCP URL (generated by zylos)',
    );
    mkdirSync(path.dirname(envPath), { recursive: true });
    writeFileAtomic(envPath, nextContent, { mode: 0o600 });
  }

  if (!isValidHttpUrl(mcpUrl)) {
    return { enabled: false, reason: 'invalid_mcp_url', mcpUrl };
  }

  return { enabled: true, reason: 'configured', mcpUrl, apiKey };
}

export function renderClaudeComposioMcpJson({ mcpUrl, apiKey }) {
  return JSON.stringify({
    mcpServers: {
      [COMPOSIO_SERVER_NAME]: {
        type: 'http',
        url: mcpUrl,
        headers: {
          'x-api-key': apiKey,
        },
      },
    },
  }, null, 2) + '\n';
}

export function renderTemplateComposioMcpJson() {
  return JSON.stringify({
    mcpServers: {
      [COMPOSIO_SERVER_NAME]: {
        type: 'http',
        url: '${COMPOSIO_MCP_URL}',
        headers: {
          'x-api-key': '${COMPOSIO_API_KEY}',
        },
      },
    },
  }, null, 2) + '\n';
}

export function syncClaudeComposioMcpJson({
  projectDir,
  envPath = path.join(projectDir, '.env'),
  mcpPath = path.join(projectDir, '.mcp.json'),
  markerPath = path.join(projectDir, CLAUDE_COMPOSIO_MCP_MARKER_FILE),
  dryRun = false,
  resolve = resolveComposioMcpUrl,
  existsSync = fs.existsSync,
  readFileSync = fs.readFileSync,
  mkdirSync = fs.mkdirSync,
  unlinkSync = fs.unlinkSync,
  writeMcp = writeTextFileAtomic,
  log = () => {},
} = {}) {
  const resolved = resolve({ projectDir, envPath, createMissingSession: !dryRun });
  let current = {};
  let hadValidJson = true;
  if (existsSync(mcpPath)) {
    current = readJsonFile(mcpPath, readFileSync);
    if (!current) {
      hadValidJson = false;
    }
  }
  const marker = readJsonFile(markerPath, readFileSync);

  if (!hadValidJson) {
    log(`  Warning: ${mcpPath} is not valid JSON; Composio MCP sync skipped.`);
    return { changed: false, enabled: resolved.enabled, skipped: true, reason: 'invalid_json' };
  }

  current.mcpServers = current.mcpServers && typeof current.mcpServers === 'object'
    ? current.mcpServers
    : {};

  if (!resolved.enabled) {
    const existing = current.mcpServers[COMPOSIO_SERVER_NAME];
    if (matchesClaudeComposioMarker(existing, marker)) {
      delete current.mcpServers[COMPOSIO_SERVER_NAME];
      if (Object.keys(current.mcpServers).length === 0) delete current.mcpServers;
      if (Object.keys(current).length === 0) {
        if (!dryRun) {
          try { unlinkSync(mcpPath); } catch {}
        }
      } else {
        if (!dryRun) {
          mkdirSync(path.dirname(mcpPath), { recursive: true });
          writeMcp(mcpPath, JSON.stringify(current, null, 2) + '\n');
        }
      }
      if (!dryRun) {
        try { unlinkSync(markerPath); } catch {}
      }
      return { changed: true, enabled: false, reason: resolved.reason, mcpUrl: resolved.mcpUrl };
    }
    if (!existing && getClaudeComposioMarker(marker)) {
      if (!dryRun) {
        try { unlinkSync(markerPath); } catch {}
      }
      return { changed: true, enabled: false, reason: resolved.reason, mcpUrl: resolved.mcpUrl };
    }
    return { changed: false, enabled: false, reason: resolved.reason, mcpUrl: resolved.mcpUrl };
  }

  const desired = JSON.parse(renderClaudeComposioMcpJson(resolved));
  const before = JSON.stringify(current.mcpServers[COMPOSIO_SERVER_NAME] || null);
  if (current.mcpServers[COMPOSIO_SERVER_NAME] &&
      !matchesClaudeComposioMarker(current.mcpServers[COMPOSIO_SERVER_NAME], marker)) {
    log(`  Warning: ${mcpPath} already has an unmarked Composio MCP server; leaving it unchanged.`);
    return {
      changed: false,
      enabled: false,
      skipped: true,
      reason: 'user_owned_collision',
      mcpUrl: resolved.mcpUrl,
    };
  }

  current.mcpServers[COMPOSIO_SERVER_NAME] = desired.mcpServers[COMPOSIO_SERVER_NAME];
  const after = JSON.stringify(current.mcpServers[COMPOSIO_SERVER_NAME]);
  const desiredMarker = renderClaudeComposioMarker(resolved.mcpUrl);
  const currentMarker = existsSync(markerPath) ? readFileSync(markerPath, 'utf8') : '';
  if (before === after && currentMarker === desiredMarker) {
    return { changed: false, enabled: true, reason: resolved.reason, mcpUrl: resolved.mcpUrl };
  }

  if (!dryRun) {
    mkdirSync(path.dirname(mcpPath), { recursive: true });
    writeMcp(mcpPath, JSON.stringify(current, null, 2) + '\n');
    writeMcp(markerPath, desiredMarker);
  }
  return { changed: true, enabled: true, reason: resolved.reason, mcpUrl: resolved.mcpUrl };
}

export function syncClaudeComposioSettings(settings, templateSettings = {}, { dryRun = false } = {}) {
  let changed = false;
  const templateServers = Array.isArray(templateSettings.enabledMcpjsonServers)
    ? templateSettings.enabledMcpjsonServers
    : [COMPOSIO_SERVER_NAME];

  if (!Array.isArray(settings.enabledMcpjsonServers)) {
    if (!dryRun) settings.enabledMcpjsonServers = [];
    changed = true;
  }
  const enabledServers = Array.isArray(settings.enabledMcpjsonServers) ? settings.enabledMcpjsonServers : [];
  for (const server of templateServers) {
    if (!enabledServers.includes(server)) {
      if (!dryRun) settings.enabledMcpjsonServers.push(server);
      changed = true;
    }
  }

  const templatePermissions = templateSettings.permissions || {};
  const allow = Array.isArray(templatePermissions.allow)
    ? templatePermissions.allow
    : CLAUDE_COMPOSIO_ALLOWED_TOOLS;
  const deny = Array.isArray(templatePermissions.deny)
    ? templatePermissions.deny
    : CLAUDE_COMPOSIO_DENIED_TOOLS;

  if (!settings.permissions || typeof settings.permissions !== 'object') {
    if (!dryRun) settings.permissions = {};
    changed = true;
  }
  const permissions = settings.permissions && typeof settings.permissions === 'object' ? settings.permissions : {};
  for (const [key, values] of [['allow', allow], ['deny', deny]]) {
    if (!Array.isArray(permissions[key])) {
      if (!dryRun) settings.permissions[key] = [];
      changed = true;
    }
    const existing = Array.isArray(permissions[key]) ? permissions[key] : [];
    for (const value of values) {
      if (!existing.includes(value)) {
        if (!dryRun) settings.permissions[key].push(value);
        changed = true;
      }
    }
  }

  return { changed };
}

export function getComposioEnv(projectDir) {
  return readEnvVars(path.join(projectDir, '.env'));
}
