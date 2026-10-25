import { loadCoreModule } from './bootstrap-scope.js';

export function isSubsession(payload) {
  return Boolean(payload?.agent_id || payload?.agent_type || payload?.is_subagent);
}

// Use the pinned M2 observer for both READY and the legacy foreground record.
export async function readBootstrapIdentity(scope, { env = process.env, pid = process.pid,
  load = loadCoreModule, open, observe, processTree } = {}) {
  const targets = await load('runtime/session-target.js');
  open ??= (await load('runtime/tmux-connection.js')).openTmuxConnection;
  observe ??= targets.observeSessionTarget;
  processTree ??= targets.readProcessTree;
  const paths = await load('session-group-paths.js');
  const names = scope.kind === 'legacy' ? paths.LEGACY_TMUX_NAMES : [paths.tmuxNameForGroup(scope.sessionGroup ?? 'origin')];
  const rows = await processTree();
  const ancestors = new Map();
  let current = pid;
  for (let depth = 0; depth < 128 && current > 1 && !ancestors.has(current); depth++) {
    const row = rows.find(item => item.pid === current);
    if (!row) break;
    ancestors.set(current, row);
    current = row.ppid;
  }
  for (const tmuxName of names) {
    const connection = await open();
    try {
      const target = await observe({ connection, tmuxName, sessionGroup: scope.sessionGroup, readReady: async () => null });
      if (!target.present || !['claude', 'codex'].includes(target.runtime)) continue;
      if (scope.kind !== 'legacy' && (target.runId !== env.ZYLOS_RUN_ID ||
        (target.rawF2.ZYLOS_SESSION_GROUP ?? null) !== (scope.sessionGroup ?? null))) continue;
      if (env.TMUX_PANE && env.TMUX_PANE !== target.paneId) continue;
      const panePid = Number((await connection.command(['display-message', '-p', '-t', target.paneId, '#{pane_pid}'])).trim());
      if (!ancestors.has(panePid)) continue;
      let runtimeProcess;
      for (const row of ancestors.values()) {
        if (row.name.replace(/\.exe$/, '') === target.runtime) { runtimeProcess = row; break; }
        if (row.pid === panePid) break;
      }
      if (!runtimeProcess) continue;
      return { runtime: target.runtime, runtimePid: runtimeProcess.pid, tmuxName, paneId: target.paneId, runId: target.runId };
    } finally { connection.close(); }
  }
  throw Object.assign(new Error('Hook is not in the current managed runtime pane'), { code: 'IDENTITY_UNAVAILABLE' });
}
