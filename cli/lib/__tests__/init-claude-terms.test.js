import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getRuntime } from '../runtime/index.js';

const originalHome = process.env.HOME;
const tmpRoots = [];

function useFreshHome({ create }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-init-terms-test-'));
  tmpRoots.push(root);
  const home = path.join(root, 'home', 'agent');
  if (create) fs.mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  return home;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

afterEach(() => {
  process.env.HOME = originalHome;
  while (tmpRoots.length) fs.rmSync(tmpRoots.pop(), { recursive: true, force: true });
});

describe('Claude terms pre-acceptance', () => {
  test('creates a missing home directory before writing ~/.claude.json', async () => {
    const { launch: { preAccept } } = await getRuntime('claude');
    const home = useFreshHome({ create: false });

    assert.equal(preAccept(), true);

    assert.equal(readJson(path.join(home, '.claude.json')).hasCompletedOnboarding, true);
    assert.equal(readJson(path.join(home, '.claude', 'settings.json')).skipDangerousModePermissionPrompt, true);
  });

  test('preserves existing settings and reports no change once accepted', async () => {
    const { launch: { preAccept } } = await getRuntime('claude');
    const home = useFreshHome({ create: true });
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ theme: 'dark' }));

    assert.equal(preAccept(), true);
    assert.equal(preAccept(), false);

    assert.deepEqual(readJson(path.join(home, '.claude.json')), { theme: 'dark', hasCompletedOnboarding: true });
  });
});
