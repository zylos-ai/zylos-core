import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDreamModel } from '../dream-model.js';
import { getRuntime } from '../../../../cli/lib/runtime/index.js';
import { dreamSettingUpdate } from '../../../../cli/lib/dream-settings.js';
import { evaluateConfigUpdate } from '../../../../cli/lib/config-store.js';

test('a saved dream model and effort reach only their own runtime launch, and unset restores the default', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dream-model-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.zylos'));
  fs.writeFileSync(path.join(root, '.env'), 'ZYLOS_CLEAN_ENV=false\n');
  // A runtime stand-in that records its arguments and answers in the shape each adapter reads back.
  const log = path.join(root, 'argv.jsonl'), program = path.join(root, 'runtime-cli');
  fs.writeFileSync(program, `#!${process.execPath}
const fs = require('node:fs'), args = process.argv.slice(2);
process.stdin.resume();
process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
  const answer = args.indexOf('--output-last-message');
  if (answer >= 0) fs.writeFileSync(args[answer + 1], 'ok');
  process.stdout.write(args.includes('stream-json') ? JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'ok' } }) : 'ok');
});
`, { mode: 0o755 });
  const saved = Object.fromEntries(['CLAUDE_BIN', 'CODEX_BIN', 'AGY_BIN'].map(name => [name, process.env[name]]));
  t.after(() => { for (const [name, value] of Object.entries(saved)) value === undefined ? delete process.env[name] : process.env[name] = value; });
  for (const name of Object.keys(saved)) process.env[name] = program;

  const runtimes = Object.fromEntries(await Promise.all(['claude', 'codex', 'agy'].map(async id => [id, await getRuntime(id)])));
  // The model and effort arguments of one real dream call on the configured runtime.
  async function launch(config) {
    fs.writeFileSync(path.join(root, '.zylos/config.json'), JSON.stringify(config));
    fs.rmSync(log, { force: true });
    const model = await createDreamModel(root, JSON.parse(fs.readFileSync(path.join(root, '.zylos/config.json'), 'utf8')));
    assert.equal(await model({ stage: 'stage1', instructions: 'System prompt', input: 'Dream input' }), 'ok');
    const [args] = fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const after = flag => args[args.indexOf(flag) + 1];
    return { claude: () => [after('--model'), after('--effort')],
      codex: () => [after('-m'), args.find(arg => arg.startsWith('model_reasoning_effort='))],
      agy: () => [after('--model')] }[config.runtime]();
  }
  const save = (config, id, kind, value) => evaluateConfigUpdate(config, dreamSettingUpdate(runtimes[id], kind, value)).config;
  const defaults = { claude: ['claude-sonnet-5-5', 'medium'], codex: ['gpt-6.1-terra', 'model_reasoning_effort="medium"'], agy: ['Gemini 4 Hydrogen (Medium)'] };
  for (const id of Object.keys(runtimes)) assert.deepEqual(await launch({ runtime: id }), defaults[id]);

  let config = save({ runtime: 'claude' }, 'claude', 'model', ' claude-opus-5-5 ');
  config = save(config, 'claude', 'effort', 'high');
  config = save(config, 'codex', 'effort', 'xhigh');
  config = save(config, 'agy', 'model', 'Gemini 4 Hydrogen (High)');
  assert.deepEqual(await launch(config), ['claude-opus-5-5', 'high']);
  assert.deepEqual(await launch({ ...config, runtime: 'codex' }), ['gpt-6.1-terra', 'model_reasoning_effort="xhigh"']);
  assert.deepEqual(await launch({ ...config, runtime: 'agy' }), ['Gemini 4 Hydrogen (High)']);
  // An effort another runtime accepts, and any effort on a runtime without one, are refused.
  assert.throws(() => dreamSettingUpdate(runtimes.claude, 'effort', 'xhigh'), { code: 'invalid_effort' });
  assert.throws(() => dreamSettingUpdate(runtimes.agy, 'effort', 'medium'), { code: 'invalid_effort' });

  config = save(config, 'claude', 'model', null);
  assert.deepEqual(await launch(config), ['claude-sonnet-5-5', 'high']);
  config = save(config, 'claude', 'effort', null);
  assert.deepEqual(await launch(config), defaults.claude);
  assert.deepEqual(await launch({ ...config, runtime: 'codex' }), ['gpt-6.1-terra', 'model_reasoning_effort="xhigh"']);
});
