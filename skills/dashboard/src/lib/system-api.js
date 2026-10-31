function sanitizePm2Process(proc) {
  if (!proc) return proc;
  return {
    pid: proc.pid,
    name: proc.name ?? proc.process_name ?? proc.pm2_env?.name,
    status: proc.pm2_env?.status ?? proc.status,
    cpu: proc.monit?.cpu ?? proc.cpu,
    memory: proc.monit?.memory ?? proc.memory ?? proc.memory_bytes,
    uptime: proc.pm2_env?.pm_uptime ?? proc.pm_uptime ?? proc.uptime ?? proc.uptime_ms,
    restarts: proc.pm2_env?.restart_time ?? proc.restart_time ?? proc.restarts,
    version: proc.pm2_env?.version ?? proc.version,
  };
}

function sanitizePm2List(processes) {
  if (!Array.isArray(processes)) return processes;
  return processes.map(sanitizePm2Process);
}

export function buildSystemPayload({ pm2Data, sysData, pm2State = [], systemSummary = null, scheduler = null }) {
  const pm2UpdatedAt = pm2State
    .map(p => p.updated_at)
    .filter(Boolean)
    .sort()
    .at(-1);

  const rawPm2 = pm2Data ? pm2Data.processes : (pm2State.length > 0 ? pm2State : null);

  return {
    pm2: rawPm2 ? sanitizePm2List(rawPm2) : null,
    system: sysData || systemSummary?.dimensions || null,
    scheduler: scheduler || null,
    collected_at: {
      pm2: pm2Data ? new Date(pm2Data.collectedAt).toISOString() : (pm2UpdatedAt || null),
      system: sysData ? new Date(sysData.collectedAt).toISOString() : (systemSummary?.timestamp || null)
    }
  };
}
