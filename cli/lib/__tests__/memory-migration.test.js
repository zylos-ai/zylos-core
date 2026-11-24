import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createMigration, backupState } from '../../../skills/zylos-memory/scripts/memory-migration.js';
import { withMemoryLock } from '../../../skills/zylos-memory/scripts/sync-lock.js';
import { readyTmuxTarget } from '../../../test/helpers/ready-tmux-target.js';

const coreModule = new URL('../memory-migration.js', import.meta.url).href;
const cliScript = fileURLToPath(new URL('../../../skills/zylos-memory/scripts/memory-migration.js', import.meta.url));
function childResult(child, input = '') {
  return new Promise((resolve, reject) => {
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => { stdout += bytes; });
    child.stderr.on('data', bytes => { stderr += bytes; });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
    child.stdin.end(input);
  });
}



function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-control-migration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const memory = path.join(root, 'memory'); fs.mkdirSync(memory);
  const references = path.join(memory, 'references.md'); fs.writeFileSync(references, 'original marker\n');
  const env = { ...process.env, ZYLOS_DIR: root, ZYLOS_SESSION_GROUP: 'origin', ZYLOS_RUN_ID: 'run1' };
  const live = { present: true, ready: true, runId: 'run1', f3: { runId: 'run1' }, rawF2: { ZYLOS_SESSION_GROUP: 'origin' } };
  const settings = { env, readMode: () => ({ mode: 'multi' }), readTransition: () => null, observe: () => live, ...overrides };
  const service = createMigration(settings);
  const record = path.join(root, '.zylos/migrations/references-layout-v1.json');
  const backup = path.join(root, '.zylos/migrations/references-layout-v1.backup');
  return { root, memory, references, env, live, service, settings, record, backup };
}
const init = f => f.service.ensure({ createdBy: 'upgrade' });
const patch = { path: 'references.md', expected: 'original marker', replacement: 'new marker' };


test('backup readback rejects corrupted staging bytes before publication and reentry preserves original', async t => {
  const f = fixture(t); init(f); const before = fs.readFileSync(f.record);
  const service = createMigration({ ...f.settings, checkpoint: point => {
    if (point === 'backup:copied') {
      const parent = path.dirname(f.backup);
      const staging = fs.readdirSync(parent).find(name => name.startsWith('references-layout-v1.backup.staging-'));
      assert.ok(staging);
      fs.writeFileSync(path.join(parent, staging, 'references.md'), 'corrupted backup bytes');
    }
  } });
  await assert.rejects(service.apply(patch), { code: 'BACKUP_WRITE_FAILED', message: 'Backup readback differs', persisted: [] });
  assert.equal(backupState(f.backup), 'absent'); assert.deepEqual(fs.readFileSync(f.record), before);
  assert.equal(fs.readFileSync(f.references, 'utf8'), 'original marker\n');
  await f.service.apply(patch);
  assert.equal(fs.readFileSync(path.join(f.backup, 'references.md'), 'utf8'), 'original marker\n');
});

test('ensure preserves records, status is read-only, fresh install mechanically checked', t => {
  const f = fixture(t); assert.deepEqual(f.service.status(), { state: 'absent' });
  assert.equal(init(f).state, 'pending'); const original = fs.readFileSync(f.record);
  f.service.ensure({ createdBy: 'init', freshInstall: true }); assert.deepEqual(fs.readFileSync(f.record), original);
  fs.writeFileSync(f.record, '{bad'); assert.equal(init(f).state, 'unreadable'); assert.equal(fs.readFileSync(f.record, 'utf8'), '{bad');
  const fresh = fixture(t); assert.equal(fresh.service.ensure({ createdBy: 'init', freshInstall: true }).state, 'done');
  assert.equal(JSON.parse(fs.readFileSync(fresh.record)).evidence.kind, 'fresh_install');
  const missing = fixture(t); fs.writeFileSync(missing.references, '`reference/missing.md`');
  assert.equal(missing.service.ensure({ createdBy: 'init', freshInstall: true }).state, 'pending');
});

