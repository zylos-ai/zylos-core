import assert from 'node:assert/strict';
import test from 'node:test';

import { VersionChecker } from '../src/lib/version-checker.js';

test('VersionChecker stores latest Codex version from npm registry source', async () => {
  const checker = new VersionChecker({
    fetchZylosLatest: async () => null,
    fetchCcLatest: async () => null,
    fetchCodexLatest: async (pkg) => {
      assert.equal(pkg, '@openai/codex');
      return '0.137.0';
    }
  });

  await checker.check();

  assert.equal(checker.getLatest().codex, '0.137.0');
});

test('VersionChecker keeps Codex latest unavailable when npm registry check fails initially', async () => {
  const checker = new VersionChecker({
    fetchZylosLatest: async () => null,
    fetchCcLatest: async () => null,
    fetchCodexLatest: async () => {
      throw new Error('registry unavailable');
    }
  });

  await checker.check();

  assert.equal(checker.getLatest().codex, null);
});

test('VersionChecker preserves last-known Codex latest after later registry failure', async () => {
  let calls = 0;
  const checker = new VersionChecker({
    fetchZylosLatest: async () => null,
    fetchCcLatest: async () => null,
    fetchCodexLatest: async () => {
      calls += 1;
      if (calls === 1) return '0.137.0';
      throw new Error('registry unavailable');
    }
  });

  await checker.check();
  await checker.check();

  assert.equal(checker.getLatest().codex, '0.137.0');
});
