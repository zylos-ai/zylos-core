import fs from 'node:fs/promises';
import path from 'node:path';
import { loadCoreModule } from '../core-modules.js';

// Historical selection uses imported attribution and files only. It must remain
// available for offline groups without opening tmux or starting Observer.
export function createHistoryScope({ config = {}, store, load = loadCoreModule, readCurrentSessionId, readGroupKey } = {}) {
  return async function scope(params, route) {
    const group = params.get('session_group') ?? 'origin';
    const [{ assertSessionGroup }, { readSessionMode }] = await Promise.all([
      load('session-group-paths.js'), load('config.js'),
    ]);
    try {
      if (readGroupKey) await readGroupKey(group);
      else assertSessionGroup(group);
    } catch (error) {
      if (error.code === 'GROUP_CATALOG_UNREADABLE') {
        throw Object.assign(new Error('Session group catalog could not be read'), { status: 502, code: 'group_catalog_unreadable' });
      }
      throw Object.assign(new Error('Invalid session group'), { status: 400, code: 'invalid_session_group' });
    }
    const mode = readSessionMode().mode;
    const attribution = store?.getHistoryAttribution?.() ?? [];
    const revision = store?.historyRevision ?? 0;
    const belongs = row => (row.session_group ?? 'origin') === group;
    const selected = attribution.filter(belongs);
    let current = null;
    const root = config.zylosDir || process.env.ZYLOS_DIR;
    if (root) {
      if (mode === 'multi') {
        try {
          const ready = JSON.parse(await fs.readFile(path.join(root, 'activity-monitor', 'session-groups', group, 'current-session.json'), 'utf8'));
          current = ready.sessionId || null;
        }
        catch { /* Offline groups retain history; there is no current session. */ }
      } else if (readCurrentSessionId) {
        // The Dashboard already samples the managed runtime identity. A missing
        // live single session is authoritative even if an old ready file remains.
        current = await readCurrentSessionId() ?? null;
      } else {
        try { current = JSON.parse(await fs.readFile(path.join(root, 'activity-monitor', 'statusline.json'), 'utf8')).session_id || null; }
        catch { /* Legacy single-session installations may have no sample. */ }
      }
    }
    const currentRuntime = selected.find(row => row.session_id === current)?.runtime ?? null;
    const runtime = currentRuntime ?? selected[0]?.runtime ?? config.runtime ?? 'claude';
    const session = route === 'sessions' ? null : params.get('session')?.split('/')[0];
    const ownerRuntime = selected.find(row => row.session_id === session)?.runtime;
    const runtimes = ownerRuntime ? [ownerRuntime] : [...new Set([runtime, ...selected.map(row => row.runtime)])];
    const children = store?.childSessionIds?.() ?? [];
    const scopes = runtimes.map(engine => {
      const currentSessionId = engine === (currentRuntime ?? runtime) ? current : null;
      const sessionIds = new Set(selected.filter(row => row.runtime === engine).map(row => row.session_id));
      if (currentSessionId) sessionIds.add(currentSessionId);
      const excludedSessionIds = new Set(attribution.filter(row => !belongs(row) && row.runtime === engine).map(row => row.session_id));
      // Unattributed transcripts are eligible only for Origin. Child runtimes
      // are counted for cost only, regardless of the selected parser.
      for (const id of children) excludedSessionIds.add(id);
      return { revision, runtime: engine, currentSessionId, sessionIds: group === 'origin' ? null : sessionIds, excludedSessionIds };
    });
    return { ...scopes[0], scopes };
  };
}
