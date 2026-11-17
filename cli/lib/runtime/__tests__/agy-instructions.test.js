import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { activateFreshSplitInstructions, buildInstructionFile, agyInstructionContext,
  assertInstructionReady, instructionPaths } from '../instruction-builder.js';

function fixture(t, { split = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-instructions-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  if (split) activateFreshSplitInstructions({ zylosDir: root });
  return root;
}

test('agy and Codex build byte-identical complete AGENTS in the same root', t => {
  const root = fixture(t);
  fs.appendFileSync(path.join(root, 'ZYLOS.md'), 'user rule '.repeat(4000) + '\nUSER_TAIL_MARKER');
  const file = buildInstructionFile('codex', { zylosDir: root });
  const codex = fs.readFileSync(file);
  assert.ok(codex.includes(Buffer.from('USER_TAIL_MARKER')));
  assert.ok(codex.includes(Buffer.from('## Codex — Runtime-Specific Rules')));
  assert.ok(codex.includes(Buffer.from('## Antigravity — Runtime-Specific Rules')));
  assert.ok(codex.includes(Buffer.from('**Never call `ask_question`.**')));
  assert.ok(codex.includes(Buffer.from('Check `manage_task list` and `manage_subagents list` first')));
  assert.equal(buildInstructionFile('agy', { zylosDir: root }), file);
  assert.ok(codex.equals(fs.readFileSync(file)), 'agy must preserve the complete shared bytes');
});

test('alternating runtime builds keep Codex instructions ready across repeated rounds', t => {
  const root = fixture(t);
  const file = buildInstructionFile('codex', { zylosDir: root });
  const original = fs.readFileSync(file);
  for (let round = 0; round < 8; round++) {
    for (const runtime of ['agy', 'codex']) {
      buildInstructionFile(runtime, { zylosDir: root });
      assert.equal(assertInstructionReady('codex', { zylosDir: root }), true);
      assert.ok(original.equals(fs.readFileSync(file)), `${runtime} changed the shared bytes in round ${round}`);
    }
  }
});

test('agy injection retains full system and user tails with explicit runtime precedence', t => {
  const root = fixture(t);
  const paths = instructionPaths('codex', { zylosDir: root });
  fs.appendFileSync(paths.systemPath, '\n' + 'system rule '.repeat(3000) + '\nSYSTEM_TAIL_MARKER');
  fs.appendFileSync(paths.userPath, '\n' + '中'.repeat(16000) + '\nUSER_TAIL_MARKER');
  buildInstructionFile('codex', { zylosDir: root, force: true });
  const original = fs.readFileSync(paths.outputPath);
  const content = agyInstructionContext({ zylosDir: root });
  assert.match(content, /^This injection contains the complete Zylos instructions\./);
  assert.ok(content.includes('this injection takes precedence.'));
  assert.ok(content.includes('SYSTEM_TAIL_MARKER'));
  assert.ok(content.includes('USER_TAIL_MARKER'));
  assert.ok(content.includes('Antigravity — Runtime-Specific Rules'));
  assert.ok(content.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.ok(content.includes('This section applies only to Codex; Antigravity must ignore it.'));
  assert.ok(content.includes('This section applies only to Antigravity; Codex must ignore it.'));
  assert.ok(content.includes(fs.readFileSync(paths.systemPath, 'utf8')), 'inject full unmodified system instructions');
  assert.ok(original.equals(fs.readFileSync(paths.outputPath)), 'injection must not rewrite AGENTS');
});

test('legacy AGENTS above the native file limit stays unchanged and is injected completely', t => {
  const root = fixture(t, { split: false });
  const file = path.join(root, 'AGENTS.md');
  const content = 'legacy system '.repeat(3000) + '\nLEGACY_SYSTEM_TAIL\n' +
    'legacy user '.repeat(3000) + '\nLEGACY_USER_TAIL';
  fs.writeFileSync(file, content);
  const original = fs.readFileSync(file);
  for (const runtime of ['agy', 'codex']) {
    assert.equal(buildInstructionFile(runtime, { zylosDir: root }), file);
    assert.equal(assertInstructionReady(runtime, { zylosDir: root }), true);
    assert.ok(original.equals(fs.readFileSync(file)));
  }
  const injected = agyInstructionContext({ zylosDir: root });
  assert.ok(injected.includes(content));
  assert.ok(injected.startsWith('This injection contains the complete Zylos instructions.'));
});
