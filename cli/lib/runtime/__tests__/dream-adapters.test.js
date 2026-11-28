import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { getRuntime } from '../index.js';
import { agyConfigurationPaths } from '../agy/hooks.js';
import { dreamSettingUpdate, dreamSettings } from '../../dream-settings.js';
import { evaluateConfigUpdate } from '../../config-store.js';

test('dream runtime adapters select their default model and medium effort with an isolated tool configuration', async t => {
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
    const { model: dreamModel, effort } = dreamSettings({}, runtime);
    options.model = dreamModel; options.effort = effort;
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

test('a saved dream model and effort reach only their own runtime adapter call, and unset restores the default', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dream-settings-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtimes = Object.fromEntries(await Promise.all(['claude', 'codex', 'agy'].map(async id => [id, await getRuntime(id)])));
  const call = (config, id) => {
    const cwd = fs.mkdtempSync(path.join(root, id + '-'));
    const { model, effort } = dreamSettings(config, runtimes[id]);
    const { args } = runtimes[id].dream.prepare({ cwd, root, env: {}, server: '/private/memory-mcp-server.js', serverEnv: {},
      instructions: 'System prompt', input: 'Dream input', tools: false, model, effort });
    const after = flag => args[args.indexOf(flag) + 1];
    return { claude: () => [after('--model'), after('--effort')], codex: () => [after('-m'), args.find(arg => arg.startsWith('model_reasoning_effort='))],
      agy: () => [after('--model')] }[id]();
  };
  const save = (config, id, kind, value) => evaluateConfigUpdate(config, dreamSettingUpdate(runtimes[id], kind, value)).config;
  const defaults = { claude: ['claude-sonnet-5-5', 'medium'], codex: ['gpt-6.1-terra', 'model_reasoning_effort="medium"'], agy: ['Gemini 4 Hydrogen (Medium)'] };
  for (const id of Object.keys(runtimes)) assert.deepEqual(call({}, id), defaults[id]);

  let config = save({}, 'claude', 'model', ' claude-opus-5-5 ');
  config = save(config, 'claude', 'effort', 'high');
  config = save(config, 'codex', 'effort', 'xhigh');
  config = save(config, 'agy', 'model', 'Gemini 4 Hydrogen (High)');
  assert.deepEqual(call(config, 'claude'), ['claude-opus-5-5', 'high']);
  assert.deepEqual(call(config, 'codex'), ['gpt-6.1-terra', 'model_reasoning_effort="xhigh"']);
  assert.deepEqual(call(config, 'agy'), ['Gemini 4 Hydrogen (High)']);
  // Another runtime's effort and an effort for a runtime without one are refused.
  assert.throws(() => dreamSettingUpdate(runtimes.claude, 'effort', 'xhigh'), { code: 'invalid_effort' });
  assert.throws(() => dreamSettingUpdate(runtimes.agy, 'effort', 'medium'), { code: 'invalid_effort' });
  assert.throws(() => dreamSettingUpdate(runtimes.codex, 'model', '  '), { code: 'invalid_model' });

  config = save(config, 'claude', 'model', null);
  assert.deepEqual(call(config, 'claude'), ['claude-sonnet-5-5', 'high']);
  config = save(config, 'claude', 'effort', null);
  assert.deepEqual(call(config, 'claude'), defaults.claude);
  assert.deepEqual(call(config, 'codex'), ['gpt-6.1-terra', 'model_reasoning_effort="xhigh"']);
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

test('Antigravity reads only its current memory conversation’s spilled step output', t => {
  const guard = fileURLToPath(new URL('../agy/dream-tool-guard.js', import.meta.url));
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'dream-output-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const brain = path.join(root, 'home', '.gemini', 'antigravity-cli', 'brain');
  const conversationId = 'f96e64e8-de70-450b-b56e-ba6242f99faf';
  const otherId = '7f1cb815-f1aa-43b4-bb58-93a1c07c814f';
  const artifactDirectoryPath = path.join(brain, conversationId);
  const steps = directory => path.join(directory, '.system_generated', 'steps');
  const stepOutput = (directory, step) => path.join(steps(directory), step, 'output.txt');
  const output = stepOutput(artifactDirectoryPath, '12');
  const otherOutput = stepOutput(path.join(brain, otherId), '12');
  const linkedOutput = stepOutput(artifactDirectoryPath, '13');
  for (const file of [output, otherOutput, linkedOutput]) fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const file of [output, otherOutput]) fs.writeFileSync(file, 'result');
  fs.symlinkSync(otherOutput, linkedOutput);
  fs.symlinkSync(path.dirname(otherOutput), path.dirname(stepOutput(artifactDirectoryPath, '14')));

  const decide = (file, { memory = true, artifact = artifactDirectoryPath } = {}) => {
    const toolCall = { name: 'read_file', args: { Path: file, StartLine: 1, EndLine: 2 } };
    const args = memory ? [guard, 'memory', path.join(root, 'descriptions'), brain] : [guard];
    return JSON.parse(execFileSync(process.execPath, args, {
      input: JSON.stringify({ conversationId, artifactDirectoryPath: artifact, toolCall }),
      encoding: 'utf8', timeout: 2000,
    })).decision;
  };

  assert.equal(decide(output), 'allow');
  assert.equal(decide(output, { memory: false }), 'deny');
  assert.equal(decide(otherOutput, { artifact: path.join(brain, otherId) }), 'deny');
  assert.equal(decide(steps(artifactDirectoryPath)), 'deny');
  assert.equal(decide(`${path.dirname(output)}/../12/output.txt`), 'deny');
  assert.equal(decide(linkedOutput), 'deny');
  assert.equal(decide(stepOutput(artifactDirectoryPath, '14')), 'deny');
});
