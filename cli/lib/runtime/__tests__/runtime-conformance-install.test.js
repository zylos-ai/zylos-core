import assert from 'node:assert/strict';
import test from 'node:test';
import { UNSUPPORTED } from '../contract.js';
import { getRuntime, runtimeInstallPolicy, SUPPORTED_RUNTIMES } from '../index.js';

test('runtime installation policy requires a matching installer and local-bin declaration', async () => {
  for (const id of SUPPORTED_RUNTIMES) {
    const { install } = await getRuntime(id);
    assert.equal(install.install === UNSUPPORTED, install.installsToLocalBin === UNSUPPORTED, id);
    if (runtimeInstallPolicy(id) === 'whenUsed') assert.notEqual(install.install, UNSUPPORTED, id);
  }
});
