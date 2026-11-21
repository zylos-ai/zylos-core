/** Antigravity hook configuration and native event handling. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ZYLOS_DIR } from '../../config.js';
import { writePrivateFile } from '../../private-file.js';
import { runDirFromEnv } from '../../session-group-paths.js';
import { UNSUPPORTED } from '../contract.js';
import { buildKickPrompt } from '../kick-prompt.js';
import { selectToolInput } from '../shared/tool-input.js';
import { sessionSwitch } from './switch.js';

function objectFile(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object');
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw Object.assign(new Error(`Cannot merge Antigravity configuration: ${file}`, { cause: error }), { code: 'AGY_CONFIG_UNREADABLE' });
  }
}

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

export function agyConfigurationPaths(home = os.homedir()) {
  const gemini = path.join(home, '.gemini');
  return {
    settings: path.join(gemini, 'antigravity-cli/settings.json'),
    hooks: path.join(gemini, 'config/hooks.json'),
    mcp: path.join(gemini, 'config/mcp_config.json'),
    onboarding: path.join(gemini, 'antigravity-cli/cache/onboarding.json'),
  };
}

export function syncAgyConfig({ zylosDir = ZYLOS_DIR, home = os.homedir(), dryRun = false } = {}) {
  const root = path.resolve(zylosDir);
  const files = agyConfigurationPaths(home);
  // Read every file before writing any, so malformed user configuration is never replaced.
  const current = Object.fromEntries(Object.entries(files).map(([key, file]) => [key, objectFile(file)]));
  if (current.mcp.mcpServers !== undefined && (!current.mcp.mcpServers || typeof current.mcp.mcpServers !== 'object' || Array.isArray(current.mcp.mcpServers))) {
    throw Object.assign(new Error('Cannot merge Antigravity MCP servers'), { code: 'AGY_CONFIG_UNREADABLE' });
  }
  const command = event => `node ${quote(path.join(root, '.claude/skills/activity-monitor/scripts/agy-hooks.js'))} ${event}`;
  const desired = {
    settings: { ...current.settings, modelProvider: 'gemini', userDataCollectionForceDisabled: true,
      statusLine: { ...current.settings.statusLine, type: 'command', command: `node ${quote(path.join(root, '.claude/skills/activity-monitor/scripts/context-monitor.js'))}` } },
    // Register only in HOME: agy executes global and workspace hook copies independently.
    hooks: { ...current.hooks, zylos: {
      ...Object.fromEntries(['SessionStart', 'PreInvocation', 'Stop'].map(event => [event, [{ type: 'command', command: command(event), timeout: 60 }]])),
      PreToolUse: [
        { matcher: '^ask_question$', hooks: [{ type: 'command',
          command: `node ${quote(path.join(root, '.claude/skills/activity-monitor/scripts/agy-tool-guard.js'))}`, timeout: 5 }] },
        { matcher: '^run_command$', hooks: [{ type: 'command', command: command('PreToolUse'), timeout: 10 }] },
      ],
      PostToolUse: [{ matcher: '^run_command$', hooks: [{ type: 'command', command: command('PostToolUse'), timeout: 10 }] }],
    } },
    mcp: { ...current.mcp, mcpServers: { ...current.mcp.mcpServers, 'zylos-memory': { command: 'node', args: [path.join(root, '.claude/skills/zylos-memory/scripts/memory-mcp-server.js')] } } },
    onboarding: { ...current.onboarding, consumerOnboardingComplete: true, onboardingComplete: true },
  };
  const changedFiles = Object.keys(files).filter(key => JSON.stringify(current[key]) !== JSON.stringify(desired[key]));
  if (!dryRun) {
    for (const key of changedFiles) {
      fs.mkdirSync(path.dirname(files[key]), { recursive: true });
      writePrivateFile(files[key], JSON.stringify(desired[key], null, 2) + '\n');
    }
  }
  return { changed: changedFiles.length > 0, files: changedFiles.map(key => files[key]) };
}

export function isAgyConfigReady(options) {
  try { return !syncAgyConfig({ ...options, dryRun: true }).changed; }
  catch { return false; }
}

/** Existing Zylos hooks identify an opted-in HOME; unrelated agy settings are left alone. */
export function hasAgyZylosHooks(home = os.homedir()) {
  try { return Object.hasOwn(objectFile(agyConfigurationPaths(home).hooks), 'zylos'); }
  catch { return false; }
}

const nativeEvents = new Set(['SessionStart', 'PreInvocation', 'Stop', 'PreToolUse', 'PostToolUse']);

// Stop.error is an optional string in AGY's native hook schema. Keep only a
// category: native text can contain request URLs, keys or other private data.
function agyStopError(error) {
  if (typeof error !== 'string') return 'server_error';
  const rejectedStatus = /\b(?:HTTP(?:\/\d(?:\.\d)?)?\s*|status(?:\s+code)?[\s:=]*)(?:401|403)\b|\b(?:401\s+Unauthorized|403\s+Forbidden)\b/i;
  const rejectedKey = /\bAPI_KEY_INVALID\b|\b(?:invalid|rejected)\s+API[ _-]?key\b|\bAPI[ _-]?key\s+(?:(?:is|was)\s+)?(?:not valid|invalid|rejected)\b/i;
  if (rejectedStatus.test(error) || rejectedKey.test(error)) return 'authentication_failed';
  return /proxyconnect|connection\s+refused|\b(?:ECONNREFUSED|ENETUNREACH|EHOSTUNREACH)\b/i.test(error) ? 'network_error' : 'server_error';
}

