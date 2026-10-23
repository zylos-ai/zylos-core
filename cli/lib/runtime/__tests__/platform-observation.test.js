import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readProcessImage } from '../session-process-observation.js';

const fault = code => Object.assign(new Error(code), { code });
const stat = (start = '100', state = 'S') => `42 (name with ) spaces) ${[state, ...Array(18).fill('0'), start].join(' ')}`;
function snapshot({ identities = [stat(), stat()], failField, failure = 'ENOENT' } = {}) {
  const calls = []; let index = 0;
  const filesystem = {
    async stat() { return { isDirectory: () => true }; },
    async readFile(file) {
      const field = path.basename(file); calls.push(field);
      if (field === 'stat') {
        const value = identities[Math.min(index++, identities.length - 1)];
        if (value instanceof Error) throw value;
        return value;
      }
      if (field === failField) throw fault(failure);
      return Buffer.from(field === 'cmdline' ? '/runtime\0\0argument with spaces\0' : 'ZYLOS_RUN_ID=r\0OTHER=x=y\0');
    },
    async readlink(file) {
      const field = path.basename(file); calls.push(field);
      if (field === failField) throw fault(failure);
      return field === 'exe' ? '/runtime' : '/isolated root';
    },
  };
  return { calls, options: { filesystem, platform: 'linux', procRoot: '/synthetic-proc' } };
}

test('complete observation preserves exact argv including empty arguments and environment', async () => {
  const f = snapshot();
  assert.deepEqual(await readProcessImage(42, f.options), {
    exe: '/runtime', cwd: '/isolated root', argv: ['/runtime', '', 'argument with spaces'],
    env: ['ZYLOS_RUN_ID=r', 'OTHER=x=y'], start: '100',
  });
  assert.equal(f.calls.filter(x => x === 'stat').length, 2);
});
test('unsupported platform never attempts Linux reads or reports absence', async () => {
  const f = snapshot();
  assert.deepEqual(await readProcessImage(42, { ...f.options, platform: 'darwin' }), { uncertain: true });
  assert.deepEqual(f.calls, []);
});
for (const field of ['exe', 'cwd', 'environ', 'cmdline']) {
  for (const code of ['ENOENT', 'EACCES']) {
    test(`partial ${field}/${code} with original process alive stays uncertain`, async () => {
      const f = snapshot({ failField: field, failure: code });
      assert.deepEqual(await readProcessImage(42, f.options), { uncertain: true, start: '100' });
      assert.equal(f.calls.filter(x => x === 'stat').length, 2);
    });
  }
}
test('initial absence and zombie are gone without reading inaccessible image fields', async () => {
  for (const identity of [fault('ENOENT'), fault('ESRCH'), stat('100', 'Z')]) {
    const f = snapshot({ identities: [identity] });
    assert.deepEqual(await readProcessImage(42, f.options), { gone: true });
    assert.deepEqual(f.calls, ['stat']);
  }
});
test('mid-read exit requires identity disappearance or same-incarnation zombie', async () => {
  for (const identity of [fault('ENOENT'), fault('ESRCH'), stat('100', 'Z')]) {
    const f = snapshot({ identities: [stat(), identity], failField: 'cwd' });
    assert.deepEqual(await readProcessImage(42, f.options), { gone: true, start: '100' });
  }
});
test('PID reuse cannot combine old executable data with new incarnation', async () => {
  for (const state of ['S', 'Z']) {
    const f = snapshot({ identities: [stat(), stat('101', state)] });
    assert.deepEqual(await readProcessImage(42, f.options), { uncertain: true, start: '100' });
  }
});
test('malformed or inaccessible identities never authorize exit or exec success', async () => {
  for (const identity of ['42 (bad) S 1', fault('EACCES')]) {
    for (const identities of [[identity], [stat(), identity]]) {
      const f = snapshot({ identities });
      assert.deepEqual(await readProcessImage(42, f.options), identities.length === 1 ? { uncertain: true } : { uncertain: true, start: '100' });
    }
  }
});
test('real Linux current-process image carries independently known argv cwd and incarnation', async () => {
  assert.equal(process.platform, 'linux', 'This real-host assertion requires Linux');
  const image = await readProcessImage(process.pid);
  assert.equal(image.cwd, process.cwd());
  assert.equal(image.exe, await fs.realpath(process.execPath));
  assert.ok(image.argv.some(arg => arg && path.resolve(arg) === process.argv[1]));
  assert.match(image.start, /^\d+$/);
});

test('missing proc root is unavailable rather than proof that the process exited', async () => {
  for (const identities of [[fault('ENOENT')], [stat(), fault('ENOENT')]]) {
    const f = snapshot({ identities });
    f.options.filesystem.stat = async () => { throw fault('ENOENT'); };
    assert.deepEqual(await readProcessImage(42, f.options), identities.length === 1 ? { uncertain: true } : { uncertain: true, start: '100' });
  }
});

test('non-directory proc root cannot prove absence', async () => {
  const f = snapshot({ identities: [fault('ENOENT')] });
  f.options.filesystem.stat = async () => ({ isDirectory: () => false });
  assert.deepEqual(await readProcessImage(42, f.options), { uncertain: true });
});
