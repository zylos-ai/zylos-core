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
  const { sessionStartInjection } = declarations[index];

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
