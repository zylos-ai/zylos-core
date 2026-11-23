import assert from 'node:assert/strict';
import { test } from 'node:test';
import { supportsStopFailureVersion, detectStopFailureSupport } from '../runtime/claude/hooks.js';

test('stable Claude versions since StopFailure introduction enable health hooks; unknown and older versions use fallback', () => {
  for (const version of ['2.1.78', '2.1.78 (Claude Code)', '2.1.284', '2.1.300', '2.1.301', '2.1.301 (Claude Code)', '2.2.0', '3.0.0', '10.0.0 (Claude Code)']) assert.equal(supportsStopFailureVersion(version), true);
  for (const version of ['', 'garbage 2.1.78', '2.0.999', '2.1.77', '2.1.78-beta', '2.1.301-beta', '1.9.999']) assert.equal(supportsStopFailureVersion(version), false);
  assert.equal(detectStopFailureSupport({ execFileSyncImpl: () => { throw new Error('missing'); } }), false);
  assert.equal(detectStopFailureSupport({ execFileSyncImpl: (_bin, args, opts) => { assert.deepEqual(args, ['--version']); assert.equal(opts.timeout, 2000); return '2.1.301'; } }), true);
});
