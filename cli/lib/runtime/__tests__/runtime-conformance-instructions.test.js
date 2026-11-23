import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UNSUPPORTED } from '../contract.js';
import { getRuntime, SUPPORTED_RUNTIMES } from '../index.js';
import { activateFreshSplitInstructions, instructionPaths } from '../instruction-builder.js';

const declarations = await Promise.all(SUPPORTED_RUNTIMES.map(async id => (await getRuntime(id)).instructions));

for (const [index, id] of SUPPORTED_RUNTIMES.entries()) {
  const { template, output, sessionStartInjection } = declarations[index];
  test(`${id} names a shipped template and an instruction file`, () => {
    assert.ok(typeof template === 'string' && template.length > 0);
    assert.ok(fs.statSync(new URL(`../../../../templates/${template}-system.md`, import.meta.url)).isFile());
    assert.ok(typeof output === 'string' && output.length > 0 && !/[/\\]/.test(output));
    assert.ok(sessionStartInjection === UNSUPPORTED || typeof sessionStartInjection === 'function');
  });

  if (sessionStartInjection !== UNSUPPORTED) {
    test(`${id} injects the complete split system and user instructions`, t => {
      const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instruction-contract-'));
      t.after(() => fs.rmSync(zylosDir, { recursive: true, force: true }));
      activateFreshSplitInstructions({ zylosDir });
      const { systemPath, userPath } = instructionPaths(id, { zylosDir });
      const injected = sessionStartInjection({ zylosDir });
      assert.ok(injected.includes(fs.readFileSync(systemPath, 'utf8')));
      assert.ok(injected.includes(fs.readFileSync(userPath, 'utf8')));
    });
  }
}

test('implementations sharing an instruction output also share its template', () => {
  const templates = new Map();
  for (const { template, output } of declarations) {
    if (templates.has(output)) {
      assert.equal(template, templates.get(output), `conflicting templates for ${output}`);
    }
    templates.set(output, template);
  }
});
