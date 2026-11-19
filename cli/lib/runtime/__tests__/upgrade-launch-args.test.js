import { seedCodexTrustFixture } from '../../../../test/helpers/codex-trust.js';
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as commands from '../session-command.js';
import * as upgrades from '../upgrade-context.js';
import * as launch from '../session-launch.js';

let context;
let captured;
// Keep launch argument construction and prompt application real; stop at the
// script/tmux boundary so these module tests cannot start a runtime or server.
mock.module('../session-command.js', { namedExports: {
  ...commands,
  writeSessionLaunchScript: options => { captured = options; return {}; },
} });
mock.module('../upgrade-context.js', { namedExports: {
  ...upgrades,
  discoverUpgradeContext: root => context ?? upgrades.discoverUpgradeContext(root),
} });
mock.module('../session-launch.js', { namedExports: {
  ...launch,
  settleLaunch: async () => ({ launched: true }),
} });

const { launchSession } = await import('../launch-flow.js');

test('throwing trusted discovery builds an isolated recovery launch', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'upgrade-discovery-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stable = path.join(root, '.zylos/upgrade');
  await fs.mkdir(stable, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(stable, 'active.json'), '{}', { mode: 0o600 });
  await fs.writeFile(path.join(stable, 'maintenance.cjs'), '// fixture dependency\n', { mode: 0o600 });
  await fs.writeFile(path.join(stable, 'bootstrap.cjs'),
    'exports.bootstrap = () => { throw Error("discovery unavailable"); };\n', { mode: 0o600 });
  context = undefined;
  captured = undefined;
  let closed = false;
  const codex = path.join(root, 'codex');
  await fs.writeFile(codex, '#!/bin/sh\necho codex-fixture\n', { mode: 0o700 });
  seedCodexTrustFixture({ root, home: root });
  const adapterOptions = {
    root,
    env: { HOME: root, PATH: '/empty' },
    paths: { tmuxNameForGroup: () => 'isolated' },
    runtimeExecutable: () => codex,
    runtimeHelp: async () => ' --no-daemon ',
    dependencies: {
      openTmuxConnection: async () => ({ close: () => { closed = true; } }),
      observeSessionTarget: async () => ({ present: false }),
    },
  };
  const launchConfig = { runtime: 'codex', mode: 'default' };
  const ordinary = commands.buildRuntimeArgs('codex', launchConfig, { root, help: ' --no-daemon ' });
  assert.deepEqual(await launchSession({ runtime: 'codex', sessionGroup: null, runId: 'isolated-run', sessionMode: 'single', launchConfig }, adapterOptions),
    { launched: true });
  assert.equal(closed, true);
  assert.deepEqual(captured.args.slice(0, -1), ordinary.slice(0, -1));
  assert.match(captured.args.at(-1), /Upgrade discovery failed/);
  assert.match(captured.args.at(-1), /Do not query C4/);
  assert.equal(captured.args.at(-1).includes(ordinary.at(-1)), false);
});
