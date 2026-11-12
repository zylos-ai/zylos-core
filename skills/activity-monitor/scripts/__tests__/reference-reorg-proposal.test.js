import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareReferenceReorg } from '../reference-reorg-proposal.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reorg-proposal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const memory = path.join(root, 'memory');
  fs.mkdirSync(path.join(memory, 'reference'), { recursive: true });
  const target = path.join(memory, 'reference-reorg-state.json');
  const old = name => fs.writeFileSync(path.join(memory, 'reference', name), 'old bytes');
  const unchanged = () => {
    assert.equal(fs.existsSync(target), false);
    assert.deepEqual(fs.readdirSync(memory), ['reference']);
  };
  return { root, memory, old, unchanged, run: (io = fs) => prepareReferenceReorg({ root, io }) };
}

test('no old files makes reorganization unnecessary without creating files', t => {
  const f = fixture(t);
  assert.equal(f.run(), false);
  f.unchanged();
});

for (const name of ['projects.md', 'decisions.md']) {
  test(`an old ${name} requests reorganization on every check without creating files`, t => {
    const f = fixture(t); f.old(name);
    assert.equal(f.run(), true);
    assert.equal(f.run(), true);
    assert.equal(fs.readFileSync(path.join(f.memory, 'reference', name), 'utf8'), 'old bytes');
    f.unchanged();
  });
}

test('both old files are eligible until both original paths are absent', t => {
  const f = fixture(t); f.old('projects.md'); f.old('decisions.md');
  assert.equal(f.run(), true);
  fs.unlinkSync(path.join(f.memory, 'reference/projects.md'));
  assert.equal(f.run(), true);
  fs.unlinkSync(path.join(f.memory, 'reference/decisions.md'));
  assert.equal(f.run(), false);
  f.unchanged();
});

for (const name of ['projects.md', 'decisions.md']) {
  for (const code of ['EACCES', 'EIO']) {
    test(`${name} stat ${code} propagates without creating files`, t => {
      const f = fixture(t);
      const expected = Object.assign(new Error('old file unavailable'), { code });
      const io = {
        statSync: file => {
          if (file === path.join(f.memory, 'reference', name)) throw expected;
          return fs.statSync(file);
        },
      };
      assert.throws(() => f.run(io), error => error === expected);
      f.unchanged();
    });
  }
}
