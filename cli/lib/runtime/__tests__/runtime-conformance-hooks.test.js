import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { getRuntime } from '../index.js';

async function recordedHooks(id) {
  const directory = new URL(`./samples/${id}/hooks/`, import.meta.url);
  const { program, version, recordedAt, how, files } = JSON.parse(
    await fs.readFile(new URL('manifest.json', directory), 'utf8')
  );
  for (const value of [program, version, recordedAt, how]) {
    assert.equal(typeof value, 'string');
    assert.ok(value);
  }
  return {
    hooks: (await getRuntime(id)).hooks,
    async payload(name) {
      const file = `${name}.json`;
      assert.ok(Object.hasOwn(files, file), `Missing recording: ${id}/${file}`);
      return JSON.parse(await fs.readFile(new URL(file, directory), 'utf8'));
    },
  };
}

for (const [id, events] of [
  ['claude', { 'stop-failure': 'StopFailure', 'subagent-pre-tool-use': 'PreToolUse' }],
  ['codex', {}],
]) {
  test(`${id} native hook records retain session, source and tool identity`, async () => {
    const { hooks, payload } = await recordedHooks(id);
    const normalized = {};
    for (const [name, event] of Object.entries({
      'session-start-startup': 'SessionStart',
      'session-start-clear': 'SessionStart',
      'user-prompt-submit': 'UserPromptSubmit',
      'pre-tool-use': 'PreToolUse',
      'post-tool-use': 'PostToolUse',
      stop: 'Stop',
      ...events,
    })) {
      const native = await payload(name);
      const record = hooks.normalize(native, event);
      assert.equal(record.hook_event_name, event, name);
      assert.equal(typeof record.session_id, 'string', name);
      assert.ok(record.session_id, name);
      assert.equal(record.session_id, native.session_id, name);
      if (name.startsWith('session-start-')) {
        const source = name.slice('session-start-'.length);
        assert.equal(native.source, source);
        assert.equal(record.source, native.source);
        assert.equal(hooks.output({ event, result: { kind: 'session', text: source, source } }), source);
      } else if (event.endsWith('ToolUse')) {
        assert.equal(typeof record.tool_use_id, 'string', name);
        assert.ok(record.tool_use_id, name);
        assert.equal(record.tool_use_id, native.tool_use_id, name);
        assert.equal(hooks.output({ event, result: { kind: 'rules', text: 'rules' } }), '');
      }
      normalized[name] = record;
    }
    assert.equal(normalized['pre-tool-use'].tool_use_id, normalized['post-tool-use'].tool_use_id);
    if (id === 'claude') {
      assert.equal(typeof normalized['subagent-pre-tool-use'].agent_id, 'string');
      assert.ok(normalized['subagent-pre-tool-use'].agent_id);
    }

    for (const tool of [normalized['pre-tool-use'], normalized['post-tool-use']]) {
      assert.equal(tool.tool_name, 'Bash');
      assert.equal(typeof tool.tool_input.command, 'string');
      const expected = id === 'claude'
        ? pick(tool.tool_input, ['command', 'description'])
        : { command: tool.tool_input.command };
      assert.deepEqual(hooks.toolInput(tool.tool_name, tool.tool_input), expected);
    }
  });
}

function pick(input, keys) {
  return Object.fromEntries(keys.filter(key => Object.hasOwn(input, key)).map(key => [key, input[key]]));
}
