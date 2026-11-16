import test from 'node:test';
import assert from 'node:assert/strict';
import { createHistoryScope } from '../history-scope.js';
import { createGroupsApi } from '../../workbench/groups-api.js';
import { assertSessionGroup } from '../../../../../../cli/lib/session-group-paths.js';

// Scope and group-detail validation with supplied observations; missing session
// files stay under the official runner's isolated ZYLOS_DIR. No sockets,
// databases, runtime processes or catalog service are opened.
test('history rejects unknown safe keys while retaining offline and historical groups', async () => {
  const catalog = new Set(['origin', 'telegram:offline', 'telegram:运维群']);
  let readable = true;
  const groups = createGroupsApi({ workbench: { getSnapshot: async () => ({
    sources: { c4: { ok: readable } }, groupEvidence: { catalog }, readAt: 0,
    rows: [...catalog].map(sessionGroup => ({ sessionGroup, presence: 'not_running' })),
  }) } });
  const scope = createHistoryScope({
    load: async name => name === 'config.js' ? { readSessionMode: () => ({ mode: 'multi' }) } : { assertSessionGroup },
    readGroupKey: key => groups.detail(key, { include: [] }),
  });
  for (const group of catalog) {
    const result = await scope(new URLSearchParams({ session_group: group }));
    assert.equal(result.currentSessionId, null);
  }
  for (const group of ['nosuch:group', '../escape', 'telegram:不存在']) {
    await assert.rejects(scope(new URLSearchParams({ session_group: group })), { status: 400, code: 'invalid_session_group' });
  }
  readable = false;
  await assert.rejects(scope(new URLSearchParams({ session_group: 'nosuch:group' })), { status: 502, code: 'group_catalog_unreadable' });
  await assert.rejects(scope(new URLSearchParams({ session_group: 'telegram:运维群' })), { status: 502, code: 'group_catalog_unreadable' });
});
