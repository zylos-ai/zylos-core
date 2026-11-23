import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { getRuntime, SUPPORTED_RUNTIMES } from '../index.js';
import { UNSUPPORTED } from '../contract.js';
import { validateLaunchConfig } from '../session-command.js';


for (const id of SUPPORTED_RUNTIMES) {
  const runtime = await getRuntime(id);
  const { launch } = runtime;
  if (launch.efforts !== UNSUPPORTED) {
    test(`${id} accepts overrides against recorded CLI help`, async () => {
      const help = await readFile(new URL(`./samples/${id}/launch/help.txt`, import.meta.url), 'utf8');
      assert.equal(validateLaunchConfig(runtime, {
        runtime: id, mode: 'override', model: 'sample-model', effort: launch.efforts[0],
      }, help), true);
    });
  }
}
