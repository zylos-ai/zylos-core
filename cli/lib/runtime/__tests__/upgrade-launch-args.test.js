import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as commands from '../session-command.js';
import * as upgrades from '../upgrade-context.js';

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
  discoverUpgradeContext: () => context,
} });
mock.module('../session-launch.js', { namedExports: {
  settleLaunch: async () => ({ launched: true }),
} });
const { SessionAdapter } = await import('../session-adapter.js');

const states = {
  blocked: { active: true, blocked: true, prompt: 'SYSTEM RECOVERY TASK: upgrade blocked' },
  interrupted: { active: true, blocked: false, controllerAlive: false, prompt: 'SYSTEM RECOVERY TASK: controller exited' },
  none: { active: false, blocked: false },
  observing: { active: true, blocked: false, controllerAlive: true, prompt: 'Observe the live controller' },
  empty: { active: true, blocked: true, prompt: '' },
};

for (const runtime of ['claude', 'codex', 'agy']) {
  for (const [state, upgrade] of Object.entries(states)) {
    test(`${runtime} launch preserves argument boundaries during ${state} upgrade`, async t => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'upgrade-args-'));
      t.after(() => fs.rm(root, { recursive: true, force: true }));
      context = upgrade;
      captured = undefined;
      let closed = false;
      class Adapter extends SessionAdapter { get runtimeId() { return runtime; } }
      const adapter = new Adapter({
        root,
        env: { HOME: root, PATH: '/empty' },
        paths: { tmuxNameForGroup: () => 'isolated' },
        runtimeExecutable: () => '/unused-runtime',
        runtimeHelp: async () => ' --no-daemon ',
        dependencies: {
          openTmuxConnection: async () => ({ close: () => { closed = true; } }),
          observeSessionTarget: async () => ({ present: false }),
        },
      });
      const launchConfig = { runtime, mode: 'default' };
      const original = commands.buildRuntimeArgs(runtime, launchConfig, { root, help: ' --no-daemon ' });
      await adapter.launch({ sessionGroup: null, runId: 'isolated-run', sessionMode: 'single', launchConfig });
      assert.equal(closed, true);
      const args = captured.args;
      assert.equal(captured.root, root);
      const hasPrompt = ['blocked', 'interrupted'].includes(state);
      if (!hasPrompt) {
        assert.deepEqual(args, original);
        assert.equal(args.includes('--'), false);
      } else if (runtime === 'claude') {
        assert.deepEqual(args.slice(0, -2), original);
        assert.deepEqual(args.slice(-2), ['--', upgrade.prompt]);
        assert.equal(args.filter(arg => arg === '--').length, 1);
        const mcpIndex = args.indexOf('--mcp-config');
        assert.equal(args.indexOf('--'), mcpIndex + 2);
        const mcp = JSON.parse(args[mcpIndex + 1]);
        assert.equal(mcp.mcpServers['zylos-memory'].command, 'node');
        assert.deepEqual(mcp.mcpServers['zylos-memory'].args,
          [path.join(root, '.claude/skills/zylos-memory/scripts/memory-mcp-server.js')]);
      } else {
        assert.equal(args.includes('--'), false);
        assert.deepEqual(args.slice(0, -1), original.slice(0, -1));
        assert.equal(args.at(-1), state === 'blocked' ? upgrade.prompt : `${original.at(-1)}\n\n${upgrade.prompt}`);
      }
    });
  }
}
