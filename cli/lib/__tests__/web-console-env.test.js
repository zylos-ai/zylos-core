import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanupWebConsoleEnv, atomicReplace } from '../web-console-env.js';

function fixture(t, content) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'console-env-'));
  const file = path.join(root, '.env');
  fs.writeFileSync(file, content, {mode:0o640});
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  return {root, file};
}

for (const key of ['ZYLOS_WEB_PASSWORD', 'WEB_CONSOLE_PASSWORD', 'WEB_CONSOLE_MAX_UPLOAD_MB', 'DASHBOARD_MAX_UPLOAD_MB']) {
  for (const quote of ['"', "'", '`']) test(`multiline ${key} with ${quote} leaves the whole file intact`, t => {
    const input = `ZYLOS_WEB_PASSWORD=remove-only-if-safe\n${key}=${quote}first\nlast${quote}\n`;
    const f = fixture(t, input);
    assert.equal(cleanupWebConsoleEnv(f.root).state, 'manual');
    assert.equal(fs.readFileSync(f.file, 'utf8'), input);
  });
}

test('failed atomic publication preserves the original and removes its temporary file', t => {
  const f = fixture(t, 'original');
  assert.throws(() => atomicReplace(f.file, 'replacement', {beforeRename:() => {throw Error('injected publication failure');}}), /publication failure/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'original');
  assert.deepEqual(fs.readdirSync(f.root), ['.env']);
});
