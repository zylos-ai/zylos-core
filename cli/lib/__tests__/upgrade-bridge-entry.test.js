import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-bridge-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}


function expectedAdmissionMessage(version) {
  return `Core ${version || '(unknown)'} cannot upgrade directly. Run zylos upgrade --self --branch release/0.9.3 to reach Core 0.9.3 first. Run zylos --version to verify Core 0.9.3, then rerun your original upgrade command.`;
}

test('thin entry refuses recovery failure before checking or downloading updates', async () => {
  const {upgradeSelfCore} = await import('../../commands/component.js');
  const stdout=[], stderr=[];
  let checked = false;
  const result = await upgradeSelfCore({skipConfirm:true}, {
    recoverBeforeUpgrade() {throw Object.assign(Error('recovery blocked'), {
      code:'UPGRADE_RECOVERY_REQUIRED', recovery_required:true, next:'Run zylos recovery status.',
    });},
    checkForCoreUpdates() {checked=true; return {success:true,hasUpdate:false};},
    console:{log(value){stdout.push(value);},error(value){stderr.push(value);}},
  });
  assert.equal(result, false);
  assert.equal(checked, false);
  assert.deepEqual(stdout, []);
  assert.deepEqual(stderr, ['Error: recovery blocked', 'Next: Run zylos recovery status.']);
});

// Covers real preinstall error propagation without installation or service access.
// Run when admission guidance or preinstall changes; otherwise it may be skipped.
// The runner isolates HOME, ZYLOS_DIR, PM2_HOME and TMPDIR; no tmux or database is used.
test('actual preinstall rejects legacy upgrades and allows fresh/new upgrades without target dependencies', t => {
  const root = fixture(t), script = path.resolve('scripts/preinstall.js');
  const env = { ...process.env, HOME: root, ZYLOS_DIR: root, PM2_HOME: path.join(root, '.pm2') };
  delete env.ZYLOS_SKIP_POSTINSTALL;
  delete env.ZYLOS_UPGRADE_FROM_VERSION;
  const run = extra => spawnSync(process.execPath, [script], { env: { ...env, ...extra }, encoding: 'utf8' });
  assert.equal(run({}).status, 0);
  for (const value of ['', '0', 'true', '01', ' 1']) {
    const child=run({ZYLOS_SKIP_POSTINSTALL:value,ZYLOS_UPGRADE_FROM_VERSION:'0.9.2'});
    assert.equal(child.status,0,child.stderr);
  }
  for (const version of [undefined, '0.5.0', '0.8.3', '0.9.0', '0.9.1', '0.9.2', '0.9.3-beta.1']) {
    const child = run({ ZYLOS_SKIP_POSTINSTALL: '1', ...(version ? { ZYLOS_UPGRADE_FROM_VERSION: version } : {}) });
    assert.equal(child.status, 1);
    assert.equal(child.stdout, '');
    assert.equal(child.stderr.split('\n').find(line => line.startsWith('Error: ')),
      `Error: ${expectedAdmissionMessage(version)} If an older upgrade has already stopped services (especially Core 0.9.0 backup-only mode), preserve its backup and verify the previous Core package is complete and usable before manually restarting the previously running services. Do not assume npm restored the previous package.`);
    assert.equal(child.stderr.split('\n').find(line => line.includes("code: '"))?.trim(),
      "code: 'UPGRADE_SOURCE_TOO_OLD',");
  }
  for (const version of ['0.9.3', '0.9.4', '1.0.0-beta.1', '1.0.0']) {
    assert.equal(run({ ZYLOS_SKIP_POSTINSTALL: '1', ZYLOS_UPGRADE_FROM_VERSION: version }).status, 0);
  }
  assert.deepEqual(fs.readdirSync(root), []);
});
