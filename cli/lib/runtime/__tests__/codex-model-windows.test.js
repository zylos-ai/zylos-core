import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getRuntime } from '../index.js';

const { readModelWindows } = (await getRuntime('codex')).context;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-model-windows-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (relative, value) => {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(value));
  };
  return { root, write };
}

test('Codex cache reader honors a private path', t => {
  const f = fixture(t);
  f.write('codex/models_cache.json', { models: [{ slug: 'private-model', context_window: 500000 }] });
  assert.equal(readModelWindows({ env: { CODEX_HOME: path.join(f.root, 'codex') } })[0].context_window, 500000);
});

test('Codex model cache is parsed again only after the file changes', t => {
  const f = fixture(t);
  const codexHome = path.join(f.root, 'codex'), file = path.join(codexHome, 'models_cache.json');
  const read = () => readModelWindows({ env: { CODEX_HOME: codexHome } });
  const original = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = function (target, ...rest) { if (target === file) reads++; return original.call(this, target, ...rest); };
  t.after(() => { fs.readFileSync = original; });
  const windows = value => ({ models: [{ slug: 'model-a', context_window: value }] });

  f.write('codex/models_cache.json', windows(200000));
  assert.equal(read()[0].context_window, 200000);
  for (let i = 0; i < 3; i++) assert.equal(read()[0].context_window, 200000);
  assert.equal(reads, 1, 'an unchanged file is not read again');

  // Atomic replacement, as an updater writes it.
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(windows(400000)));
  fs.renameSync(`${file}.tmp`, file);
  assert.equal(read()[0].context_window, 400000);
  // In-place rewrite.
  fs.writeFileSync(file, JSON.stringify(windows(1000000)));
  assert.equal(read()[0].context_window, 1000000);
  assert.equal(read()[0].context_window, 1000000);
  assert.equal(reads, 3);

  fs.writeFileSync(file, '{"models": [');
  assert.deepEqual(read(), [], 'an unparseable cache still reads as no models');
  fs.rmSync(file);
  assert.deepEqual(read(), []);
  f.write('codex/models_cache.json', windows(272000));
  assert.equal(read()[0].context_window, 272000);
});

test('Codex model cache recovers after a transient read failure without a file change', t => {
  const f = fixture(t), codexHome = path.join(f.root, 'codex');
  const file = path.join(codexHome, 'models_cache.json');
  f.write('codex/models_cache.json', { models: [{ slug:'model-a', context_window:272000 }] });
  const signature = fs.statSync(file), original = fs.readFileSync;
  let fail = true, reads = 0;
  t.mock.method(fs, 'readFileSync', function(target, ...args) {
    if (target === file) {
      reads++;
      if (fail) { fail = false; throw Object.assign(new Error('temporary descriptor exhaustion'), {code:'EMFILE'}); }
    }
    return original.call(this, target, ...args);
  });
  assert.deepEqual(readModelWindows({ env: { CODEX_HOME: codexHome } }), []);
  assert.equal(readModelWindows({ env: { CODEX_HOME: codexHome } })[0].context_window, 272000);
  assert.equal(readModelWindows({ env: { CODEX_HOME: codexHome } })[0].context_window, 272000);
  assert.equal(reads, 2, 'successful recovery is cached');
  assert.equal(fs.statSync(file).mtimeMs, signature.mtimeMs);
  assert.equal(fs.statSync(file).ctimeMs, signature.ctimeMs);
});
