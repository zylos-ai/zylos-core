import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { completeUpgradeFinalization } from '../self-upgrade.js';
import { updateZylosConfigLocked } from '../config.js';
import { detectConfigLockCapability, updateConfigWithLock } from '../config-lock.js';
import { updateConfigStore } from '../config-store.js';

function fixture(t, config = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-callers-'));
  const configFile = path.join(root, '.zylos/config.json');
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify(config) + '\n');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const ctx = { zylosDir: root, from: 'old', to: 'new', steps: [], mergedFiles: [], mergeConflicts: [] };
  const journal = { phase: 'compensation_closed' };
  Object.assign(ctx, {
    preInstallProtection: true,
    transactionDir: path.join(root, 'transaction'),
    journal,
    maintenance: {
      canRecognizeProcesses: () => true,
      transaction: () => journal,
      classifyCutoff: () => 'closed',
      stop: () => {},
      update: (_dir, current, changes) => Object.assign(current, changes),
    },
  });
  let now = 0;
  const budget = {
    deadlineAt: 10000,
    remaining: () => budget.deadlineAt - now,
    check() {
      if (budget.remaining() <= 0) throw Object.assign(Error('budget exhausted'), { code: 'deadline_exceeded' });
    },
  };
  ctx.budget = budget;
  const deps = {
    budget,
    ensureMemoryMigration: () => { calls.push('ensure'); },
    commitBaselines: () => { calls.push('baselines'); },
    refreshMaintenanceReader: () => {},
    protectedSuccess: () => {},
    startServices: () => { calls.push('start'); },
    verifyServices: () => { calls.push('verify'); },
    dashboardOwner: { verifyDashboard: () => ({ state: 'ready', errors: [] }) },
    readModeStatus: () => ({ sessionMode: null, transition: null }),
    readMode: () => ({ mode: null, keyPresent: false }),
    readTransition: () => null,
    restart: async options => {
      calls.push('restart');
      assert.equal(Object.hasOwn(options,'deadlineAt'),false);
      return { ok: true, data: { result: 'exit_enqueued' } };
    },
    audit: () => { calls.push('audit'); return []; },
  };
  return { ctx, deps, calls, configFile, read: () => JSON.parse(fs.readFileSync(configFile, 'utf8')), advance: ms => { now += ms; } };
}

test('F1 actual caller preserves a preexisting threshold and inserts the other default', async t => {
  const f = fixture(t, { new_session_threshold: 30, user: 'preserved' });
  const result = await completeUpgradeFinalization(f.ctx, f.deps);
  assert.equal(result.success, true);
  assert.deepEqual(f.read(), { new_session_threshold: 30, codex_new_session_threshold: 75, user: 'preserved' });
  assert.ok(f.calls.includes('start'));
});

test('F1 actual caller inserts both defaults when absent', async t => {
  const f = fixture(t);
  assert.equal((await completeUpgradeFinalization(f.ctx, f.deps)).success, true);
  assert.deepEqual(f.read(), { new_session_threshold: 70, codex_new_session_threshold: 75 });
});

test('F1 actual caller rejects malformed config before starting services', async t => {
  const f = fixture(t);
  const malformed = '{unparseable';
  fs.writeFileSync(f.configFile, malformed);
  const result = await completeUpgradeFinalization(f.ctx, f.deps);
  assert.equal(result.success, false);
  assert.equal(result.failedStep, 4);
  assert.deepEqual(f.calls, []);
  assert.equal(fs.readFileSync(f.configFile, 'utf8'), malformed);
});

