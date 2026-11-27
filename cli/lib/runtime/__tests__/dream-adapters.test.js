import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
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
    const input = id === 'agy' ? 'Dream input\n'.repeat(14_000) + 'End of input' : 'Dream input';
    const options = { cwd, root, env: {}, server: '/private/memory-mcp-server.js',
      serverEnv: { ZYLOS_MEMORY_DREAM_ROOT: root }, instructions: 'System prompt', input, tools: true,
      schema: { type: 'object' } };
    const prepared = runtime.dream.prepare(options);
    if (id !== 'agy') assert.equal(prepared.stdin, input);
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
        assert.ok(prepared.args.includes('mcp_servers.dream.default_tools_approval_mode="approve"'));
        break;
      case 'agy': {
        const config = agyConfigurationPaths(prepared.env.HOME);
        const hooks = JSON.parse(fs.readFileSync(config.hooks, 'utf8'));
        assert.equal(hooks.dreaming.PreToolUse[0].matcher, '.*');
        assert.ok(prepared.args.includes('--sandbox'));
        assert.equal(prepared.args[prepared.args.indexOf('--output-format') + 1], 'stream-json');
        assert.deepEqual(prepared.args.slice(-4), ['--input-format', 'stream-json', '-p', '']);
        assert.equal(prepared.stdin.split('\n').length, 2);
        assert.deepEqual(JSON.parse(prepared.stdin), { event: 'user', message: { role: 'user', content: input } });
        const settings = call => JSON.parse(call.args[call.args.indexOf('--settings') + 1]);
        assert.deepEqual(settings(prepared).permissions, { allow: ['mcp(dream/*)'] });
        assert.equal(settings(prepared).userDataCollectionForceDisabled, undefined);
        const extraction = runtime.dream.prepare({ ...options, tools: false });
        assert.equal(settings(extraction).permissions, undefined);
        assert.deepEqual(JSON.parse(fs.readFileSync(config.mcp, 'utf8')), { mcpServers: {} });
        assert.ok(prepared.args.includes('--json-schema'));
        const stdout = name => fs.readFileSync(new URL(`./fixtures/agy-dream-stream-${name}.ndjson`, import.meta.url), 'utf8');
        assert.deepEqual(JSON.parse(runtime.dream.decodeOutput(stdout('success'))), {
          codeword: 'PELICAN-77', steps: ['<model text redacted>'],
        });
        assert.throws(() => runtime.dream.decodeOutput(stdout('error')), /successful dream model result/);
        assert.equal(prepared.env.AGY_CLI_DISABLE_AUTO_UPDATE, 'true');
        break;
      }
    }
  }
});

test('Antigravity restricts memory tools and their descriptions to memory mode', () => {
  const guard = fileURLToPath(new URL('../agy/dream-tool-guard.js', import.meta.url));
  const useMemory = (server, tool) => ({ name: 'call_mcp_tool', args: { ServerName: server, ToolName: tool } });
  const descriptions = '/private/home/.gemini/antigravity-cli/mcp/dream';
  const decide = (toolCall, memory) => JSON.parse(execFileSync(process.execPath, [guard, ...(memory ? ['memory', descriptions] : [])], {
    input: JSON.stringify({ toolCall }), encoding: 'utf8', timeout: 2000,
  })).decision;

  assert.equal(decide({ name: 'finish' }, false), 'allow');
  assert.equal(decide({ name: 'finish' }, true), 'allow');
  assert.equal(decide(useMemory('dream', 'edit_memory'), true), 'allow');
  assert.equal(decide(useMemory('dream', 'edit_memory'), false), 'deny');
  assert.equal(decide(useMemory('other', 'edit_memory'), true), 'deny');
  assert.equal(decide(useMemory('dream', 'other'), true), 'deny');
  const readFile = file => ({ name: 'read_file', args: { Path: file } });
  assert.equal(decide(readFile(`${descriptions}/edit_memory.json`), true), 'allow');
  assert.equal(decide(readFile(`${descriptions}/edit_memory.json`), false), 'deny');
  assert.equal(decide(readFile(`${descriptions}/other.json`), true), 'deny');
  assert.equal(decide(readFile(`${descriptions}/../edit_memory.json`), true), 'deny');
  assert.equal(decide({ name: 'write_file' }, true), 'deny');
  assert.equal(decide({ name: 'run_command' }, true), 'deny');
});
