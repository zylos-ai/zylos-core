import { loadCoreModule } from './core-modules.js';

const { UNSUPPORTED } = await loadCoreModule('runtime/contract.js');

function toPositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function toBool(value, fallback) {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return fallback;
}

export function getToolRules({ runtimeId, watchdog, config = {} } = {}) {
  if (!watchdog || watchdog === UNSUPPORTED) return [];

  const watchdogEnabled = toBool(config.web_tool_watchdog_enabled, true);
  const timeoutSec = toPositiveInt(config.web_tool_timeout_sec, 3600);
  const interruptGraceSec = toPositiveInt(config.web_tool_interrupt_grace_sec, 15);
  const cooldownSec = toPositiveInt(config.web_tool_timeout_cooldown_sec, 60);

  return [
    {
      id: 'web-tools-timeout',
      runtime: runtimeId,
      tools: watchdog.tools,
      inputPredicate: () => true,
      observe: { summary: 'tool-specific' },
      policy: null,
      watchdog: {
        enabled: watchdogEnabled,
        maxRuntimeSec: timeoutSec,
        interruptKey: watchdog.interruptKey,
        interruptGraceSec,
        escalation: 'restart',
        cooldownSec
      }
    }
  ];
}

export function findMatchingToolRule({ runtimeId, watchdog, toolName, toolInput = {}, config = {} } = {}) {
  if (!toolName) return null;

  for (const rule of getToolRules({ runtimeId, watchdog, config })) {
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
