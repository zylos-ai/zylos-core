import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { getRuntime } from '../index.js';
import { buildKickPrompt } from '../kick-prompt.js';

async function recordedHooks(t, id) {
  const directory = new URL(`./samples/${id}/hooks/`, import.meta.url);
  let source;
  try {
    source = await fs.readFile(new URL('manifest.json', directory), 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    t.skip(`Awaiting native hook recordings for ${id}`);
    return null;
  }
  const { program, version, recordedAt, how, files } = JSON.parse(source);
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
  test(`${id} native hook records retain session, source and tool identity`, async t => {
    const recordings = await recordedHooks(t, id);
    if (!recordings) return;
    const { hooks, payload } = recordings;
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

    const tool = normalized['pre-tool-use'];
    if (id === 'claude') {
      assert.equal(tool.tool_name, 'Bash');
      assert.deepEqual(hooks.toolInput(tool.tool_name, tool.tool_input), pick(tool.tool_input, ['command', 'description']));
    } else {
      assert.equal(tool.tool_name, 'functions.exec_command');
      assert.equal(hooks.toolInput(tool.tool_name, tool.tool_input), undefined);
    }
  });
}

function pick(input, keys) {
  return Object.fromEntries(keys.filter(key => Object.hasOwn(input, key)).map(key => [key, input[key]]));
}

test('Antigravity native hook records normalize lifecycle, failures and tool input', async t => {
  const recordings = await recordedHooks(t, 'agy');
  if (!recordings) return;
  const { hooks, payload } = recordings;
  const normalized = {};
  for (const [name, event, standard] of [
    ['session-start-kick', 'SessionStart', 'SessionStart'],
    ['pre-invocation-first', 'PreInvocation', 'UserPromptSubmit'],
    ['pre-invocation-later', 'PreInvocation', null],
    ['stop-idle', 'Stop', 'Stop'],
    ['stop-auth-error', 'Stop', 'StopFailure'],
    ['stop-custom-hook', 'Stop', 'Stop'],
    ['pre-tool-use', 'PreToolUse', 'PreToolUse'],
    ['post-tool-use', 'PostToolUse', 'PostToolUse'],
    ['post-tool-use-error', 'PostToolUse', 'PostToolUseFailure'],
  ]) {
    const native = await payload(name);
    const record = hooks.normalize(native, event);
    if (standard === null) {
      assert.equal(native.invocationNum, 1);
      assert.equal(record, null);
      continue;
    }
    assert.equal(record.hook_event_name, standard, name);
    assert.equal(typeof record.session_id, 'string', name);
    assert.ok(record.session_id, name);
    assert.equal(record.session_id, native.conversationId, name);
    if (event.endsWith('ToolUse')) {
      assert.equal(record.tool_use_id, native.toolCall.id, name);
      assert.equal(record.tool_name, 'run_command', name);
    }
    normalized[name] = record;
  }
  const start = normalized['session-start-kick'].lastUserInput.trim();
  assert.ok(start === buildKickPrompt() || start.startsWith(buildKickPrompt() + '\n'));
  assert.equal(normalized['pre-invocation-first'].invocationNum, 0);
  assert.equal(normalized['stop-idle'].fullyIdle, true);
  assert.equal(normalized['stop-auth-error'].error, 'authentication_failed');
  assert.equal(normalized['stop-custom-hook'].terminationReason, 'TERMINAL_CUSTOM_HOOK');
  assert.equal(normalized['post-tool-use-error'].error, 'tool_error');
  const tool = normalized['pre-tool-use'];
  assert.deepEqual(hooks.toolInput(tool.tool_name, tool.tool_input), pick(tool.tool_input, ['CommandLine', 'Cwd']));
});
