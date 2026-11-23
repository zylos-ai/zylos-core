import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { activateFreshSplitInstructions, buildInstructionFile } from '../instruction-builder.js';

function fixture(t, { split = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-instructions-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  if (split) activateFreshSplitInstructions({ zylosDir: root });
  return root;
}

test('agy and Codex build byte-identical complete AGENTS in the same root', t => {
  const root = fixture(t);
  fs.appendFileSync(path.join(root, 'ZYLOS.md'), 'user rule '.repeat(4000) + '\nUSER_TAIL_MARKER');
  // These fixture writes can share an mtime with the initial render.
  const file = buildInstructionFile('codex', { zylosDir: root, force: true });
  const codex = fs.readFileSync(file);
  assert.ok(codex.includes(Buffer.from('USER_TAIL_MARKER')));
  assert.ok(codex.includes(Buffer.from('## Codex — Runtime-Specific Rules')));
  assert.ok(codex.includes(Buffer.from('## Antigravity — Runtime-Specific Rules')));
  assert.ok(codex.includes(Buffer.from('**Never call `ask_question`.**')));
  assert.ok(codex.includes(Buffer.from('Check `manage_task list` and `manage_subagents list` first')));
  assert.equal(buildInstructionFile('agy', { zylosDir: root }), file);
  assert.ok(codex.equals(fs.readFileSync(file)), 'agy must preserve the complete shared bytes');
});
