import fs from 'node:fs';
import path from 'node:path';
import { loadCoreModule as defaultLoadCoreModule } from '../core-modules.js';

/** Hook pointers identify transcript ownership, never whether a session is alive.
 * Keeping this file-only lets background ingestion retain Origin messages before
 * any Dashboard viewer has requested a live session observation. */
export function createTranscriptSnapshot({ zylosDir = process.env.ZYLOS_DIR || process.cwd(),
  loadCoreModule = defaultLoadCoreModule } = {}) {
  const env = { ...process.env, ZYLOS_DIR: zylosDir };
  return async function getSnapshot() {
    const { sessionGroupRunRoot, groupRunDir } = await loadCoreModule('session-group-paths.js');
    let groups;
    try { groups = fs.readdirSync(sessionGroupRunRoot(env), { withFileTypes: true }); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      groups = [];
    }
    const rows = [];
    for (const group of groups) {
      if (!group.isDirectory()) continue;
      try {
        const pointer = JSON.parse(fs.readFileSync(path.join(groupRunDir(group.name, env), 'current-session.json'), 'utf8'));
        if (typeof pointer.runId !== 'string' || !pointer.runId || typeof pointer.sessionId !== 'string' || !pointer.sessionId ||
            !Number.isInteger(pointer.ts) || !Array.isArray(pointer.startupControlIds) || !pointer.startupControlIds.every(Number.isInteger)) continue;
        rows.push({ sessionGroup: group.name, presence: 'unknown',
          live: { runId: pointer.runId, sessionId: pointer.sessionId } });
      } catch { /* A missing or unreadable pointer supplies no transcript authority. */ }
    }
    return { listKnown: true, transcriptIdentityOnly: true, rows };
  };
}
