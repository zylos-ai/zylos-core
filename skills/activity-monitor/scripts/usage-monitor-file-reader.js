import fs from 'node:fs';
import path from 'node:path';

function getFreshJson(filePath, nowEpoch, maxAgeSeconds) {
  try {
    const stat = fs.statSync(filePath);
    const mtimeEpoch = Math.floor(stat.mtimeMs / 1000);
    if ((nowEpoch - mtimeEpoch) > maxAgeSeconds) return null;
    return {
      json: JSON.parse(fs.readFileSync(filePath, 'utf8')),
      mtimeEpoch,
      mtimeIso: new Date(stat.mtimeMs).toISOString()
    };
  } catch {
    return null;
  }
}

export function parseClaudeStatuslineUsage(status, { zylosDir = null } = {}) {
  if (!status || typeof status !== 'object') return null;

  const usedPercentage = status.context_window?.used_percentage;
  if (!Number.isFinite(usedPercentage)) return null;

  if (zylosDir) {
    const candidates = [
      status.workspace?.project_dir,
      status.workspace?.current_dir,
      status.cwd
    ].filter(Boolean);

    if (candidates.length > 0) {
      const expected = path.resolve(zylosDir);
      const matches = candidates.some((candidate) => {
        try {
          return path.resolve(candidate) === expected;
        } catch {
          return false;
        }
      });
      if (!matches) return null;
    }
  }

  return {
    usage: {
      session: usedPercentage,
      sessionResets: null,
      weeklyAll: null,
      weeklyAllResets: null,
      weeklySonnet: null,
      weeklySonnetResets: null,
      fiveHour: null,
      fiveHourResets: null
    },
    statusShape: 'statusline',
    probeReason: 'monitor_file_statusline'
  };
}

export function parseCodexUsageState(state) {
  if (!state || typeof state !== 'object') return null;

  const session = state.session?.percent ?? null;
  const weeklyAll = state.weeklyAll?.percent ?? null;
  const weeklySonnet = state.weeklySonnet?.percent ?? null;
  const fiveHour = state.fiveHour?.percent ?? null;

  if (session === null && weeklyAll === null && weeklySonnet === null && fiveHour === null) {
    return null;
  }

  return {
    usage: {
      session,
      sessionResets: state.session?.resets ?? null,
      weeklyAll,
      weeklyAllResets: state.weeklyAll?.resets ?? null,
      weeklySonnet,
      weeklySonnetResets: state.weeklySonnet?.resets ?? null,
      fiveHour,
      fiveHourResets: state.fiveHour?.resets ?? null
    },
    statusShape: state.statusShape ?? 'monitor-file',
    probeReason: 'monitor_file_usage_codex',
    lastCheck: state.lastCheck ?? null,
    lastCheckEpoch: state.lastCheckEpoch ?? null,
    probeAt: state.probeAt ?? null
  };
}

export function readUsageFromMonitorFile({
  runtimeId,
  monitorDir,
  nowEpoch,
  maxAgeSeconds,
  zylosDir = null
}) {
  if (runtimeId === 'claude') {
    const result = getFreshJson(path.join(monitorDir, 'statusline.json'), nowEpoch, maxAgeSeconds);
    if (!result) return null;
    const parsed = parseClaudeStatuslineUsage(result.json, { zylosDir });
    if (!parsed) return null;
    return {
      ...parsed,
      lastCheck: result.mtimeIso,
      lastCheckEpoch: result.mtimeEpoch,
      probeAt: result.mtimeIso
    };
  }

  if (runtimeId === 'codex') {
    const result = getFreshJson(path.join(monitorDir, 'usage-codex.json'), nowEpoch, maxAgeSeconds);
    if (!result) return null;
    const parsed = parseCodexUsageState(result.json);
    if (!parsed) return null;
    return {
      ...parsed,
      lastCheck: parsed.lastCheck ?? result.mtimeIso,
      lastCheckEpoch: parsed.lastCheckEpoch ?? result.mtimeEpoch,
      probeAt: parsed.probeAt ?? parsed.lastCheck ?? result.mtimeIso
    };
  }

  return null;
}
