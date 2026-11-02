import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractAbsorbedBlock } from '../sync-files.js';
import { renderStateSkeleton } from '../state-format.js';
import { createFixture, createToolExecutor, runDriver, assertPreserved, assertSuccessfulSync,
  assertFailureFlow, assertRotationFlow, prepareAcquireFault, provenIds } from './fixtures/model-harness.js';

// These default tests calibrate fixtures, transport and observers. They are not
// real-model acceptance and do not emulate the Sync algorithm.
test('integration observer detects exact-line, title and outbound-evidence regressions', t => {
  const f = createFixture(t); f.prepareRound(1);
  const block = extractAbsorbedBlock(f.before.state);
  assert.equal(block.entries.length, 1000);
  assert.ok(block.entries.some(entry => entry.raw.includes('\\u2028')));
  assert.ok(block.entries.some(entry => entry.raw.includes('截断')));
  const remaining = block.entries.filter(entry => !provenIds.includes(entry.id));
  const shell = renderStateSkeleton({ scope: f.scope, syncedAt: '2026-10-20T09:00:00Z' });
  const good = shell.replace('## Pending\n\n', '## Pending\n\n' + block.title + remaining.map(entry => entry.raw).join(''));
  assertPreserved(f.before.state, good, provenIds);
  assert.equal(extractAbsorbedBlock(good).entries.length, 990);
  const mutate = (title, entries) => shell.replace('## Pending\n\n', '## Pending\n\n' + title + entries.join(''));
  const raw = remaining.map(entry => entry.raw);
  const mutants = {
    summarize: mutate(block.title, ['- 990 prior requests remain pending.\n']),
    lengthDeletion: mutate(block.title, raw.slice(1)),
    rewrite: mutate(block.title, raw.map((line, i) => i === 0 ? line.replace('Please', 'Kindly') : line)),
    retruncate: mutate(block.title, raw.map((line, i) => i === 2 ? line.slice(0, 70) + '…\n' : line)),
    recalculateTitle: mutate(block.title.replace('共 1000 条', '共 990 条'), raw),
    prematureTitleDeletion: mutate('', raw),
    outboundIsCompletion: mutate(block.title, remaining.filter(entry => entry.id !== 11).map(entry => entry.raw)),
    failedSendIsCompletion: mutate(block.title, remaining.filter(entry => entry.id !== 12).map(entry => entry.raw)),
  };
  for (const [name, result] of Object.entries(mutants)) assert.throws(() => assertPreserved(f.before.state, result, provenIds), { name: 'AssertionError' }, name);
  assertPreserved(good, good, []);
  assertPreserved(good, shell, remaining.map(entry => entry.id));
});

test('integration fixture binds real CLI and restricted stdio MCP to an isolated scope', async t => {
  const f = createFixture(t); f.prepareRound(1);
  const executor = await createToolExecutor(f); t.after(executor.close);
  const acquire = await executor.execute({ name: 'run_script', arguments: { script: 'sync-lock', args: ['acquire', '--kind', 'group'] } });
  assert.equal(acquire.status, 0, acquire.stderr);
  const token = acquire.stdout.trim(); assert.match(token, /^[a-f0-9]{32}$/);
  const range = await executor.execute({ name: 'run_script', arguments: { script: 'c4-db', args: ['unsummarized', '--group', f.scope, '--json'] } });
  assert.equal(range.status, 0, range.stderr); assert.equal(JSON.parse(range.stdout).data.count, 12);
  const denied = await executor.execute({ name: 'edit_memory', arguments: { op: 'edit', path: 'identity.md', expected: 'Finch', replacement: 'Other', token } });
  assert.equal(denied.code, 'PATH_NOT_ALLOWED');
  const created = await executor.execute({ name: 'edit_memory', arguments: { op: 'create', path: `session-groups/${f.scope}/state.md.${token}.tmp`, replacement: renderStateSkeleton({ scope: f.scope, syncedAt: '2026-10-20T09:00:00Z' }), token } });
  assert.equal(created.ok, true, JSON.stringify(created)); assert.equal(created.rpc.result.isError, false);
  const released = await executor.execute({ name: 'run_script', arguments: { script: 'sync-lock', args: ['release', '--kind', 'group', '--token', token] } });
  assert.equal(released.status, 0, released.stderr);
  assert.equal(f.snapshot().stateHash, f.before.stateHash, 'Transport smoke does not publish state');
  assert.equal(f.snapshot().rowsHash, f.before.rowsHash);
});

