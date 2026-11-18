import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { bootstrapScope } from '../bootstrap-scope.js';

for (const config of [{}, {session_mode:'single'}, {session_mode:'multi'}, '{broken']) {
  test(`bootstrap scope follows environment with config ${JSON.stringify(config)}`, async () => {
    const root = process.env.ZYLOS_DIR;
    fs.mkdirSync(path.join(root, '.zylos'), {recursive:true});
    fs.writeFileSync(path.join(root,'.zylos/config.json'), typeof config === 'string' ? config : JSON.stringify(config));
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
}