test('apply backs up exact initial bytes, reuses backup, complete cannot regress', async t => {
  const f = fixture(t); init(f);
  assert.equal((await f.service.apply(patch)).backupCreated, true);
  assert.equal(fs.readFileSync(path.join(f.backup, 'references.md'), 'utf8'), 'original marker\n');
  const inode = fs.statSync(path.join(f.backup, 'references.md')).ino;
  await f.service.apply({ ...patch, expected: 'new marker', replacement: 'last marker' });
  assert.equal(fs.statSync(path.join(f.backup, 'references.md')).ino, inode);
  assert.equal(fs.readFileSync(path.join(f.backup, 'references.md'), 'utf8'), 'original marker\n');
  assert.equal(f.service.status().state, 'pending');
  await f.service.complete('Moved history into topics');
  assert.equal(f.service.status().state, 'done');
  await assert.rejects(f.service.apply(patch), { code: 'MIGRATION_DONE', persisted: [] });
  await assert.rejects(f.service.complete('again'), { code: 'ALREADY_DONE', persisted: [] });
  const record = JSON.parse(fs.readFileSync(f.record));
  assert.equal(record.evidence.agent.runId, 'run1'); assert.equal(record.attempts, 1);
});

test('native single-session Origin can apply and complete the references migration', async t => {
  const f = fixture(t, { readMode: () => ({ mode: 'single' }) });
  init(f);
  await f.service.apply(patch);
  assert.equal(fs.readFileSync(f.references, 'utf8'), 'new marker\n');
  await f.service.complete('Moved history into topics');
  assert.equal(f.service.status().state, 'done');
});

test('authorization priority, stale runs, modes, transitions, and ordinary groups reject without writes', async t => {
  const f = fixture(t); init(f); const bytes = fs.readFileSync(f.record);
  const cases = [
    [{ readMode: () => { throw Error('bad F1'); } }, 'MODE_UNAVAILABLE'],
    [{ readTransition: () => ({ phase: 'gating' }) }, 'MODE_UNAVAILABLE'],
    [{ env: { ...f.env, ZYLOS_SESSION_GROUP: 'lark:other' } }, 'NOT_MAIN_SESSION'],
    [{ env: { ...f.env, ZYLOS_RUN_ID: 'old' } }, 'RUN_MISMATCH'],
    [{ observe: () => ({ ...f.live, ready: false }) }, 'RUN_MISMATCH'],
    [{ observe: () => ({ present: false }) }, 'RUN_MISMATCH'],
    [{ observe: () => ({ ...f.live, rawF2: {} }) }, 'NOT_MAIN_SESSION'],
  ];
  for (const [override, code] of cases) {
    const service = createMigration({ ...f.settings, ...override });
    await assert.rejects(service.apply(patch), { code, persisted: [] });
    await assert.rejects(service.complete('reviewed'), { code, persisted: [] });
    assert.deepEqual(fs.readFileSync(f.record), bytes); assert.equal(backupState(f.backup), 'absent');
  }
  fs.writeFileSync(f.record, '{}');
  await assert.rejects(createMigration({ ...f.settings, readMode: () => { throw Error(); } }).apply(patch), { code: 'RECORD_UNREADABLE' });
});

test('lock serializes complete and apply; identity is sampled inside held lock', async t => {
  const f = fixture(t); init(f); await f.service.apply(patch);
  let release; const barrier = new Promise(resolve => { release = resolve; });
  let entered; const entering = new Promise(resolve => { entered = resolve; });
  const holder = withMemoryLock(path.join(f.root, 'activity-monitor/session-groups/origin'), async () => { entered(); await barrier; });
  await entering;
  const pending = f.service.apply({ ...patch, expected: 'new marker' });
  f.live.runId = 'replacement'; release(); await holder;
  await assert.rejects(pending, { code: 'RUN_MISMATCH' });
  f.live.runId = 'run1';
  let finishComplete, completeEntered;
  const completionBarrier = new Promise(resolve => { finishComplete = resolve; });
  const completing = new Promise(resolve => { completeEntered = resolve; });
  const completingService = createMigration({ ...f.settings, observe: async () => {
    completeEntered();
    await completionBarrier;
    return f.live;
  } });
  const complete = completingService.complete('reviewed');
  await completing;
  // Authorization runs inside the real kernel lock; keep it held while apply contends.
  try {
    await assert.rejects(f.service.apply({ ...patch, expected: 'new marker' }, { waitMs: 20 }), { code: 'LOCK_TIMEOUT' });
    assert.equal(f.service.status().state, 'pending');
    assert.equal(fs.readFileSync(f.references, 'utf8'), 'new marker\n');
  } finally { finishComplete(); }
  const apply = f.service.apply({ ...patch, expected: 'new marker' });
  await complete; await assert.rejects(apply, { code: 'MIGRATION_DONE' });
});