test('JSONL transport records real results without executing a stub Sync procedure', async t => {
  const f = createFixture(t); f.prepareRound(1);
  const result = await runDriver(f, 'transport-only', { executable: process.execPath, args: [fileURLToPath(new URL('./fixtures/transport-driver.js', import.meta.url))], timeoutMs: 15000 });
  assert.equal(result.trace.length, 1); assert.equal(result.final.modelCalls, 0);
  assert.equal(result.trace[0].request.name, 'read_file');
  assert.equal(result.snapshot.stateHash, f.before.stateHash);
  assert.ok(fs.existsSync(path.join(result.evidenceDir, 'trace.jsonl')));
});

const driver = process.env.MODEL_WORKFLOW_DRIVER;
const selected = new Set((process.env.MODEL_WORKFLOW_CASES || '').split(',').filter(Boolean));
const live = (id, action) => test(`real model: ${id}`, {
  skip: !driver ? 'MODEL_WORKFLOW_DRIVER is absent: real-model acceptance NOT RUN' : selected.size && !selected.has(id) ? 'Not selected' : false,
  timeout: 1900000,
}, action);

// §4: same fixture and real committed state through all three rounds.
for (const [id, scope] of [['group-followup', 'model-workflow'], ['origin-group-followup', 'origin'], ['global-followup', '*']]) {
  live(id, async t => {
    const f = createFixture(t, { scope });
    for (let round = 1; round <= 3; round++) {
      f.prepareRound(round);
      const result = await runDriver(f, `${id}-round${round}`);
      const expected = round === 1 ? provenIds : round === 2 ? [] : extractAbsorbedBlock(f.before.state).entries.map(entry => entry.id);
      assertSuccessfulSync(f, result, expected);
      assert.equal(extractAbsorbedBlock(result.snapshot.state).entries.length, round === 3 ? 0 : 990);
      t.diagnostic(`${id}-round${round}: ${result.evidenceDir}; ${result.trace.length} tool calls; model=${result.final.model || 'unspecified'}; modelCalls=${result.final.modelCalls ?? 'unspecified'}`);
    }
  });
}

// §4: model continues or stops after the actual tool result. Injections
// are boundary faults, while guarded commit and marker operations remain real.
for (const fault of ['copy-block', 'formal-bad-header', 'temporary-bad-header', 'temporary-missing-section', 'unknown-id', 'read-failure', 'token-mismatch', 'busy', 'acquire-failure', 'release-failure']) {
  live(`group-${fault}`, async t => {
    const f = createFixture(t, { fault }); f.prepareRound(1); prepareAcquireFault(f, fault);
    const result = await runDriver(f, `group-${fault}`);
    if (['copy-block', 'formal-bad-header', 'release-failure'].includes(fault)) {
      assertSuccessfulSync(f, result, provenIds, { copied: fault === 'copy-block' });
      if (fault === 'release-failure') {
        assert.match(result.final.text, /release|释放/i); assert.match(result.final.text, /fail|warning|失败|警告/i);
        assert.match(result.final.text, /commit|committed|submitted|success|提交|成功/i);
      }
    } else assertFailureFlow(f, result, fault);
    t.diagnostic(`${result.evidenceDir}; ${result.trace.length} tool calls`);
  });
}

// / §4: true identity edit followed by rejected rotation, with
// continued progress and a truthful final report. Origin's group Pending stays.
for (const kind of ['origin', 'global']) {
  for (const fault of ['rotation-transition', 'rotation-enqueue']) {
    live(`${kind}-${fault}`, async t => {
      const f = createFixture(t, { scope: kind === 'origin' ? 'origin' : '*', kind, fault });
      const result = await runDriver(f, `${kind}-${fault}`);
      assertRotationFlow(f, result);
      t.diagnostic(`${result.evidenceDir}; ${result.trace.length} tool calls`);
    });
  }
}
