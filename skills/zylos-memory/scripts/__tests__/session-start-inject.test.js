import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, before, after } from 'node:test';

// shared.js resolves MEMORY_DIR from ZYLOS_DIR at import time, so the env
// override must be in place before the module under test is loaded.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-start-inject-'));
process.env.ZYLOS_DIR = tmpDir;

const { injectMemory, injectMemoryCore, injectMemoryState } =
  await import('../session-start-inject.js');

const MEMORY_DIR = path.join(tmpDir, 'memory');

before(() => {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
  fs.writeFileSync(path.join(MEMORY_DIR, 'identity.md'), 'identity body');
  fs.writeFileSync(path.join(MEMORY_DIR, 'references.md'), 'references body');
  fs.writeFileSync(path.join(MEMORY_DIR, 'state.md'), 'state body');
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('session-start-inject section ordering (#686)', () => {
  it('injectMemoryCore emits identity then references, without state', () => {
    const output = injectMemoryCore();
    const identityAt = output.indexOf('=== BOT IDENTITY ===');
    const referencesAt = output.indexOf('=== REFERENCES ===');
    assert.ok(identityAt >= 0);
    assert.ok(referencesAt > identityAt);
    assert.ok(output.includes('identity body'));
    assert.ok(output.includes('references body'));
    assert.ok(!output.includes('=== ACTIVE STATE ==='));
    assert.ok(!output.includes('state body'));
  });

  it('injectMemoryState emits only the state section', () => {
    const output = injectMemoryState();
    assert.ok(output.includes('=== ACTIVE STATE ==='));
    assert.ok(output.includes('state body'));
    assert.ok(!output.includes('=== BOT IDENTITY ==='));
    assert.ok(!output.includes('=== REFERENCES ==='));
  });

  it('injectMemory emits all sections in priority order: identity, references, state', () => {
    const output = injectMemory();
    const identityAt = output.indexOf('=== BOT IDENTITY ===');
    const referencesAt = output.indexOf('=== REFERENCES ===');
    const stateAt = output.indexOf('=== ACTIVE STATE ===');
    assert.ok(identityAt >= 0);
    assert.ok(referencesAt > identityAt);
    assert.ok(stateAt > referencesAt);
  });

  it('marks a missing file inside its section instead of failing', () => {
    fs.rmSync(path.join(MEMORY_DIR, 'references.md'));
    try {
      const output = injectMemoryCore();
      assert.ok(output.includes('=== REFERENCES ==='));
      assert.ok(output.includes('(missing)'));
    } finally {
      fs.writeFileSync(path.join(MEMORY_DIR, 'references.md'), 'references body');
    }
  });
});