test('real process death at backup and commit stages is recoverable without changing the first backup', async t => {
  for (const stage of ['backup:started', 'backup:copied', 'backup:verified', 'backup:before-publish',
    'backup:after-publish', 'target:before-publish', 'target:after-publish', 'record:before-publish']) {
    const f = fixture(t); init(f);
    if (stage === 'record:before-publish') await f.service.apply(patch);
    const script = `
      import {createMigration} from ${JSON.stringify(coreModule)};
      const service=createMigration({env:{...process.env,ZYLOS_DIR:${JSON.stringify(f.root)},ZYLOS_SESSION_GROUP:'origin',ZYLOS_RUN_ID:'run1'},
        readMode:()=>({mode:'multi'}),readTransition:()=>null,observe:()=>(${JSON.stringify(f.live)}),
        checkpoint:point=>{if(point===${JSON.stringify(stage)})process.kill(process.pid,'SIGKILL');}});
      await service.${stage === 'record:before-publish' ? "complete('verified')" : `apply(${JSON.stringify(patch)})`};
    `;
    const result = await childResult(spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['pipe', 'pipe', 'pipe'] }));
    assert.equal(result.signal, 'SIGKILL', `${stage}: ${result.stderr}`);
    assert.equal(f.service.status().state, 'pending');
    if (stage !== 'target:after-publish' && stage !== 'record:before-publish') {
      assert.equal(fs.readFileSync(f.references, 'utf8'), 'original marker\n');
    }
    assert.ok(['absent', 'valid'].includes(backupState(f.backup)));
    const originalInode = backupState(f.backup) === 'valid' ? fs.statSync(path.join(f.backup, 'references.md')).ino : null;
    if (stage !== 'target:after-publish' && stage !== 'record:before-publish') await f.service.apply(patch);
    await f.service.complete('Recovered after process death');
    assert.equal(fs.readFileSync(path.join(f.backup, 'references.md'), 'utf8'), 'original marker\n');
    if (originalInode !== null) assert.equal(fs.statSync(path.join(f.backup, 'references.md')).ino, originalInode);
    assert.equal(f.service.status().state, 'done');
  }
});

