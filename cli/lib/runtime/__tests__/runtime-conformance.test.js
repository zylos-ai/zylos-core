import test from 'node:test';
import assert from 'node:assert/strict';
import { findRuntime, getRuntime, runtimesWith, SUPPORTED_RUNTIMES } from '../index.js';
import { RUNTIME_CONTRACT, UNSUPPORTED } from '../contract.js';

for (const id of SUPPORTED_RUNTIMES) {
  test(`${id} implements the runtime contract`, async () => {
    const runtime = await getRuntime(id);
    assert.equal(runtime.id, id);
    assert.ok(Object.isFrozen(runtime));
    assert.equal(typeof runtime.identity.launcherWrapsNative, 'boolean');
    const { hooks } = runtime;
    assert.equal(typeof hooks.sync, 'function');
    assert.equal(typeof hooks.ready, 'function');
    assert.equal(typeof hooks.normalize, 'function');
    assert.equal(typeof hooks.output, 'function');
    if (hooks.mainSession !== UNSUPPORTED) {
      assert.equal(typeof hooks.mainSession.accept, 'function');
      assert.equal(typeof hooks.mainSession.update, 'function');
    }
    if (runtime.switch.clearFiresSessionStart === false) {
      assert.notEqual(hooks.readSessionSource, UNSUPPORTED);
    }
    assert.ok(['always', 'opted-in'].includes(hooks.syncPolicy));
    assert.equal(hooks.optedIn !== UNSUPPORTED, hooks.syncPolicy === 'opted-in');
    const publishesConfig = runtime.install.postUpgradeSync !== UNSUPPORTED;
    assert.equal(hooks.writeConfig !== UNSUPPORTED, publishesConfig);
    assert.equal(hooks.installHooks !== UNSUPPORTED, publishesConfig);
    for (const member of ['optedIn', 'trust', 'features', 'stage', 'writeConfig', 'installHooks', 'toolInput', 'readSessionSource', 'toolGuard']) {
      if (hooks[member] !== UNSUPPORTED) assert.equal(typeof hooks[member], 'function', `hooks.${member}`);
    }
    assert.equal(runtime.launch.efforts !== UNSUPPORTED, runtimesWith('modelOverride', 'supported').includes(id),
      'modelOverride in the registry must agree with launch.efforts');
    const { modelConfig } = runtime.launch;
    assert.equal(modelConfig !== UNSUPPORTED, runtimesWith('modelOverride').includes(id),
      'modelOverride in the registry must agree with launch.modelConfig');
    if (modelConfig !== UNSUPPORTED) {
      assert.ok(Object.isFrozen(modelConfig));
      assert.equal(typeof modelConfig.read, 'function');
      assert.equal(typeof modelConfig.write, 'function');
    }
    const { screen, hookHealth, toolWatchdog, noticeRules } = runtime.health;
    assert.ok(screen !== UNSUPPORTED || hookHealth !== UNSUPPORTED, 'health must have an evidence source');
    assert.equal(hookHealth !== UNSUPPORTED, runtimesWith('hookHealth').includes(id),
      'hookHealth in the registry must agree with health.hookHealth');
    if (screen !== UNSUPPORTED) assert.equal(typeof screen.match, 'function');
    if (hookHealth === UNSUPPORTED) {
      assert.equal(noticeRules, UNSUPPORTED);
    } else {
      assert.equal(typeof hookHealth.hookFailureHasPromptId, 'boolean');
    }
    if (toolWatchdog !== UNSUPPORTED) {
      assert.ok(toolWatchdog.tools.every(tool => typeof tool === 'string'));
      assert.equal(typeof toolWatchdog.interruptKey, 'string');
    }
    if (noticeRules !== UNSUPPORTED) assert.ok(Array.isArray(noticeRules));
    const { usage } = runtime;
    const accountQuota = usage === UNSUPPORTED ? UNSUPPORTED : usage.accountQuota;
    assert.equal(accountQuota !== UNSUPPORTED, runtimesWith('accountQuota', 'supported').includes(id),
      'accountQuota in the registry must agree with usage.accountQuota');
    if (usage === UNSUPPORTED) {
      assert.ok(runtimesWith('accountQuota', 'unsupported').includes(id));
      assert.ok(runtimesWith('usage', 'unsupported').includes(id));
    } else {
      const { legacyAccountRecord, healthQuota } = usage;
      if (accountQuota === UNSUPPORTED) {
        assert.equal(legacyAccountRecord, UNSUPPORTED);
        assert.equal(healthQuota, UNSUPPORTED);
      } else {
        assert.ok(Object.isFrozen(accountQuota));
        for (const [member, type] of Object.entries({
          readLiveSample: 'function', readRecordedSample: 'function',
          stateFile: 'string', alertStateFile: 'string', sampleOnStart: 'boolean',
        })) {
          assert.ok(Object.hasOwn(accountQuota, member), `missing member usage.accountQuota.${member}`);
          assert.equal(typeof accountQuota[member], type, `usage.accountQuota.${member}`);
        }
      }
      if (legacyAccountRecord !== UNSUPPORTED) assert.equal(typeof legacyAccountRecord, 'function');
      if (healthQuota !== UNSUPPORTED) {
        assert.equal(typeof healthQuota, 'function');
        assert.ok(runtimesWith('hookHealth', 'supported').includes(id));
        assert.ok(runtimesWith('accountQuota', 'supported').includes(id));
      }
    }
    const { input, switch: sessionSwitch } = runtime;
    assert.equal(typeof input.bracketedPaste, 'boolean');
    assert.equal(typeof input.inputState, 'function');
    assert.equal(typeof input.requireEmptyBeforePaste, 'boolean');
    assert.ok(Number.isInteger(input.pasteCharThreshold) && input.pasteCharThreshold > 0,
      'input.pasteCharThreshold must be a positive integer');
    if (input.dismissOverlay !== UNSUPPORTED) assert.equal(typeof input.dismissOverlay, 'function');
    assert.ok(['/clear', '/exit'].includes(sessionSwitch.command));
    assert.equal(typeof sessionSwitch.exitsProcess, 'boolean');
    if (sessionSwitch.clearFiresSessionStart !== UNSUPPORTED || !sessionSwitch.exitsProcess) {
      assert.equal(typeof sessionSwitch.clearFiresSessionStart, 'boolean');
    }
    if (sessionSwitch.clearSourceMarker !== UNSUPPORTED || sessionSwitch.clearFiresSessionStart === false) {
      assert.equal(typeof sessionSwitch.clearSourceMarker, 'string');
      assert.ok(sessionSwitch.clearSourceMarker);
    }
    const { busy } = runtime;
    assert.ok(['hooks', 'statusline'].includes(busy.source));
    assert.equal(typeof busy.queuedPromptsInTurn, 'boolean');
    if (busy.source === 'statusline') {
      assert.equal(typeof busy.statuslineActivity, 'function');
      assert.equal(busy.transcript, UNSUPPORTED);
      assert.equal(busy.queuedPromptsInTurn, false);
    }
    if (busy.queuedPromptsInTurn) assert.notEqual(busy.transcript, UNSUPPORTED);
    if (busy.transcript !== UNSUPPORTED) {
      assert.ok(Object.isFrozen(busy.transcript));
      assert.equal(typeof busy.transcript.createParser, 'function');
      assert.ok(['ignore', 'throw'].includes(busy.transcript.readFailure));
    }
    if (busy.statuslineActivity !== UNSUPPORTED) assert.equal(typeof busy.statuslineActivity, 'function');
    for (const [name, { required, members }] of Object.entries(RUNTIME_CONTRACT)) {
      assert.ok(Object.hasOwn(runtime, name), `missing capability ${name}`);
      const capability = runtime[name];
      assert.ok(capability != null, `use UNSUPPORTED for unsupported capability ${name}`);
      if (capability === UNSUPPORTED) {
        assert.equal(required, false, `required capability ${name} is unsupported`);
        continue;
      }
      assert.ok(Object.isFrozen(capability), `capability ${name} must be frozen`);
      for (const [member, requirement] of Object.entries(members)) {
        const label = `${name}.${member}`;
        assert.ok(Object.hasOwn(capability, member), `missing member ${label}`);
        assert.ok(capability[member] != null, `use UNSUPPORTED for unsupported member ${label}`);
        if (requirement === 'required') {
          assert.notEqual(capability[member], UNSUPPORTED, `required member ${label} is unsupported`);
        }
      }
    }
  });
}

test('runtime factory refuses unsupported ids and shares loaded implementations', async () => {
  for (const id of ['constructor', 'toString', '__proto__', 'foo', '', undefined]) {
    await assert.rejects(getRuntime(id), { code: 'RUNTIME_UNSUPPORTED', message: `Unsupported runtime: ${id}` });
    assert.equal(await findRuntime(id), null);
  }
  const [first, second] = await Promise.all([getRuntime('claude'), getRuntime('claude')]);
  assert.equal(first, second);
  assert.equal(await findRuntime('claude'), first);
});

test('exactly one runtime stages settings during upgrade', async () => {
  const runtimes = await Promise.all(SUPPORTED_RUNTIMES.map(getRuntime));
  assert.equal(runtimes.filter(runtime => runtime.hooks.stage !== UNSUPPORTED).length, 1);
});
