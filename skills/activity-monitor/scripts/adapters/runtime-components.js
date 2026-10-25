import { ToolPipeline } from '../tool-pipeline.js';
import { UsageMonitor } from '../usage-monitor.js';
import { getToolRules } from '../tool-rules.js';

export function createUsageMonitor(adapter, options) {
  return new UsageMonitor(adapter, options);
}

/** Tool facts are consumed by Supervisor; this factory owns no lifecycle action. */
export function createToolPipeline(adapter, config, {
  files, getRuntimeLaunchAtMs, isPidAlive, log, onHealthEvent,
}) {
  const rules = getToolRules({ runtimeId: adapter.runtimeId, config });
  return {
    pipeline: new ToolPipeline({ files, toolRules: rules, runtimeLaunchAtMs: getRuntimeLaunchAtMs,
      isPidAlive, log, onHealthEvent }),
    toolRules: rules,
  };
}
