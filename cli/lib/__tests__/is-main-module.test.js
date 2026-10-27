import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isMainModule as activityMain } from '../../../skills/activity-monitor/scripts/is-main-module.js';
import { isMainModule as bridgeMain } from '../../../skills/comm-bridge/scripts/is-main-module.js';
import { isMainModule as memoryMain } from '../../../skills/zylos-memory/scripts/is-main-module.js';

for (const [skill, isMainModule] of [['activity-monitor', activityMain], ['comm-bridge', bridgeMain], ['zylos-memory', memoryMain]]) {
  test(`ZYLO-85: ${skill} main-module helper preserves path identity`, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'main-module-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const file = path.join(root, 'entry.js'), other = path.join(root, 'other.js'), alias = path.join(root, 'alias.js');
    fs.writeFileSync(file, '');
    fs.writeFileSync(other, '');
    fs.symlinkSync(file, alias);
    const url = pathToFileURL(file).href;
    assert.equal(isMainModule(url, file), true);
    assert.equal(isMainModule(url, alias), true, 'argv alias must identify the same file');
    assert.equal(isMainModule(pathToFileURL(alias).href, file), true, 'module alias must identify the same file');
    assert.equal(isMainModule(url, other), false);
    assert.equal(isMainModule(url, path.join(root, 'missing.js')), false);
    assert.equal(isMainModule(url, ''), false);
    assert.equal(isMainModule('not a file URL', file), false);
    const argv1 = process.argv[1];
    assert.equal(isMainModule(pathToFileURL(argv1).href), true, 'default argument uses process argv');
    try {
      delete process.argv[1];
      assert.equal(isMainModule(url), false, 'missing argv must remain inert');
    } finally { process.argv[1] = argv1; }
  });
}
