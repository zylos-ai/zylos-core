import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { getDataDir, loadConfig } from '../src/lib/config.js';

test('Dashboard config reload preserves the local avatar file reference', (t) => {
  const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-avatar-config-'));
  t.after(() => fs.rmSync(zylosDir, { recursive: true, force: true }));
  const dataDir = getDataDir(zylosDir);
  const avatar = `avatar-${'a'.repeat(64)}.png`;
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ agent: { name: 'worker', avatar } }));

  assert.equal(loadConfig({ zylosDir }).agent.avatar, avatar);
});
