import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
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

const expected = {
  claude: { doctor: '2.1.296 (Claude Code)', dashboard: '2.1.296' },
  codex: { doctor: 'codex-cli 0.137.0', dashboard: '0.137.0' },
};
for (const id of SUPPORTED_RUNTIMES) {
  test(`${id} parses recorded CLI version output for doctor and Dashboard`, async t => {
    const samples = new URL(`./samples/${id}/install/`, import.meta.url);
    const manifestFile = new URL('manifest.json', samples);
    const manifestText = await fs.readFile(manifestFile, 'utf8').catch(error => {
      if (id === 'agy' && error.code === 'ENOENT') return null;
      throw error;
    });
    if (manifestText === null) {
      t.skip('Requires a version capture from the isolated Antigravity review instance.');
      return;
    }
    const manifest = JSON.parse(manifestText);
    assert.ok(Object.hasOwn(manifest.files, 'version.txt'));
    const stdout = await fs.readFile(new URL('version.txt', samples), 'utf8');
    const versions = expected[id];
    assert.equal(typeof versions?.doctor, 'string', 'Record the expected first line for doctor');
    assert.equal(typeof versions?.dashboard, 'string', 'Record the expected version for Dashboard');
    const { install } = await getRuntime(id);
    const env = { [`${id.toUpperCase()}_BIN`]: process.execPath };
    for (const profile of ['doctor', 'dashboard']) {
      const result = await install.probeVersion({
        profile,
        env,
        execFile: async (command, args, options) => {
          assert.equal(command, process.execPath);
          assert.deepEqual(args, ['--version']);
          assert.equal(options.timeout, profile === 'dashboard' ? 5000 : id === 'claude' ? 30000 : 10000);
          assert.equal(options.env.AGY_CLI_DISABLE_AUTO_UPDATE, id === 'agy' && profile === 'doctor' ? 'true' : undefined);
          return { stdout };
        },
      });
      assert.deepEqual(result, { installed: true, version: versions[profile], probeFailed: false });
    }
  });
}
