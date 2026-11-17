import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { activateFreshSplitInstructions, buildInstructionFile, agyInstructionContext, assertInstructionReady } from '../instruction-builder.js';

test('AGY instruction file stays below read limit and hook retains full user tail',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'agy-instructions-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  activateFreshSplitInstructions({zylosDir:root});
  fs.appendFileSync(path.join(root,'ZYLOS.md'),'中'.repeat(16000)+'\nTAIL_RULE_MARKER');
  const output=buildInstructionFile('agy',{zylosDir:root});
  assert.ok(fs.statSync(output).size<24000);
  assert.equal(assertInstructionReady('agy',{zylosDir:root}),true);
  const context=agyInstructionContext({zylosDir:root});
  assert.match(context,/TAIL_RULE_MARKER$/);assert.match(context,/Antigravity — Runtime-Specific Rules/);
  assert.doesNotMatch(context,/--dangerously-bypass-approvals-and-sandbox/);
});
test('oversized legacy AGENTS fails with migration guidance',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'agy-instructions-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.writeFileSync(path.join(root,'AGENTS.md'),'a'.repeat(24001));
  assert.throws(()=>buildInstructionFile('agy',{zylosDir:root}),/split-instruction migration/);
});

test('switching instruction entries restores complete Codex rules and retains agy injection', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-instructions-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  activateFreshSplitInstructions({ zylosDir: root });
  fs.appendFileSync(path.join(root, 'ZYLOS.md'), 'user rule '.repeat(4000) + '\nSHARED_TAIL_RULE');
  const file = buildInstructionFile('agy', { zylosDir: root });
  assert.ok(fs.statSync(file).size < 24000);
  buildInstructionFile('codex', { zylosDir: root });
  assert.match(fs.readFileSync(file, 'utf8'), /SHARED_TAIL_RULE/);
  assert.equal(assertInstructionReady('codex', { zylosDir: root }), true);
  buildInstructionFile('agy', { zylosDir: root });
  assert.ok(fs.statSync(file).size < 24000);
  assert.match(agyInstructionContext({ zylosDir: root }), /SHARED_TAIL_RULE/);
});
