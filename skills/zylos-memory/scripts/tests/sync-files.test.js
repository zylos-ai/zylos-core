import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanup, rotate, list, commit, checkpoint, extractAbsorbedBlock } from '../sync-files.js';
import { renderStateSkeleton } from '../state-format.js';
import { acquire, memoryScope } from '../sync-lock.js';

const segment = '20261019T053002123Z';
async function fixture(t, group = 'telegram:test') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p07-files-'));
  const env = { ...process.env, ZYLOS_DIR: root, ZYLOS_RUN_ID: 'test-run' };
  delete env.ZYLOS_SESSION_GROUP;
  if (group !== null) env.ZYLOS_SESSION_GROUP = group;
  const scope = await memoryScope(env), kind = group === null ? 'global' : 'group';
  fs.mkdirSync(scope.memoryDir, { recursive: true }); fs.mkdirSync(scope.runDir, { recursive: true });
  const token = await acquire({ env, kind }, { currentRunId: async () => env.ZYLOS_RUN_ID });
  const settings = { token, env }, warnings = [], deps = { currentRunId: async () => env.ZYLOS_RUN_ID, warning: value => warnings.push(value) };
  const state = path.join(scope.memoryDir, 'state.md'), temporary = `${state}.${token}.tmp`;
  const skeleton = (ids = [], extra = {}) => renderStateSkeleton({ scope: scope.scope, syncedAt: '2026-10-19T05:30:02Z', absorbed: ids.length ? { runId: 'run-1', followUp: 'group', rows: ids.map(id => ({ id, timestamp: '2026-10-19 05:30:02', channel: 'telegram', endpointId: 'x', content: id === 2 ? '汉'.repeat(400) + '\nend' : `text ${id}` })) } : null, ...extra });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { ...scope, root, settings, deps, state, temporary, skeleton, warnings };
}
const write = (f, ids = [1, 2, 3]) => {
  const official = f.skeleton(ids);
  fs.writeFileSync(f.state, official);
  fs.writeFileSync(f.temporary, f.skeleton().replace('inbox_committed= ', `inbox_committed=${segment} `).replace('## Headline\n', '## Headline\nUpdated\n'));
  fs.writeFileSync(path.join(f.memoryDir, `inbox.${segment}.md`), 'absorbed');
  return official;
};

test('IB51 commit preserves original bytes/title and removes only supplied IDs, including duplicates', async t => {
  const f = await fixture(t), original = write(f), block = extractAbsorbedBlock(original);
  await commit({ ...f.settings, input: { followedUpIds: [1, 1] } }, f.deps);
  const actual = fs.readFileSync(f.state, 'utf8'), after = extractAbsorbedBlock(actual);
  assert.equal(after.title, block.title); assert.deepEqual(after.entries, block.entries.slice(1));
  assert.match(actual, /Updated/); assert.equal(fs.existsSync(path.join(f.memoryDir, `inbox.${segment}.md`)), false);
  fs.writeFileSync(f.temporary, f.skeleton());
  await commit({ ...f.settings, input: { followedUpIds: [] } }, f.deps);
  assert.deepEqual(extractAbsorbedBlock(fs.readFileSync(f.state, 'utf8')), after);
  fs.writeFileSync(f.temporary, f.skeleton());
  await commit({ ...f.settings, input: { followedUpIds: [2, 3] } }, f.deps);
  assert.doesNotMatch(fs.readFileSync(f.state, 'utf8'), /切换来信/);
});