test('F1 actual caller waits its fixed 2000ms for a real busy lock and never starts services', { timeout: 10000 }, async t => {
  if (!detectConfigLockCapability()) return t.skip('real config lock backend unavailable');
  const f = fixture(t, { new_session_threshold: 30 });
  const holder = spawn(process.execPath, [new URL('./fixtures/f1-worker.js', import.meta.url).pathname,
    JSON.stringify({ configFile: f.configFile, lockFile: `${f.configFile}.lock`, update: { set: { holder: true } }, holdMs: 2600 })],
  { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', stderr = '';
  holder.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise((resolve, reject) => {
    holder.once('error', reject);
    holder.once('close', code => resolve(code));
  });
  t.after(async () => { if (holder.exitCode === null) holder.kill(); await exited; });
  await Promise.race([
    new Promise(resolve => holder.stdout.on('data', chunk => {
      output += chunk;
      if (output.includes('F1_LOCK_READY\n')) resolve();
    })),
    exited.then(() => { throw Error(`lock holder exited before readiness: ${stderr}`); }),
  ]);
  const started = performance.now();
  const result = await completeUpgradeFinalization(f.ctx, f.deps);
  const elapsed = performance.now() - started;
  assert.equal(result.success, false);
  assert.equal(result.failedStep, 4);
  assert.match(result.error, /Timed out waiting for the config lock/);
  assert.ok(elapsed >= 1850, `elapsed=${elapsed}ms`);
  assert.deepEqual(f.calls, []);
  assert.equal(await exited, 0, stderr);
  assert.deepEqual(f.read(), { new_session_threshold: 30, holder: true });
});

test('F1 controlled after-rename failure preserves committed defaults and invokes protected service isolation', async t => {
  const f = fixture(t, { new_session_threshold: 30 });
  const journal = { phase: 'compensation_closed' };
  Object.assign(f.ctx, {
    preInstallProtection: true,
    transactionDir: path.join(f.ctx.zylosDir, 'transaction'),
    maintenance: {
      canRecognizeProcesses: () => true,
      transaction: () => journal,
      classifyCutoff: () => 'closed',
      stop: () => { f.calls.push('stop'); },
      update: (_dir, current, changes) => Object.assign(current, changes),
    },
  });
  let observed;
  // Keep the real atomic writer; inject directory fsync failure through its supported seam.
  f.deps.updateConfig = (update, options) => updateConfigWithLock({ ...options, update }, {
    capability: null,
    writeStderr: () => {},
    fallbackStore: (file, input) => {
      let fsyncs = 0;
      try {
        return updateConfigStore(file, input, { fsyncSync(fd) {
          if (++fsyncs === 2) throw Error('controlled directory fsync failure');
          fs.fsyncSync(fd);
        } });
      } catch (error) { observed = error; throw error; }
    },
  });
  const result = await completeUpgradeFinalization(f.ctx, f.deps);
  assert.equal(result.success, false);
  assert.equal(result.failedStep, 4);
  assert.equal(observed.code, 'CONFIG_WRITE_FAILED');
  assert.equal(observed.phase, 'after_rename');
  assert.equal(observed.persisted, null);
  assert.deepEqual(f.read(), { new_session_threshold: 30, codex_new_session_threshold: 75 });
  assert.deepEqual(f.calls, ['stop']);
  assert.equal(result.recovery_required, true);
  assert.equal(journal.phase, 'recovery_required');
  assert.equal(journal.resumePhase, 'compensation_closed');
});

test('F1 controlled before-rename failure leaves original config and prevents subsequent actions', async t => {
  const f = fixture(t, { new_session_threshold: 30 });
  let observed;
  f.deps.updateConfig = (update, options) => updateConfigWithLock({ ...options, update }, {
    capability: null,
    writeStderr: () => {},
    fallbackStore: (file, input) => {
      try {
        return updateConfigStore(file, input, { renameSync() { throw Error('controlled rename failure'); } });
      } catch (error) { observed = error; throw error; }
    },
  });
  const result = await completeUpgradeFinalization(f.ctx, f.deps);
  assert.equal(result.success, false);
  assert.equal(result.failedStep, 4);
  assert.equal(observed.code, 'CONFIG_WRITE_FAILED');
  assert.equal(observed.phase, 'before_rename');
  assert.deepEqual(observed.persisted, []);
  assert.deepEqual(f.read(), { new_session_threshold: 30 });
  assert.deepEqual(f.calls, []);
});

test('obsolete overall deadline cannot prevent the first F1 caller action', async t => {
  const f = fixture(t);
  f.advance(10000);
  const result = await completeUpgradeFinalization(f.ctx, f.deps);
  assert.equal(result.success, true);
  assert.deepEqual(f.read(), { new_session_threshold: 70, codex_new_session_threshold: 75 });
  assert.equal(f.calls.includes('start'),true);
});

test('F1 lock window is independent and later steps continue after an obsolete deadline', async t => {
  const f = fixture(t);
  f.advance(9000);
  f.deps.updateConfig = (update, options) => {
    assert.equal(options.waitMs, 2000);
    assert.equal(Object.hasOwn(options, 'deadlineAt'), false);
    f.advance(2000);
    return updateZylosConfigLocked(update, options);
  };
  const result = await completeUpgradeFinalization(f.ctx, f.deps);
  assert.equal(result.success, true);
  assert.deepEqual(f.read(), { new_session_threshold: 70, codex_new_session_threshold: 75 });
  assert.equal(f.calls.includes('start'),true);
});

test('transition read uses ordinary DB limits and cannot exhaust a shared finalization deadline', async t => {
  const f = fixture(t);
  let readFinished = false;
  f.deps.readMode = () => { f.advance(9000); return { mode: 'single', keyPresent: true }; };
  f.deps.readTransition = (...args) => {
    assert.deepEqual(args, []);
    assert.equal(f.deps.budget.remaining(), 1000);
    f.advance(2000);
    readFinished = true;
    return null;
  };
  const result = await completeUpgradeFinalization(f.ctx, f.deps);
  assert.equal(readFinished, true);
  assert.equal(result.success, true);
  assert.equal(result.completion.sessionRestart, 'single_exit_enqueued');
  assert.equal(result.checkpointAudit.state, 'complete');
  assert.equal(f.calls.includes('restart'), true);
  assert.equal(f.calls.includes('audit'), true);
  assert.equal(f.deps.budget.deadlineAt, 10000);
});

test('controlled audit read started with 1s left returns its real result after 2s without refreshing budget', async t => {
  const f = fixture(t);
  const findings = [{ code: 'CHECKPOINT_WARNING' }];
  f.deps.restart = () => { f.advance(9000); return { ok: true, data: { result: 'exit_enqueued' } }; };
  f.deps.audit = (...args) => {
    assert.deepEqual(args, []);
    assert.equal(f.deps.budget.remaining(), 1000);
    f.advance(2000);
    return findings;
  };
  const result = await completeUpgradeFinalization(f.ctx, f.deps);
  assert.equal(result.success, true);
  assert.deepEqual(result.checkpointAudit, { state: 'complete', items: findings });
  assert.equal(f.deps.budget.remaining(), -1000);
  assert.equal(f.deps.budget.deadlineAt, 10000);
});

for (const read of ['readMode', 'readTransition']) {
  for (const code of ['DB_BUSY', 'READ_FAILED']) test(`${read} ${code} prevents restart fallback and audit error stays incomplete`, async t => {
    const f = fixture(t);
    f.deps[read] = () => { throw Object.assign(Error(`${read} ${code}`), { code }); };
    f.deps.audit = () => { throw Object.assign(Error(`audit ${code}`), { code }); };
    const result = await completeUpgradeFinalization(f.ctx, f.deps);
    assert.equal(result.success, true);
    assert.equal(result.completion.sessionRestart, 'manual_required');
    assert.equal(result.sessionRestart.error.code, code);
    assert.equal(f.calls.includes('restart'), false);
    assert.equal(result.checkpointAudit.state, 'incomplete');
    assert.match(result.checkpointAudit.error, new RegExp(code));
    assert.equal(Object.hasOwn(result.checkpointAudit, 'items'), false);
  });
}
