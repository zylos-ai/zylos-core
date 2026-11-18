import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { activateFreshSplitInstructions, refreshSplitInstructions } from '../runtime/instruction-builder.js';

test('new and refreshed instruction files cover both runtime authentication errors', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-auth-instructions-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const prepare of [activateFreshSplitInstructions, refreshSplitInstructions]) {
    assert.equal(prepare({ zylosDir: root }).active, true);
    for (const file of ['CLAUDE.md', 'AGENTS.md']) {
      const text = fs.readFileSync(path.join(root, file), 'utf8');
      assert.match(text, /Exit 1 with `AUTH_FAILED` or `AUTH_NOT_CONFIRMED`: follow/);
      assert.doesNotMatch(text, /Exit 1 with `AUTH_NOT_CONFIRMED`:/);
    }
  }
});
