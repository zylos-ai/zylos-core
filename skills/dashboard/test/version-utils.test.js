import assert from 'node:assert/strict';
import test from 'node:test';

import { compareVersions, isNewerVersion, normalizeVersion } from '../src/lib/version-utils.js';

test('normalizeVersion extracts CLI-style version strings', () => {
  assert.equal(normalizeVersion('2.1.150'), '2.1.150');
  assert.equal(normalizeVersion('v0.5.2'), '0.5.2');
  assert.equal(normalizeVersion('codex-cli 0.130.0'), '0.130.0');
});

test('isNewerVersion only accepts strictly newer versions', () => {
  assert.equal(isNewerVersion('2.1.151', '2.1.150'), true);
  assert.equal(isNewerVersion('2.1.148', '2.1.150'), false);
  assert.equal(isNewerVersion('2.1.150', '2.1.150'), false);
  assert.equal(compareVersions('0.5.10', '0.5.2'), 1);
});
