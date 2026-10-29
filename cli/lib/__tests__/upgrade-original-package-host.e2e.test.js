import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createProtectedPackageCrashFixture} from './helpers/protected-package-crash.js';

const enabled = process.env.ZYLOS_RUN_ORIGINAL_PACKAGE_HOST_E2E === '1';

function assertServicesRecovered(f, from = 0) {
  const state = f.serviceState();
  const calls = f.commandCalls().slice(from);
  for (const service of ['activity-monitor', 'scheduler']) {
    assert.equal(state[service], 'online');
    const stop = calls.findIndex(line => line === `pm2 stop ${service}`);
    assert.ok(stop >= 0, `missing stop for ${service}`);
    assert.ok(calls.findIndex((line, index) => index > stop &&
      (line === `pm2 restart ${service}` || /pm2 (?:start|startOrRestart) .* --only /.test(line) && line.includes(`--only ${service}`))) > stop,
    `missing start after stop for ${service}`);
  }
}

// Explicit opt-in: these cases install real packages into a private npm prefix.
for (const targetBinChanged of [false, true]) test(`real package directory compensation restores the original tree${targetBinChanged ? ' after the target changes bin mappings' : ''}`, {
  skip: !enabled,
  timeout: 1200000,
}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'original-package-host-'));
  t.diagnostic(`Isolated fixture (retained on failure) at ${root}`);
  const f = createProtectedPackageCrashFixture(root, {targetBinChanged});
  const {target} = await f.build();
  const before = f.installedTreeHash();
  const result = f.entry(f.handoff(target, 'download'), {failureStage:'after'});
  assert.equal(result.status, 1, JSON.stringify(result));
  assert.equal(result.result.success, false);
  assert.match(result.result.error, /injected post-install failure/);
  const [{journal}] = f.journal();
  assert.equal(journal.originalPackageRestored, true);
  assert.equal(f.installedTreeHash(), journal.originalPackage.treeHash);
  assert.equal(f.installedTreeHash(), before);
  assert.equal(f.binTarget('zylos'), path.join(f.core, 'cli/zylos.js'));
  assert.equal(f.version(), '0.9.3');
  assertServicesRecovered(f);
  fs.rmSync(root, {recursive:true, force:true});
});

test('real package directory compensation resumes across interrupted copy and bin repair', {
  skip: !enabled,
  timeout: 2400000,
}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'original-package-reentry-'));
  t.diagnostic(`Isolated fixture (retained on failure) at ${root}`);
  const f = createProtectedPackageCrashFixture(root, {targetBinChanged:true});
  const {target} = await f.build();
  const before = f.installedTreeHash();
  for (const boundary of ['copying', 'before-bin-repair']) {
    const callsBefore = f.commandCalls().length;
    const observed = await f.killDuringRestore(f.handoff(target, `interrupted-${boundary}`), boundary);
    assert.equal(observed.journal.phase, 'installing');
    assert.equal(observed.journal.installationIntent, true);
    assert.notEqual(observed.journal.originalPackageRestored, true);
    if (boundary === 'copying') {
      let interruptedHash = null;
      try { interruptedHash = f.installedTreeHash(); } catch {}
      assert.notEqual(interruptedHash, observed.journal.originalPackage.treeHash);
    } else {
      assert.equal(f.installedTreeHash(), observed.journal.originalPackage.treeHash);
      assert.notEqual(f.binTarget('zylos'), path.join(f.core, 'cli/zylos.js'));
      assert.equal(fs.existsSync(f.binTarget('zylos')), false);
    }
    const recovered = f.recover(target);
    assert.equal(recovered.active, true);
    assert.equal(recovered.result.completed, true, JSON.stringify(recovered));
    assert.equal(recovered.result.stage, 'restored_complete');
    const saved = f.journal().find(item => item.dir === observed.dir).journal;
    assert.equal(saved.originalPackageRestored, true);
    assert.equal(f.installedTreeHash(), saved.originalPackage.treeHash);
    assert.equal(f.installedTreeHash(), before);
    assert.equal(f.binTarget('zylos'), path.join(f.core, 'cli/zylos.js'));
    assert.equal(f.version(), '0.9.3');
    assertServicesRecovered(f, callsBefore);
  }
  fs.rmSync(root, {recursive:true, force:true});
});
