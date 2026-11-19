import test from 'node:test';
import assert from 'node:assert/strict';
import { findRuntime, getRuntime, SUPPORTED_RUNTIMES } from '../index.js';
import { RUNTIME_CONTRACT, UNSUPPORTED } from '../contract.js';

for (const id of SUPPORTED_RUNTIMES) {
  test(`${id} implements the runtime contract`, async () => {
    const runtime = await getRuntime(id);
    assert.equal(runtime.id, id);
    assert.ok(Object.isFrozen(runtime));
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
