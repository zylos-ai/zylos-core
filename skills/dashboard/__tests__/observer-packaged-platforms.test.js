import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TmuxObserverContainment } from '../src/lib/observer-containment-tmux.js';
import { createObserverContainment } from '../src/lib/observer-containment.js';

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'observer-platform-unit-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return dataDir;
}

for (const [platform, arch] of [['darwin', 'arm64'], ['linux', 'x64'], ['linux', 'arm64']]) {
  test(`${platform}-${arch} product selects tmux without native helpers`, async () => {
    const adapter = createObserverContainment({ dataDir: os.tmpdir(), platform, arch, helperDir: '/missing-native-bundle' });
    assert.ok(adapter instanceof TmuxObserverContainment);
    assert.deepEqual(await adapter.verifyHelpers(), { tmux: 'tmux' });
  });
}

test('empty Linux and unsupported hosts reconcile without helpers, persisted state fails closed', async (t) => {
  for (const [platform, arch] of [['darwin', 'arm64'], ['linux', 'x64'], ['linux', 'arm64'], ['win32', 'x64']]) {
    const dataDir = fixture(t);
    const containment = createObserverContainment({ dataDir, platform, arch, helperDir: path.join(dataDir, 'missing') });
    assert.deepEqual(await containment.reconcilePersisted(), []);
    fs.mkdirSync(containment.runtimeRoot, { recursive: true, mode: 0o700 });
    assert.deepEqual(await containment.reconcilePersisted(), []);
    fs.mkdirSync(path.join(containment.runtimeRoot, 'persisted'));
    await assert.rejects(containment.reconcilePersisted());
    assert.equal(fs.existsSync(path.join(containment.runtimeRoot, 'persisted')), true);
  }
});
