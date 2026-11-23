import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { getRuntime, SUPPORTED_RUNTIMES } from '../index.js';
import { UNSUPPORTED } from '../contract.js';
import { buildKickPrompt } from '../kick-prompt.js';
import { validateLaunchConfig } from '../session-command.js';

function assertFrozenStrings(values) {
  assert.ok(Array.isArray(values) && Object.isFrozen(values));
  assert.ok(values.every(value => typeof value === 'string' && value.length > 0));
}

for (const id of SUPPORTED_RUNTIMES) {
  test(`${id} declares its launch policies`, async () => {
    const { launch } = await getRuntime(id);
    assert.equal(typeof launch.buildArgs, 'function');
    assert.ok(['always', 'override'].includes(launch.helpProbe));
    assert.ok(['separator', 'kick'].includes(launch.promptPlacement));
    assert.ok(Object.isFrozen(launch.env));
    assertFrozenStrings(launch.env.fromDotenv);
    assertFrozenStrings(launch.env.fromDotenvOrProcess);
    const { fixed } = launch.env;
    assert.equal(Object.getPrototypeOf(fixed), Object.prototype);
    assert.ok(Object.isFrozen(fixed));
    assert.ok(Object.values(fixed).every(value => typeof value === 'string'));

    assert.equal(launch.efforts === UNSUPPORTED, launch.overrideHelpFlags === UNSUPPORTED);
    if (launch.efforts !== UNSUPPORTED) {
      for (const values of [launch.efforts, launch.overrideHelpFlags]) {
        assertFrozenStrings(values);
        assert.ok(values.length > 0);
      }
    }
  });
}

for (const id of SUPPORTED_RUNTIMES) {
  const runtime = await getRuntime(id);
  const { launch } = runtime;
  if (launch.promptPlacement === 'kick') {
    test(`${id} passes the kick as its last argument`, () => {
      const args = launch.buildArgs({ runtime: id, mode: 'default' }, { root: '/z', help: '' });
      assert.equal(args.at(-1), buildKickPrompt());
    });
  }
  if (launch.efforts !== UNSUPPORTED) {
    test(`${id} accepts overrides against recorded CLI help`, async () => {
      const help = await readFile(new URL(`./samples/${id}/launch/help.txt`, import.meta.url), 'utf8');
      assert.equal(validateLaunchConfig(runtime, {
        runtime: id, mode: 'override', model: 'sample-model', effort: launch.efforts[0],
      }, help), true);
    });
  }
}
