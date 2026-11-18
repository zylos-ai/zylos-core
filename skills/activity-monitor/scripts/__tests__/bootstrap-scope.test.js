import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { bootstrapScope } from '../bootstrap-scope.js';

test('bootstrap scope follows environment in single mode', async () => {
  const root = process.env.ZYLOS_DIR;
  fs.mkdirSync(path.join(root, '.zylos'), {recursive:true});
  fs.writeFileSync(path.join(root,'.zylos/config.json'), JSON.stringify({session_mode:'single'}));
  for (const group of [null, 'origin', 'telegram:example']) {
    const env = {ZYLOS_DIR:root, ZYLOS_RUN_ID:'test-run', ...(group ? {ZYLOS_SESSION_GROUP:group} : {})};
    const scope = await bootstrapScope(env);
    assert.equal(scope.scope, group ?? '*');
    assert.equal(scope.memoryDir, path.join(root,'memory', ...(group ? ['session-groups',group] : [])));
    assert.equal(scope.dir, path.join(root,'activity-monitor/session-groups',group ?? 'origin'));
  }
  for (const group of ['', '../escape']) {
    await assert.rejects(bootstrapScope({ZYLOS_DIR:root, ZYLOS_SESSION_GROUP:group}), {code:'SESSION_GROUP_INVALID'});
  }
});
