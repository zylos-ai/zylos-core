import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRuntimeOverridesReader, handleRuntimeOptions, runtimeDefaults, runtimeVersionRecord } from '../src/lib/runtime-api.js';
import { sessionThreshold, readThresholdPolicy } from '../src/lib/session-threshold.js';

function fixture(t) {
  const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-runtime-api-'));
  t.after(() => fs.rmSync(zylosDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(zylosDir, '.claude'));
  fs.writeFileSync(path.join(zylosDir, '.claude/settings.json'), JSON.stringify({ model: 'opus', effortLevel: 'high' }));
  return zylosDir;
}

for (const query of ['', 'q=telegram:agy']) test(`runtime overrides preserve Antigravity rows for ${query || 'unfiltered lists'}`, async t => {
  const zylosDir = fixture(t);
  const read = createRuntimeOverridesReader({ zylosDir,
    env: { ZYLOS_SESSION_GROUP: 'other-group' },
    displayNames: { listAll: async () => new Map([['telegram:agy', { displayName: 'Gemini' }]]), search: async () => [] },
    run: async (command, args, options) => {
      assert.equal(command, 'zylos');
      assert.deepEqual(args.slice(0, 2), ['group', 'overrides']);
      assert.equal(options.env.ZYLOS_DIR, zylosDir);
      assert.equal(Object.hasOwn(options.env, 'ZYLOS_SESSION_GROUP'), false);
      return { stdout: JSON.stringify({ ok: true, data: { runtimeTotal: 3, runtime: [
        { sessionGroup: 'telegram:claude', runtime: 'claude' },
        { sessionGroup: 'telegram:codex', runtime: 'codex' },
        { sessionGroup: 'telegram:agy', runtime: 'agy' }], nextAfter: 'opaque' } }) };
    } });
  const page = await read(new URLSearchParams(query));
  assert.equal(page.runtime.length, 3);
  assert.equal(page.runtime[2].runtime, 'agy');
  assert.equal(page.runtime[2].name.displayName, 'Gemini');
  assert.equal(page.nextAfter, 'opaque');
});

for (const [activeRuntime, query] of [['agy', ''], ['claude', '?runtime=agy']]) {
  test(`runtime options return Antigravity defaults for active ${activeRuntime} and query ${query || '(none)'}`, t => {
    const zylosDir = fixture(t);
    let status, body;
    handleRuntimeOptions(new URL(`http://localhost/api/instance/runtime-options${query}`), {
      writeHead: code => { status = code; }, end: value => { body = JSON.parse(value); },
    }, { activeRuntime, zylosConfig: { zylosDir, runtime: activeRuntime }, zylosVersion: '1.0.0',
      installedVersions: { claude: '2.0.0', agy: '1.5.10' } });
    assert.equal(status, 200);
    assert.equal(body.runtime, 'agy');
    assert.equal(body.runtime_cli, 'agy');
    assert.equal(body.cc_version, '1.5.10');
    assert.equal(body.current_model, null, 'no configured Antigravity model override');
    assert.equal(body.current_effort, null);
    assert.equal(body.models.length, 0, 'model overrides are unsupported');
    assert.equal(Object.keys(body.efforts_by_model).length, 0);
    assert.equal(body.new_session_threshold, 40);
  });
}

test('runtime options reject unsupported runtime and preserve unknown Antigravity versions', t => {
  const zylosDir = fixture(t);
  for (const [runtime, expected] of [['invalid', 400], ['agy', 200]]) {
    let status, body;
    handleRuntimeOptions(new URL(`http://localhost/api/instance/runtime-options?runtime=${runtime}`), {
      writeHead: code => { status = code; }, end: value => { body = JSON.parse(value); },
    }, { activeRuntime: 'agy', zylosConfig: { zylosDir }, installedVersions: { claude: '2.0.0' } });
    assert.equal(status, expected);
    if (expected === 400) assert.equal(body.error.code, 'INVALID_RUNTIME');
    else assert.equal(body.cc_version, null);
  }
});

test('instance defaults and versions include Antigravity without borrowing Claude metadata', t => {
  const defaults = runtimeDefaults({ zylosDir: fixture(t), runtime: 'agy' });
  assert.equal(defaults.claude.model, 'opus');
  assert.equal(defaults.agy.model, null);
  assert.equal(defaults.agy.effort, null);
  assert.equal(defaults.agy.threshold, 40);
  const versions = runtimeVersionRecord('agy', { installed: { claude: '2.0.0', agy: '1.5.10' }, latest: { cc: '3.0.0' } });
  assert.equal(versions.installed, '1.5.10');
  assert.equal(versions.latest, null);
  assert.equal(versions.update, null);
});

test('Antigravity session thresholds follow validated model objects and the one-million-token limit', t => {
  const policy = readThresholdPolicy(fixture(t));
  const facts = { runtime: 'agy', usage: { model: { id: 'gemini', effort: 'high' } } };
  assert.equal(sessionThreshold(policy, facts), 40);
  policy.config.model_rotation_thresholds = { agy: { gemini: 25 } };
  assert.equal(sessionThreshold(policy, facts), 25);
  assert.equal(sessionThreshold(policy, { runtime: 'agy', usage: null }), null);
});
