import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createTestEnvironment } from '../scripts/test-environment.js';

for (const preserveTmp of [false, true]) {
  test(`test environment cleanup restores the caller home and ${preserveTmp ? 'preserves failure evidence' : 'removes the private root'}`, () => {
    const before = { HOME: process.env.HOME, ZYLOS_DIR: process.env.ZYLOS_DIR, PM2_HOME: process.env.PM2_HOME };
    const environment = createTestEnvironment();
    const temporary = path.join(environment.root, 'tmp');
    fs.mkdirSync(temporary);
    const evidence = path.join(temporary, 'evidence.txt');
    fs.writeFileSync(evidence, 'private failure evidence');
    assert.equal(os.homedir(), path.join(environment.root, 'home'));
    try {
      environment.cleanup({ preserveTmp });
      for (const [key, value] of Object.entries(before)) assert.equal(process.env[key], value);
      if (preserveTmp) {
        assert.equal(fs.readFileSync(evidence, 'utf8'), 'private failure evidence');
        assert.equal(fs.existsSync(path.join(environment.root, 'home')), false);
        assert.equal(fs.readdirSync(environment.root).join(','), 'tmp');
      } else assert.equal(fs.existsSync(environment.root), false);
      environment.cleanup({ preserveTmp });
    } finally {
      // This fixture is test-owned; it lives under the outer runner's private TMPDIR.
      fs.rmSync(environment.root, { recursive: true, force: true });
    }
  });
}
