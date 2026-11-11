import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareReferenceReorg } from '../reference-reorg-proposal.js';

const now = Date.parse('2026-11-11T10:00:00Z');
const week = 7 * 24 * 60 * 60 * 1000;
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reorg-proposal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const memory = path.join(root, 'memory');
  fs.mkdirSync(path.join(memory, 'reference'), { recursive: true });
  const target = path.join(memory, 'reference-reorg-state.json');
  const old = name => fs.writeFileSync(path.join(memory, 'reference', name), 'old bytes');
  const state = text => fs.writeFileSync(target, text);
  return { root, memory, target, old, state, run: (at = now, io = fs) => prepareReferenceReorg({ root, now: at, io }) };
}

test('no old files leaves the question state untouched without reading it', t => {
  const f = fixture(t);
  assert.equal(f.run(now, { ...fs, readFileSync: () => { throw new Error('unexpected read'); } }), false);
  assert.equal(fs.existsSync(f.target), false);
});

for (const name of ['projects.md', 'decisions.md']) {
  test(`an old ${name} records only the current ISO question time`, t => {
    const f = fixture(t); f.old(name);
    assert.equal(f.run(), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.target)), { lastAskedAt: new Date(now).toISOString() });
    assert.equal(fs.readFileSync(path.join(f.memory, 'reference', name), 'utf8'), 'old bytes');
    assert.equal(fs.readdirSync(f.memory).some(name => name.endsWith('.tmp')), false);
  });
}

test('a proposal is suppressed before seven days and eligible exactly at seven days', t => {
  const f = fixture(t); f.old('projects.md');
  assert.equal(f.run(), true);
  const original = fs.readFileSync(f.target, 'utf8');
  assert.equal(f.run(now + week - 1), false);
  assert.equal(fs.readFileSync(f.target, 'utf8'), original);
  assert.equal(f.run(now + week), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.target)), { lastAskedAt: new Date(now + week).toISOString() });
});

test('missing or unreadable JSON content is treated as never asked', t => {
  const f = fixture(t); f.old('projects.md');
  for (const content of ['broken JSON', '{}', 'null', '{"lastAskedAt":"not a date"}']) {
    f.state(content);
    assert.equal(f.run(), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.target)), { lastAskedAt: new Date(now).toISOString() });
  }
});

test('read permission errors propagate without writing question state', t => {
  const f = fixture(t); f.old('projects.md'); f.state('{"lastAskedAt":"old"}');
  const io = { ...fs, readFileSync: () => { throw Object.assign(new Error('read denied'), { code: 'EACCES' }); },
    writeFileSync: () => { throw new Error('unexpected write'); } };
  assert.throws(() => f.run(now, io), error => error.code === 'EACCES');
  assert.equal(fs.readFileSync(f.target, 'utf8'), '{"lastAskedAt":"old"}');
});

for (const method of ['writeFileSync', 'renameSync']) {
  test(`${method} failure preserves prior question state and cleans the temporary file`, t => {
    const f = fixture(t); f.old('projects.md'); f.state('{}');
    const io = { ...fs, [method]: () => { throw Object.assign(new Error('write denied'), { code: 'EACCES' }); } };
    assert.throws(() => f.run(now, io), error => error.code === 'EACCES');
    assert.equal(fs.readFileSync(f.target, 'utf8'), '{}');
    assert.equal(fs.readdirSync(f.memory).some(name => name.endsWith('.tmp')), false);
  });
}

test('state publication writes a same-directory temporary file before rename', t => {
  const f = fixture(t); f.old('projects.md');
  const calls = [];
  const io = { ...fs,
    writeFileSync: (target, content, options) => { calls.push(['write', target]); fs.writeFileSync(target, content, options); },
    renameSync: (source, target) => { calls.push(['rename', source, target]); fs.renameSync(source, target); },
  };
  assert.equal(f.run(now, io), true);
  assert.deepEqual(calls.map(call => call[0]), ['write', 'rename']);
  assert.equal(path.dirname(calls[0][1]), f.memory);
  assert.equal(calls[1][1], calls[0][1]); assert.equal(calls[1][2], f.target);
});