test('real isolated tmux F2 and F3 authorize current main and reject stale or ordinary group callers', async t => {
  const target = readyTmuxTarget(t, { prefix: 'runtime-control-migrate-', mode: 'multi' });
  const memory = path.join(target.root, 'memory'); fs.mkdirSync(memory);
  const references = path.join(memory, 'references.md'); fs.writeFileSync(references, 'original marker\n');
  const env = { ...target.env, ZYLOS_SESSION_GROUP: 'origin', ZYLOS_RUN_ID: target.ready.runId,
    ZYLOS_PACKAGE_ROOT: fileURLToPath(new URL('../../../', import.meta.url)) };
  const run = (args, input = '', override = {}) => childResult(spawn(process.execPath, [cliScript, ...args],
    { env: { ...env, ...override }, stdio: ['pipe', 'pipe', 'pipe'] }), input);
  const id = ['--id', 'references-layout-v1', '--json'];
  assert.equal((await run(['ensure', ...id, '--created-by', 'upgrade'])).code, 0);
  const runDir = path.join(target.root, 'activity-monitor/session-groups/origin');
  let release, entered;
  const barrier = new Promise(resolve => { release = resolve; });
  const entering = new Promise(resolve => { entered = resolve; });
  const holder = withMemoryLock(runDir, async () => { entered(); await barrier; }); await entering;
  const record = path.join(target.root, '.zylos/migrations/references-layout-v1.json');
  const recordBytes = fs.readFileSync(record);
  try {
    await Promise.all(['apply', 'complete'].flatMap(command => [false, true].map(async json => {
      const result = await run([command, '--id', 'references-layout-v1', ...(json ? ['--json'] : []),
        ...(command === 'complete' ? ['--summary', '-'] : [])], command === 'apply' ? JSON.stringify(patch) : 'reviewed');
      assert.equal(result.code, 2, `${command}: ${result.stdout} ${result.stderr}`);
      if (json) {
        const envelope = JSON.parse(result.stdout);
        assert.equal(envelope.error.code, 'LOCK_TIMEOUT'); assert.deepEqual(envelope.error.persisted, []);
        assert.equal(result.stderr, '');
      } else {
        assert.equal(result.stdout, ''); assert.match(result.stderr, /^Error \[LOCK_TIMEOUT\]: /);
      }
    })));
    assert.deepEqual(fs.readFileSync(record), recordBytes);
    assert.equal(fs.readFileSync(references, 'utf8'), 'original marker\n');
    assert.equal(backupState(path.join(target.root, '.zylos/migrations/references-layout-v1.backup')), 'absent');
  } finally { release(); await holder; }
  for (const [override, expected] of [[{ ZYLOS_SESSION_GROUP: 'other' }, 'NOT_MAIN_SESSION'],
    [{ ZYLOS_RUN_ID: 'stale' }, 'RUN_MISMATCH']]) {
    const result = await run(['apply', ...id], JSON.stringify(patch), override);
    assert.equal(JSON.parse(result.stdout).error.code, expected, result.stderr);
    assert.equal(fs.readFileSync(references, 'utf8'), 'original marker\n');
  }
  for (const json of [false, true]) {
    const conflict = await run(['apply', '--id', 'references-layout-v1', ...(json ? ['--json'] : [])], JSON.stringify({ ...patch, expected: 'missing' }));
    assert.equal(conflict.code, 4, conflict.stderr);
    if (json) assert.deepEqual(JSON.parse(conflict.stdout).error.persisted, []);
    else { assert.equal(conflict.stdout, ''); assert.match(conflict.stderr, /^Error \[FRAGMENT_CONFLICT\]: /); }
  }
  assert.equal(fs.readFileSync(references, 'utf8'), 'original marker\n');
  const applied = await run(['apply', '--id', 'references-layout-v1'], JSON.stringify(patch));
  assert.equal(applied.code, 0, `${applied.stdout} ${applied.stderr}`);
  assert.match(applied.stdout, /^OK: /); assert.equal(applied.stderr, '');
  fs.writeFileSync(target.readyPath, JSON.stringify({ ...target.ready, runId: 'replaced' }));
  const stale = await run(['complete', ...id, '--summary', '-'], 'verified');
  assert.equal(JSON.parse(stale.stdout).error.code, 'RUN_MISMATCH', stale.stderr);
  fs.writeFileSync(target.readyPath, JSON.stringify(target.ready));
  const completed = await run(['complete', '--id', 'references-layout-v1', '--summary', '-'], 'verified');
  assert.equal(completed.code, 0, `${completed.stdout} ${completed.stderr}`);
  assert.match(completed.stdout, /^OK: /); assert.equal(completed.stderr, '');
  const jsonTarget = readyTmuxTarget(t, { prefix: 'runtime-control-migrate-json-', mode: 'multi' });
  fs.mkdirSync(path.join(jsonTarget.root, 'memory'));
  fs.writeFileSync(path.join(jsonTarget.root, 'memory/references.md'), 'original marker\n');
  const jsonEnv = { ...jsonTarget.env, ZYLOS_SESSION_GROUP: 'origin', ZYLOS_RUN_ID: jsonTarget.ready.runId,
    ZYLOS_PACKAGE_ROOT: fileURLToPath(new URL('../../../', import.meta.url)) };
  for (const [args, input] of [[['ensure', ...id, '--created-by', 'upgrade'], ''],
    [['apply', ...id], JSON.stringify(patch)], [['complete', ...id, '--summary', '-'], 'verified']]) {
    const result = await childResult(spawn(process.execPath, [cliScript, ...args],
      { env: jsonEnv, stdio: ['pipe', 'pipe', 'pipe'] }), input);
    assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).ok, true);
    assert.equal(result.stdout.trim().split('\n').length, 1); assert.equal(result.stderr, '');
  }
});
