import { URL } from 'node:url';

function toPositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function toBool(value, fallback) {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return fallback;
}

function summarizeWebFetch(toolInput = {}) {
  const rawUrl = typeof toolInput.url === 'string' ? toolInput.url.trim() : '';
  if (!rawUrl) {
    return { type: 'input-keys', value: Object.keys(toolInput).sort() };
  }
  try {
    const parsed = new URL(rawUrl);
    return { type: 'url-host', value: parsed.host || parsed.hostname || rawUrl };
  } catch {
    return { type: 'url-preview', value: rawUrl.slice(0, 120) };
  }
}

function summarizeWebSearch(toolInput = {}) {
  const query = typeof toolInput.query === 'string'
    ? toolInput.query.trim()
    : (typeof toolInput.prompt === 'string' ? toolInput.prompt.trim() : '');
  if (!query) {
    return { type: 'input-keys', value: Object.keys(toolInput).sort() };
  }
  return { type: 'query-preview', value: query.slice(0, 120) };
}

function summarizeBash(toolInput = {}) {
  const command = typeof toolInput.command === 'string' ? toolInput.command.trim() : '';
  if (!command) {
    return { type: 'input-keys', value: Object.keys(toolInput).sort() };
  }
  return { type: 'command-head', value: command.split(/\s+/)[0] || command.slice(0, 80) };
}

export function summarizeToolInput(toolName, toolInput = {}) {
  switch (toolName) {
    case 'WebFetch':
      return summarizeWebFetch(toolInput);
    case 'WebSearch':
      return summarizeWebSearch(toolInput);
    case 'Bash':
      return summarizeBash(toolInput);
    default:
      return { type: 'input-keys', value: Object.keys(toolInput || {}).sort() };
  }
}

export function getToolRules({ runtimeId = 'claude', config = {} } = {}) {
  const watchdogEnabled = toBool(config.web_tool_watchdog_enabled, true);
  const timeoutSec = toPositiveInt(config.web_tool_timeout_sec, 3600);
  const interruptGraceSec = toPositiveInt(config.web_tool_interrupt_grace_sec, 15);
  const cooldownSec = toPositiveInt(config.web_tool_timeout_cooldown_sec, 60);

  return [
    {
      id: 'web-tools-timeout',
      runtime: 'claude',
      tools: ['WebFetch', 'WebSearch'],
      inputPredicate: () => true,
      observe: { summary: 'tool-specific' },
      policy: null,
      watchdog: {
        enabled: runtimeId === 'claude' && watchdogEnabled,
        maxRuntimeSec: timeoutSec,
        interruptKey: 'Escape',
        interruptGraceSec,
        escalation: 'restart',
        cooldownSec
      }
    }
  ];
}

export function findMatchingToolRule({ runtimeId = 'claude', toolName, toolInput = {}, config = {} } = {}) {
  if (!toolName) return null;

  for (const rule of getToolRules({ runtimeId, config })) {
    if (rule.runtime !== runtimeId) continue;
    if (!rule.tools.includes(toolName)) continue;
    try {
      if (rule.inputPredicate && !rule.inputPredicate(toolInput)) continue;
    } catch {
      continue;
    }
    return rule;
  }

  return null;
}
