import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadConfig } from '../src/lib/config.js';

test('remote conversation access defaults closed and only accepts persisted true', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-default-'));
  const previous = process.env.ZYLOS_DIR;
  t.after(() => { process.env.ZYLOS_DIR = previous; fs.rmSync(root, { recursive: true, force: true }); });
  process.env.ZYLOS_DIR = root;
  assert.equal(loadConfig().chat.allowRemote, false);
  const configPath = path.join(root, 'components/dashboard/config.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  for (const value of [true, false, 'true', 1, null]) {
    fs.writeFileSync(configPath, JSON.stringify({ chat: { allowRemote: value } }));
    assert.equal(loadConfig().chat.allowRemote, value === true);
  }
});

// Integration: real config mutation and auth/proxy over private loopback, own
// temporary config/lock DB. Run for chat setting or persistence changes; skip
// CSS-only edits. No live config/PM2/tmux; resources removed in teardown.

// Integration: actual filesystem temporary-write failure with
// temporary config only. Run for write error handling; skip UI-only changes.
