import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-config-cutover-'));
process.env.ZYLOS_DIR = root;
const { readSessionMode, writeSessionModeAtCutover } = await import('../config.js');

before(() => fs.mkdirSync(path.join(root, '.zylos'), { recursive: true }));
after(() => fs.rmSync(root, { recursive: true, force: true }));

describe('session mode facade', () => {
  it('distinguishes missing, explicit modes, and invalid values', () => {
    assert.deepEqual(readSessionMode(), { mode: null, keyPresent: false });
    assert.equal(writeSessionModeAtCutover('multi').verification.mode, 'multi');
    assert.deepEqual(readSessionMode(), { mode: 'multi', keyPresent: true });
    fs.writeFileSync(path.join(root, '.zylos', 'config.json'), '{"session_mode":null}\n');
    assert.throws(() => readSessionMode(), error => error.code === 'CONFIG_UNREADABLE');
  });

  it('rejects unknown modes before writing', () => {
    assert.throws(() => writeSessionModeAtCutover('other'), TypeError);
  });
});