test('IB51 commit uses body despite corrupt official header and strips temporary copies with warning', async t => {
  const f = await fixture(t), original = write(f);
  fs.writeFileSync(f.state, original.replace('zylos-state v1', 'broken'));
  fs.writeFileSync(f.temporary, f.skeleton([9, 10]).replace('## Headline\n', '## Headline\nModel text\n'));
  await commit({ ...f.settings, input: { followedUpIds: [1] } }, f.deps);
  const actual = fs.readFileSync(f.state, 'utf8');
  assert.deepEqual(extractAbsorbedBlock(actual).entries, extractAbsorbedBlock(original).entries.slice(1));
  assert.match(actual, /Model text/); assert.equal(f.warnings.length, 1); assert.doesNotMatch(actual, /#9 |#10 /);
});

test('IB51 extraction is only at Pending start, stops at non-entry, preserves CRLF bytes', async t => {
  const f = await fixture(t), original = write(f).replaceAll('\n', '\r\n');
  const block = extractAbsorbedBlock(original);
  const interrupted = original.replace(block.entries[1].raw, 'ordinary task\r\n' + block.entries[1].raw);
  fs.writeFileSync(f.state, interrupted);
  await commit({ ...f.settings, input: { followedUpIds: [] } }, f.deps);
  assert.deepEqual(extractAbsorbedBlock(fs.readFileSync(f.state, 'utf8')).entries, block.entries.slice(0, 1));
  fs.writeFileSync(f.state, original.replace('## Pending\r\n', '## Pending\r\nordinary task\r\n'));
  fs.writeFileSync(f.temporary, f.skeleton());
  await commit({ ...f.settings, input: { followedUpIds: [] } }, f.deps);
  assert.equal(extractAbsorbedBlock(fs.readFileSync(f.state, 'utf8')).entries.length, 0);
});

test('IB51 invalid follow-up input does not replace state or remove segments', async t => {
  const f = await fixture(t), original = write(f);
  for (const input of [undefined, '', '{', {}, [], { followedUpIds: null }, { followedUpIds: [0] }, { followedUpIds: [1.2] }, { followedUpIds: ['1'] }, { followedUpIds: [9] }]) {
    await assert.rejects(commit({ ...f.settings, input }, f.deps), { code: 'INVALID_INPUT' });
    assert.equal(fs.readFileSync(f.state, 'utf8'), original);
    assert.equal(fs.readFileSync(path.join(f.memoryDir, `inbox.${segment}.md`), 'utf8'), 'absorbed');
  }
});

test('IB51 missing/invalid temporary state rejects before publication and deletion', async t => {
  const f = await fixture(t), original = write(f);
  for (const content of [null, 'broken', f.skeleton().replace('## Commitments', 'wrong'), f.skeleton().replace('scope=telegram:test', 'scope=origin')]) {
    if (content === null) fs.unlinkSync(f.temporary); else fs.writeFileSync(f.temporary, content);
    await assert.rejects(commit({ ...f.settings, input: { followedUpIds: [] } }, f.deps), { code: 'STATE_DOCUMENT_INVALID' });
    assert.equal(fs.readFileSync(f.state, 'utf8'), original);
    assert.equal(fs.existsSync(path.join(f.memoryDir, `inbox.${segment}.md`)), true);
  }
});

test('IB51 absent official file accepts empty follow-ups, unknown ID remains invalid', async t => {
  const f = await fixture(t);
  fs.writeFileSync(f.temporary, f.skeleton());
  await assert.rejects(commit({ ...f.settings, input: { followedUpIds: [1] } }, f.deps), { code: 'INVALID_INPUT' });
  await commit({ ...f.settings, input: { followedUpIds: [] } }, f.deps);
  assert.equal(fs.readFileSync(f.state, 'utf8'), f.skeleton());
});

test('IB51 rename commits even if segment deletion fails; next cleanup can retry', async t => {
  const f = await fixture(t); write(f);
  const target = path.join(f.memoryDir, `inbox.${segment}.md`);
  fs.unlinkSync(target); fs.mkdirSync(target);
  assert.equal((await commit({ ...f.settings, input: { followedUpIds: [] } }, f.deps)).committed, true);
  assert.equal(f.warnings.length, 1); assert.match(fs.readFileSync(f.state, 'utf8'), /Updated/);
  fs.rmdirSync(target); fs.writeFileSync(target, 'leftover');
  await cleanup(f.settings, f.deps); assert.equal(fs.existsSync(target), false);
});

test('IB51 cleanup trusts only valid headers and retains own temporary file', async t => {
  const f = await fixture(t); write(f);
  fs.writeFileSync(f.state, 'broken');
  fs.writeFileSync(path.join(f.memoryDir, 'state.md.old.tmp'), 'old');
  await cleanup(f.settings, f.deps);
  assert.equal(fs.existsSync(path.join(f.memoryDir, `inbox.${segment}.md`)), true);
  assert.equal(fs.existsSync(f.temporary), true);
  assert.equal(fs.existsSync(path.join(f.memoryDir, 'state.md.old.tmp')), false);
  assert.equal(f.warnings.length, 1);
});

test('IB51 rotate skips missing/empty input; list returns sorted uncommitted segments', async t => {
  const f = await fixture(t), inbox = path.join(f.memoryDir, 'inbox.md');
  assert.equal(await rotate(f.settings, f.deps), null);
  fs.writeFileSync(inbox, ''); assert.equal(await rotate(f.settings, f.deps), null);
  fs.writeFileSync(inbox, 'entry'); const id = await rotate(f.settings, f.deps);
  assert.match(id, /^\d{8}T\d{9}Z/); assert.equal(fs.readFileSync(path.join(f.memoryDir, `inbox.${id}.md`), 'utf8'), 'entry');
  fs.writeFileSync(path.join(f.memoryDir, `inbox.${segment}.md`), 'old');
  fs.writeFileSync(f.state, f.skeleton().replace('inbox_committed= ', `inbox_committed=${segment} `));
  assert.deepEqual(await list(f.settings), [id]);
  fs.writeFileSync(f.state, 'broken'); assert.deepEqual(await list(f.settings), [id, segment].sort());
});

test('IB51 old token cannot commit, cleanup, rotate or checkpoint', async t => {
  const f = await fixture(t), original = write(f), settings = { ...f.settings, token: 'b'.repeat(32) };
  for (const operation of [() => cleanup(settings, f.deps), () => rotate(settings, f.deps), () => commit({ ...settings, input: { followedUpIds: [] } }, f.deps), () => checkpoint({ ...settings, end: 0, summary: 'x' }, { ...f.deps, database: { createCheckpoint() { assert.fail('old token wrote checkpoint'); } } })]) {
    await assert.rejects(operation(), { code: 'TOKEN_MISMATCH' });
    assert.equal(fs.readFileSync(f.state, 'utf8'), original);
  }
});

test('IB51 1000 entries retain 990 original lines through a second empty-follow-up cycle', async t => {
  for (const group of ['telegram:test', 'origin', null]) {
    const f = await fixture(t, group), original = write(f, Array.from({ length: 1000 }, (_, i) => i + 1));
    const block = extractAbsorbedBlock(original);
    await commit({ ...f.settings, input: { followedUpIds: Array.from({ length: 10 }, (_, i) => i + 1) } }, f.deps);
    const after = extractAbsorbedBlock(fs.readFileSync(f.state, 'utf8'));
    assert.equal(after.title, block.title); assert.deepEqual(after.entries, block.entries.slice(10));
    fs.writeFileSync(f.temporary, f.skeleton());
    await commit({ ...f.settings, input: { followedUpIds: [] } }, f.deps);
    assert.deepEqual(extractAbsorbedBlock(fs.readFileSync(f.state, 'utf8')), after);
  }
});

test('IB51 cleanup deletion failure is a failed step, not a successful cleanup', async t => {
  const f = await fixture(t); write(f);
  fs.writeFileSync(f.state, fs.readFileSync(f.temporary, 'utf8'));
  const target = path.join(f.memoryDir, `inbox.${segment}.md`);
  fs.unlinkSync(target); fs.mkdirSync(target);
  await assert.rejects(cleanup(f.settings, f.deps));
  assert.equal(fs.existsSync(target), true);
});

// IB48/IB51: renderer and extractor share line syntax; retained block is first.
test('IB48 round trip and IB51 model Pending text preserve the exact retained document', async t => {
  const f = await fixture(t), original = write(f, [1, 2, 3]);
  const block = extractAbsorbedBlock(original);
  assert.equal(block.entries.length, 3);
  assert.equal(block.title + block.entries.map(entry => entry.raw).join(''), original.split('## Pending\n\n')[1].split('\n## Commitments')[0]);
  const temporary = f.skeleton().replace('## Pending\n', '## Pending\n\n- model task\n');
  fs.writeFileSync(f.temporary, temporary);
  await commit({ ...f.settings, input: { followedUpIds: [1] } }, f.deps);
  const expected = temporary.replace('- model task', block.title + block.entries.slice(1).map(entry => entry.raw).join('') + '- model task');
  assert.equal(fs.readFileSync(f.state, 'utf8'), expected);
});
