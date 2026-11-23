import { seedCodexTrustFixture } from '../../../../test/helpers/codex-trust.js';
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as commands from '../session-command.js';
import * as upgrades from '../upgrade-context.js';
import * as tmux from '../tmux-connection.js';
import * as claudeLaunch from '../claude/launch.js';
import * as codexLaunch from '../codex/launch.js';
import { getRuntime } from '../index.js';
import { buildKickPrompt } from '../kick-prompt.js';

let context;
let captured;
let skipCodexPrepare = false;
// Keep launch argument construction and prompt application real; stop at the
// script/tmux boundary so these module tests cannot start a runtime or server.
mock.module('../session-command.js', { namedExports: {
  ...commands,
  writeSessionLaunchScript: options => { captured = options; return { file: '/unused', cleanup() {} }; },
} });
mock.module('../upgrade-context.js', { namedExports: {
  ...upgrades,
  discoverUpgradeContext: root => context ?? upgrades.discoverUpgradeContext(root),
} });
mock.module('../tmux-connection.js', { namedExports: {
  ...tmux,
  runTmuxCommand: async () => { throw new Error('isolated tmux boundary'); },
} });
mock.module('../claude/launch.js', { namedExports: { ...claudeLaunch, prepare: async () => {} } });
mock.module('../codex/launch.js', { namedExports: {
  ...codexLaunch,
  prepare: options => skipCodexPrepare ? undefined : codexLaunch.prepare(options),
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
  const ordinary = (await getRuntime('codex')).launch.buildArgs(launchConfig, { root, help: ' --no-daemon ' });
  await assert.rejects(launchSession({ runtime: 'codex', sessionGroup: null, runId: 'isolated-run', sessionMode: 'single', launchConfig }, adapterOptions),
    { code: 'LAUNCH_FAILED' });
  assert.equal(closed, true);
  assert.deepEqual(captured.args.slice(0, -1), ordinary.slice(0, -1));
  assert.match(captured.args.at(-1), /Upgrade discovery failed/);
  assert.match(captured.args.at(-1), /Do not query C4/);
  assert.equal(captured.args.at(-1).includes(ordinary.at(-1)), false);
});

for (const runtime of ['claude', 'codex']) {
  test(`${runtime} puts blocked and interrupted upgrade prompts at its startup prompt boundary`, async t => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'upgrade-prompt-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    t.after(() => { context = undefined; skipCodexPrepare = false; });
    skipCodexPrepare = true;
    const help = ' --no-daemon ';
    const launchConfig = { runtime, mode: 'default' };
    const options = {
      root,
      env: { HOME: root, PATH: '/empty' },
      paths: { tmuxNameForGroup: () => 'isolated' },
      runtimeExecutable: () => '/unused',
      runtimeHelp: async () => help,
      dependencies: {
        openTmuxConnection: async () => ({ close() {} }),
        observeSessionTarget: async () => ({ present: false }),
      },
    };
    const ordinary = (await getRuntime(runtime)).launch.buildArgs(launchConfig, { root, help });
    for (const blocked of [true, false]) {
      const prompt = blocked ? 'Upgrade blocked' : 'Upgrade interrupted';
      context = { blocked, active: true, controllerAlive: false, prompt };
      captured = undefined;
      await assert.rejects(launchSession({
        runtime, sessionGroup: null, runId: 'isolated-run', sessionMode: 'single', launchConfig,
      }, options), { code: 'LAUNCH_FAILED', message: 'isolated tmux boundary' });
      const expected = runtime === 'claude'
        ? [...ordinary, '--', prompt]
        : [...ordinary.slice(0, -1), blocked ? prompt : `${buildKickPrompt()}\n\n${prompt}`];
      assert.deepEqual(captured.args, expected);
    }
  });
}
