import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { getRuntime } from '../index.js';
import { agyConfigurationPaths } from '../agy/hooks.js';

test('dream runtime adapters select their fixed model and medium effort with an isolated tool configuration', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dream-adapters-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const model = {
    claude: ['claude-sonnet-5-5', 'medium'],
    codex: ['gpt-6.1-terra', 'model_reasoning_effort="medium"'],
    agy: ['Gemini 4 Hydrogen (Medium)'],
  };
  for (const [id, expected] of Object.entries(model)) {
    const runtime = await getRuntime(id);
    const cwd = path.join(root, id);
    fs.mkdirSync(cwd);
    const prepared = runtime.dream.prepare({ cwd, root, env: {}, server: '/private/memory-mcp-server.js',
      serverEnv: { ZYLOS_MEMORY_DREAM_ROOT: root }, instructions: 'System prompt', input: 'Dream input', tools: true });
    assert.equal(prepared.stdin, 'Dream input');
    for (const arg of expected) assert.ok(prepared.args.includes(arg), id);
    switch (id) {
      case 'claude':
        assert.equal(prepared.env.FORCE_PROMPT_CACHING_5M, '1');
        assert.ok(prepared.args.includes('--strict-mcp-config'));
        assert.equal(prepared.args[prepared.args.indexOf('--tools') + 1], '');
        break;
      case 'codex':
        assert.ok(prepared.args.includes('--ignore-user-config'));
        assert.ok(prepared.args.includes('shell_tool'));
        assert.ok(prepared.args.includes('unified_exec'));
        break;
      case 'agy': {
        const config = agyConfigurationPaths(prepared.env.HOME);
        const hooks = JSON.parse(fs.readFileSync(config.hooks, 'utf8'));
        assert.equal(hooks.dreaming.PreToolUse[0].matcher, '.*');
        assert.ok(prepared.args.includes('--sandbox'));
        assert.equal(prepared.env.AGY_CLI_DISABLE_AUTO_UPDATE, 'true');
        break;
      }
    }
  }
});
