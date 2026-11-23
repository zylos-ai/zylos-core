import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { projectGroup } from '../src/lib/workbench/groups-api.js';

import { handleCoreAction } from '../src/lib/core-actions.js';

// Covers target selection and C4 acceptance with a private database; no runtime is contacted.
test('Origin interrupt and nudge use configured scopes accepted by C4', async t => {
  const { fileURLToPath } = await import('node:url');
  const Database = (await import('better-sqlite3')).default;
  const { ZYLOS_DIR } = await import('../../../cli/lib/config.js');
  const configDir = path.join(ZYLOS_DIR, '.zylos');
  const script = path.join(ZYLOS_DIR, '.claude/skills/comm-bridge/scripts/c4-control.js');
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.symlinkSync(fileURLToPath(new URL('./helpers/origin-control-child.js', import.meta.url)), script);
  for (const session_mode of ['single', 'multi', undefined]) {
    fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ session_mode }));
    const detail = projectGroup({ sessionGroup: session_mode === 'multi' ? 'origin' : null,
      presence: 'running', live: { runId: 'observed-run', sessionId: 'observed-session', status: { valid: true, state: 'idle' } } },
    { readAt: Date.now(), instance: { sessionModeStatus: { sessionMode: session_mode ?? null } } });
    const sessionGroup = session_mode ? 'origin' : null;
    assert.equal(detail.sessionGroup, session_mode === 'multi' ? 'origin' : null);
    const body = { sessionGroup: detail.sessionGroup, runId: detail.live.runId, sessionId: detail.live.sessionId };
    for (const action of ['interrupt', 'chop-chop']) {
      const result = await handleCoreAction(action, body, { zylosDir: ZYLOS_DIR });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.submission, 'submitted');
      const db = new Database(path.join(ZYLOS_DIR, 'controls.db'), { readonly: true });
      try {
        const row = db.prepare('SELECT session_group FROM control_queue WHERE id=?').get(result.controlId);
        assert.equal(row.session_group, sessionGroup);
      } finally { db.close(); }
    }
    const mismatch = await handleCoreAction('interrupt', { sessionGroup: detail.sessionGroup === null ? 'origin' : null, runId: 'observed-run' }, { zylosDir: ZYLOS_DIR });
    assert.equal(mismatch.error, 'TARGET_SCOPE_MISMATCH');
  }
});
