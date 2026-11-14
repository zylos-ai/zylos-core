import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectStatus } from '../status-view.js';
import { RestartRequestStore } from '../../../skills/activity-monitor/scripts/restart-request-store.js';

test('status uses the request store validator and clears pause after repair', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'status-requests-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'restart-requests.json'), store = new RestartRequestStore({ file });
  const deps = { requests: () => store.read(), mode: () => ({ mode: 'single' }), configIssue: () => null,
    resolveRoot: () => {}, runtimes: [], session: () => ({ identity: { present: false },
      status: { valid: false, reason: 'not_running', sampledAt: null } }) };
  assert.equal((await collectStatus(deps)).supervisorPaused, false, 'missing file is readable empty intent');
  for (const content of ['broken', '{}', '[{"unexpected":true}]']) {
    fs.writeFileSync(file, content);
    assert.equal((await collectStatus(deps)).supervisorPaused, true);
    assert.equal(fs.readFileSync(file, 'utf8'), content, 'status is read only');
  }
  fs.writeFileSync(file, '[]');
  assert.equal((await collectStatus(deps)).supervisorPaused, false);
});
