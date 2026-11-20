import test from 'node:test';
import assert from 'node:assert/strict';
import { findRuntime, getRuntime, runtimesWith, SUPPORTED_RUNTIMES } from '../index.js';
import { RUNTIME_CONTRACT, UNSUPPORTED } from '../contract.js';

for (const id of SUPPORTED_RUNTIMES) {
  test(`${id} implements the runtime contract`, async () => {
    const runtime = await getRuntime(id);
    assert.equal(runtime.id, id);
    assert.ok(Object.isFrozen(runtime));
    assert.equal(runtime.launch.efforts !== UNSUPPORTED, runtimesWith('modelOverride', 'supported').includes(id),
      'modelOverride in the registry must agree with launch.efforts');
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