function normalizeAgyHook(payload, eventName) {
  if (!payload || typeof payload !== 'object') return null;
  const event = eventName || payload.hookEventName || payload.hook_event_name;
  const session = payload.conversationId;
  if (!nativeEvents.has(event) || typeof session !== 'string' || !session) return null;
  if (event === 'PreToolUse' || event === 'PostToolUse') {
    if (payload.toolCall?.name !== 'run_command' || typeof payload.toolCall.id !== 'string' || !payload.toolCall.id) return null;
    return { session_id: session, transcript_path: payload.transcriptPath,
      hook_event_name: event === 'PostToolUse' && payload.error ? 'PostToolUseFailure' : event,
      tool_name: 'run_command', tool_use_id: payload.toolCall.id, tool_input: payload.toolCall.args,
      ...(event === 'PostToolUse' && payload.error ? { error: 'tool_error' } : {}) };
  }
  if (event === 'PreInvocation' && payload.invocationNum !== 0) return null;
  if (event === 'Stop' && payload.fullyIdle !== true && String(payload.terminationReason).toUpperCase() !== 'ERROR') return null;
  return { ...payload, session_id: session, transcript_path: payload.transcriptPath,
    hook_event_name: event === 'PreInvocation' ? 'UserPromptSubmit' :
      event === 'Stop' && String(payload.terminationReason).toUpperCase() === 'ERROR' ? 'StopFailure' : event,
    ...(event === 'Stop' && String(payload.terminationReason).toUpperCase() === 'ERROR' ? { error: agyStopError(payload.error) } : {}) };
}

function readAgySessionSource(env = process.env) {
  const file = path.join(runDirFromEnv(env).dir, sessionSwitch.clearSourceMarker);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    fs.unlinkSync(file);
    const marker = JSON.parse(raw);
    const source = marker.runId === env.ZYLOS_RUN_ID && marker.source === 'clear' ? 'clear' : 'startup';
    return source;
  }
  catch { return 'startup'; }
}

function read(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function acceptAgyMainEvent(payload, event, env = process.env) {
  const id = payload?.conversationId;
  if (typeof id !== 'string' || !id) return null;
  const dir = runDirFromEnv(env).dir, runId = env.ZYLOS_RUN_ID || null;
  const file = path.join(dir, 'agy-main-session.json');
  const saved = read(file);
  let record = saved?.runId === runId && typeof saved.conversationId === 'string' && saved.conversationId ? saved : null;
  const sample = read(path.join(dir, 'statusline.json'));
  const statusId = runId && sample?.zylos?.v === 1 && sample.zylos.runId === runId
    ? sample.session_id ?? sample.conversation_id : null;
  const marker = read(path.join(dir, sessionSwitch.clearSourceMarker));
  const clearing = marker?.runId === runId && marker.source === 'clear';
  const input = typeof payload.lastUserInput === 'string' ? payload.lastUserInput.trim() : '';
  const kick = event === 'SessionStart' && (input === buildKickPrompt() || input.startsWith(buildKickPrompt() + '\n'));
  if (record?.conversationId !== id) {
    if (!(statusId === id || kick) || (record && !clearing)) return null;
    record = { runId, conversationId: id, rulesPending: false };
    write(file, record);
  }
  return { file, record };
}

function setAgyRulesPending(binding, pending) {
  binding.record.rulesPending = pending;
  write(binding.file, binding.record);
}

const denial = reason => ({ decision: 'deny', reason });
const invalidInput = () => denial('Cannot validate tool input. Ask the user in plain text instead.');

function guardAgyTool(payload) {
  if (typeof payload?.toolCall?.name !== 'string' || !payload.toolCall.name) return invalidInput();
  return payload.toolCall.name === 'ask_question'
    ? denial('Ask the user in plain text instead of calling ask_question.')
    : { decision: 'allow' };
}

const mainSession = Object.freeze({
  accept(payload, argvEvent, env) {
    const event = argvEvent || payload?.hookEventName || payload?.hook_event_name;
    if (!nativeEvents.has(event)) return null;
    return { event, binding: acceptAgyMainEvent(payload, event, env) };
  },
  update(binding, event, payload, { rulesText }) {
    if (event === 'Stop' && String(payload.terminationReason).toUpperCase() === 'TERMINAL_CUSTOM_HOOK') {
      setAgyRulesPending(binding, true);
    }
    if (event === 'PreInvocation' && binding.record.rulesPending) {
      const rules = rulesText();
      setAgyRulesPending(binding, false);
      return { rules };
    }
    return { rules: null };
  },
});

function output({ event, result }) {
  if (event === 'PreToolUse') return '{"decision":"allow"}';
  if (result?.kind !== 'rules' && result?.kind !== 'session') return '{}';
  let text = result.text;
  if (result.kind === 'session' && result.source === 'clear') {
    text += '\nMessages in RECENT CONVERSATIONS that you have already replied to are finished: do not reply to them again.\n';
  }
  return JSON.stringify({ injectSteps: [{ systemMessage: { systemMessage: text } }] });
}

export const hooks = Object.freeze({
  sessionIdEnv: UNSUPPORTED,
  sync: async options => syncAgyConfig(options),
  syncPolicy: 'opted-in',
  optedIn: ({ home }) => hasAgyZylosHooks(home),
  ready: async options => isAgyConfigReady(options),
  trust: UNSUPPORTED,
  features: UNSUPPORTED,
  stage: UNSUPPORTED,
  writeConfig: UNSUPPORTED,
  installHooks: UNSUPPORTED,
  normalize: normalizeAgyHook,
  output,
  toolInput: selectToolInput,
  mainSession,
  readSessionSource: readAgySessionSource,
  toolGuard: guardAgyTool,
});
