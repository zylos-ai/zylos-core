import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readyTmuxTarget } from '../../../../test/helpers/ready-tmux-target.js';

test('review status: real CLI is read-only and single mode does not expose group sessions', t => {
  const f = readyTmuxTarget(t, { prefix: 'cli-status-readonly-', ledger: false });
  f.tmux('new-session', '-d', '-s', 'zylos-group-telegram-g123', 'sleep', '60');
  const snapshot = () => {
    const entries = {};
    const walk = dir => { for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name);
      if (item.isDirectory()) walk(file);
      else if (item.isFile()) entries[path.relative(f.root, file)] = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    } };
    walk(f.root); return entries;
  };
  const before = snapshot();
  const text = execFileSync(process.execPath, [new URL('../../../zylos.js', import.meta.url).pathname, 'status', '--json'], { env: f.env, encoding: 'utf8', timeout: 10000 });
  assert.equal(text.trim().split('\n').length, 1);
  const result = JSON.parse(text);
  assert.equal(result.ok, true);
  assert.equal(result.data.view, 'single');
  assert.deepEqual(result.data.groups, []);
  assert.deepEqual(snapshot(), before, 'status wrote or changed a fixture file');
});
