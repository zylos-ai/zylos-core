import assert from 'node:assert/strict';
import test from 'node:test';

import { VersionChecker } from '../src/lib/version-checker.js';
import { getRuntime, SUPPORTED_RUNTIMES } from '../../../cli/lib/runtime/index.js';

const sources = Object.fromEntries(await Promise.all(SUPPORTED_RUNTIMES.map(async id => [id, (await getRuntime(id)).install.latestVersion])));

test('VersionChecker checks only declared GitHub and npm sources', async () => {
  const requests = [];
  const checker = new VersionChecker({
    fetchZylosLatest: async () => null,
    sources,
    fetchGithub: async repo => { requests.push(['github', repo]); return '2.1.80'; },
    fetchNpm: async pkg => {
      requests.push(['npm', pkg]);
      return '0.137.0';
    }
  });

  await checker.check();

  assert.deepEqual(checker.getLatest(), { zylos: null, claude: '2.1.80', codex: '0.137.0' });
  assert.deepEqual(checker.unsupportedIds(), ['agy']);
  assert.deepEqual(requests, [['github', 'anthropics/claude-code'], ['npm', '@openai/codex']]);
});

test('VersionChecker keeps Codex latest unavailable when npm registry check fails initially', async () => {
  const checker = new VersionChecker({
    fetchZylosLatest: async () => null,
    sources,
    fetchGithub: async () => null,
    fetchNpm: async () => {
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
    sources,
    fetchGithub: async () => null,
    fetchNpm: async () => {
      calls += 1;
      if (calls === 1) return '0.137.0';
      throw new Error('registry unavailable');
    }
  });

  await checker.check();
  await checker.check();

  assert.equal(checker.getLatest().codex, '0.137.0');
});
