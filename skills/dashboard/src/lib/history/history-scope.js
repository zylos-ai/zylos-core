import fs from 'node:fs/promises';
import path from 'node:path';
import { loadCoreModule } from '../core-modules.js';

// Historical selection uses imported attribution and files only. It must remain
// available for offline groups without opening tmux or starting Observer.
export function createHistoryScope({ config = {}, store, load = loadCoreModule, readCurrentSessionId } = {}) {
  return async function scope(params) {
    const group = params.get('session_group') ?? 'origin';
    const [{ assertSessionGroup }, { readSessionMode }] = await Promise.all([
      load('session-group-paths.js'), load('config.js'),
    ]);
    try { assertSessionGroup(group); } catch {
      throw Object.assign(new Error('Invalid session group'), { status: 400, code: 'invalid_session_group' });
    }
    const mode = readSessionMode().mode;
    if (mode !== 'multi' && group !== 'origin') {
      throw Object.assign(new Error('Only Origin is available in single session mode'), { status: 400, code: 'target_mismatch' });
    }
    const attribution = store?.getHistoryAttribution?.() ?? [];
    const revision = store?.historyRevision ?? 0;
    const belongs = row => (row.session_group ?? 'origin') === group;
    const selected = attribution.filter(belongs);
    let current = null;
    const root = config.zylosDir || process.env.ZYLOS_DIR;
    if (root) {
      if (mode === 'multi') {
        try { current = JSON.parse(await fs.readFile(path.join(root, 'activity-monitor', 'session-groups', group, 'current-session.json'), 'utf8')).sessionId || null; }
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
    const runtime = selected.find(row => row.session_id === current)?.runtime || selected[0]?.runtime || config.runtime || 'claude';
    const sessionIds = new Set(selected.filter(row => row.runtime === runtime).map(row => row.session_id));
    if (current) sessionIds.add(current);
    const excludedSessionIds = new Set(attribution.filter(row => !belongs(row) && row.runtime === runtime).map(row => row.session_id));
    // Unattributed pre-multi-session transcripts belong to Origin. Other groups
    // require positive attribution, including parent ids for Claude subagents.
    return { revision, runtime, currentSessionId: current, sessionIds: group === 'origin' ? null : sessionIds, excludedSessionIds };
  };
}
