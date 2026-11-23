import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import {
  CAPABILITIES, DEFAULT_RUNTIME, RUNTIME_DESCRIPTORS, SUPPORTED_RUNTIMES, runtimeDisplayName, runtimeInstallPolicy,
} from '../descriptors.js';

test('runtime descriptors declare all capabilities and match the implementation directories', () => {
  assert.deepEqual(CAPABILITIES, ['modelOverride', 'accountQuota', 'usage', 'hookHealth']);
  assert.ok(Object.isFrozen(RUNTIME_DESCRIPTORS));
  assert.ok(Object.isFrozen(SUPPORTED_RUNTIMES));
  assert.ok(SUPPORTED_RUNTIMES.includes(DEFAULT_RUNTIME));

  for (const descriptor of RUNTIME_DESCRIPTORS) {
    const { id, capabilities, displayName, installPolicy } = descriptor;
    assert.match(id, /^[a-z][a-z0-9-]{0,31}$/);
    assert.ok(Object.isFrozen(descriptor));
    assert.ok(Object.isFrozen(capabilities));
    assert.deepEqual(Object.keys(capabilities).sort(), [...CAPABILITIES].sort(), id);
    assert.ok(Object.values(capabilities).every(value => ['supported', 'unsupported'].includes(value)), id);
    assert.equal(typeof displayName, 'string');
    assert.ok(displayName.trim(), id);
    assert.equal(runtimeDisplayName(id), displayName);
    assert.ok(['always', 'whenUsed'].includes(installPolicy), id);
    assert.equal(runtimeInstallPolicy(id), installPolicy);
  }

  const directory = new URL('../', import.meta.url);
  const implementations = fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name !== 'shared'
      && fs.existsSync(new URL(`${entry.name}/index.js`, directory)))
    .map(entry => entry.name)
    .sort();
  assert.deepEqual([...SUPPORTED_RUNTIMES].sort(), implementations);
});
