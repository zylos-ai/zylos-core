import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
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

function lockChildren() {
  return execFileSync('ps', ['-axo', 'pid=,ppid=,args='], { encoding: 'utf8' }).split('\n')
    .map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/))
    .filter(row => row && Number(row[2]) === process.pid && (/\bflock --exclusive\b/.test(row[3]) || row[3].includes('perl -e')))
    .map(row => Number(row[1])).sort((a, b) => a - b);
}

async function timeoutWithoutWaiter(operation) {
  const before = lockChildren();
  try {
    await assert.rejects(operation(), { code: 'LOCK_TIMEOUT' });
    assert.deepEqual(lockChildren().filter(pid => !before.includes(pid)), [], 'LOCK_TIMEOUT left a live waiter');
  } finally {
    const extra = lockChildren().filter(pid => !before.includes(pid));
    for (const pid of extra) {
      try { process.kill(pid, 'SIGKILL'); } catch (cause) { if (cause.code !== 'ESRCH') throw cause; }
    }
    for (let i = 0; i < 100 && lockChildren().some(pid => extra.includes(pid)); i++) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(lockChildren().some(pid => extra.includes(pid)), false, 'Test waiter cleanup failed');
  }
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

function cliFixture(t) {
  const target = readyTmuxTarget(t, { prefix: 'runtime-control-migrate-detail-', mode: 'multi' });
  const references = path.join(target.root, 'memory/references.md');
  fs.mkdirSync(path.dirname(references), { recursive: true });
  fs.writeFileSync(references, 'original marker\n');
  const env = { ...target.env, ZYLOS_SESSION_GROUP: 'origin', ZYLOS_RUN_ID: target.ready.runId,
    ZYLOS_PACKAGE_ROOT: fileURLToPath(new URL('../../../', import.meta.url)) };
  const run = (args, input = '') => childResult(spawn(process.execPath, [cliScript, ...args],
    { env, stdio: ['pipe', 'pipe', 'pipe'] }), input);
  return { ...target, references, run,
    record: path.join(target.root, '.zylos/migrations/references-layout-v1.json'),
    backup: path.join(target.root, '.zylos/migrations/references-layout-v1.backup') };
}

test('CLI text CHECK_FAILED reports every missing path and leaves completion pending', async t => {
  const f = cliFixture(t), id = ['--id', 'references-layout-v1'];
  assert.equal((await f.run(['ensure', ...id, '--created-by', 'upgrade'])).code, 0);
  assert.equal((await f.run(['apply', ...id], JSON.stringify({ ...patch,
    replacement: '`reference/one.md`\n`reference/two.md`' }))).code, 0);
  const result = await f.run(['complete', ...id, '--summary', '-'], 'reviewed');
  assert.equal(result.code, 1); assert.equal(result.stdout, '');
  assert.equal(result.stderr.split('\n')[0], 'Error [CHECK_FAILED]: Migration mechanical checks failed');
  assert.match(result.stderr, /^Missing path: memory\/reference\/one\.md$/m);
  assert.match(result.stderr, /^Missing path: memory\/reference\/two\.md$/m);
  const record = JSON.parse(fs.readFileSync(f.record));
  assert.equal(record.state, 'pending'); assert.equal(record.attempts, 1);
});

test('CLI text BACKUP_INVALID reports retained backup path without changing original files', async t => {
  const f = cliFixture(t), id = ['--id', 'references-layout-v1'];
  assert.equal((await f.run(['ensure', ...id, '--created-by', 'upgrade'])).code, 0);
  fs.mkdirSync(f.backup); fs.writeFileSync(path.join(f.backup, 'retained'), 'invalid backup evidence');
  const before = fs.readFileSync(f.record);
  const result = await f.run(['apply', ...id], JSON.stringify(patch));
  assert.equal(result.code, 1); assert.equal(result.stdout, '');
  assert.equal(result.stderr.split('\n')[0], 'Error [BACKUP_INVALID]: Existing references backup is invalid');
  assert.ok(result.stderr.split('\n').includes(`Backup path: ${f.backup}`));
  assert.deepEqual(fs.readFileSync(f.record), before);
  assert.equal(fs.readFileSync(f.references, 'utf8'), 'original marker\n');
  assert.equal(fs.readFileSync(path.join(f.backup, 'retained'), 'utf8'), 'invalid backup evidence');
});

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

test('W7 rejects invalid retained fields before authorization without changing the record', async t => {
  const f = fixture(t); init(f);
  const minimal = { v: 1, migrationId: 'references-layout-v1', state: 'pending', attempts: 0 };
  fs.writeFileSync(f.record, JSON.stringify(minimal));
  assert.deepEqual(f.service.status(), { state: 'pending', attempts: 0 });
  fs.writeFileSync(f.record, JSON.stringify({ ...minimal, state: 'done', attempts: 2 }));
  assert.deepEqual(f.service.status(), { state: 'done', attempts: 2 });
  const service = createMigration({ ...f.settings, readMode: () => assert.fail('invalid W7 reached authorization') });
  for (const invalid of [{ v: 2 }, { migrationId: 'other' }, { state: 'other' },
    { attempts: '21' }, { attempts: null }, { attempts: -4 }, { attempts: 1.5 }, { attempts: undefined }]) {
    const bytes = JSON.stringify({ ...minimal, ...invalid });
    fs.writeFileSync(f.record, bytes);
    assert.equal(service.status().state, 'unreadable', JSON.stringify(invalid));
    await assert.rejects(service.apply(patch), { code: 'RECORD_UNREADABLE', persisted: [] });
    await assert.rejects(service.complete('reviewed'), { code: 'RECORD_UNREADABLE', persisted: [] });
    assert.equal(fs.readFileSync(f.record, 'utf8'), bytes);
    assert.equal(backupState(f.backup), 'absent');
  }
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

test('complete ignores absent reference paths in ordinary prose', async t => {
  const f = fixture(t); init(f);
  await f.service.apply({ ...patch, replacement: 'see reference/absent.md' });
  await f.service.complete('Reviewed prose');
  assert.equal(f.service.status().state, 'done');
});

test('complete reports one missing path for prefixed and unprefixed index aliases', async t => {
  const f = fixture(t); init(f);
  await f.service.apply({ ...patch, replacement: '`reference/a.md` [alias](memory/reference/a.md)' });
  await assert.rejects(f.service.complete('Reviewed missing aliases'), e => {
    assert.equal(e.code, 'CHECK_FAILED');
    assert.deepEqual(e.missingPaths, ['memory/reference/a.md']);
    return true;
  });
});

test('complete accepts filename wildcards with a readable regular match', async t => {
  const f = fixture(t); init(f);
  fs.mkdirSync(path.join(f.memory, 'reference'));
  fs.writeFileSync(path.join(f.memory, 'reference/topic.md'), 'topic');
  await f.service.apply({ ...patch, replacement: '`memory/reference/*.md` [topics](reference/to*.md)' });
  await f.service.complete('Reviewed wildcard index');
  assert.equal(f.service.status().state, 'done');
});

test('complete reports unmatched filename wildcards verbatim', async t => {
  const f = fixture(t); init(f);
  fs.mkdirSync(path.join(f.memory, 'reference'));
  fs.writeFileSync(path.join(f.memory, 'reference/topic.txt'), 'topic');
  const indexes = ['memory/reference/*.md', 'reference/absent*.md'];
  await f.service.apply({ ...patch, replacement: '`memory/reference/*.md` [topics](reference/absent*.md)' });
  await assert.rejects(f.service.complete('Reviewed wildcard index'), e =>
    e.code === 'CHECK_FAILED' && indexes.every(value => e.missingPaths.includes(value)));
});

test('complete rejects wildcard directory segments and non-regular or unreadable matches', async t => {
  for (const kind of ['directory-star', 'directory', 'symlink', 'unreadable', 'outside']) {
    const f = fixture(t); init(f);
    const directory = path.join(f.memory, 'reference'); fs.mkdirSync(directory);
    let index = 'memory/reference/*.md';
    if (kind === 'directory-star') {
      fs.mkdirSync(path.join(directory, 'topic*'));
      fs.writeFileSync(path.join(directory, 'topic*/one.md'), 'topic');
      index = 'memory/reference/topic*/*.md';
    } else if (kind === 'directory') fs.mkdirSync(path.join(directory, 'topic.md'));
    else if (kind === 'symlink') fs.symlinkSync(f.references, path.join(directory, 'topic.md'));
    else if (kind === 'unreadable') fs.writeFileSync(path.join(directory, 'topic.md'), 'topic', { mode: 0 });
    else {
      fs.writeFileSync(path.join(f.root, 'outside.md'), 'outside');
      fs.symlinkSync(f.root, path.join(directory, 'outside'));
      index = 'memory/reference/outside/*.md';
    }
    await f.service.apply({ ...patch, replacement: `\`${index}\`` });
    await assert.rejects(f.service.complete('Reviewed wildcard edge'), e =>
      e.code === 'CHECK_FAILED' && e.missingPaths.includes(index), kind);
  }
});

test('complete treats question marks and brackets as literal filename characters', async t => {
  const f = fixture(t); init(f);
  const directory = path.join(f.memory, 'reference'); fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'topic1.md'), 'topic');
  const indexes = ['memory/reference/topic?*.md', 'memory/reference/topic[1]*.md'];
  await f.service.apply({ ...patch, replacement: indexes.map(value => `\`${value}\``).join('\n') });
  await assert.rejects(f.service.complete('Reviewed literal characters'), e =>
    e.code === 'CHECK_FAILED' && indexes.every(value => e.missingPaths.includes(value)));
  fs.writeFileSync(path.join(directory, 'topic?.md'), 'literal question mark');
  fs.writeFileSync(path.join(directory, 'topic[1].md'), 'literal brackets');
  await f.service.complete('Reviewed literal characters');
  assert.equal(f.service.status().state, 'done');
});

test('complete checks without creating backups and persists attempts only on mechanical failures', async t => {
  const f = fixture(t); init(f);
  await assert.rejects(f.service.complete('reviewed'), e => e.code === 'CHECK_FAILED' && e.persisted[0] === 'w7.attempts');
  assert.equal(backupState(f.backup), 'absent'); assert.equal(f.service.status().attempts, 1);
  await f.service.apply({ ...patch, replacement: '`reference/topic.md`' });
  await assert.rejects(f.service.complete('reviewed'), e => e.missingPaths.includes('memory/reference/topic.md'));
  fs.mkdirSync(path.join(f.memory, 'reference')); fs.writeFileSync(path.join(f.memory, 'reference/topic.md'), 'topic');
  await f.service.complete('reviewed'); assert.equal(f.service.status().attempts, 3);
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

test('single main session is accepted only with ungrouped caller and tmux environment', async t => {
  for (const mode of ['single', null]) {
    const f = fixture(t); init(f); const env = { ...f.env }; delete env.ZYLOS_SESSION_GROUP;
    const settings = { ...f.settings, env, readMode: () => ({ mode }), observe: () => ({ ...f.live, rawF2: {} }) };
    const service = createMigration(settings);
    await service.apply(patch); await service.complete('single reviewed');
    assert.equal(JSON.parse(fs.readFileSync(f.record)).evidence.agent.sessionGroup, '*');
    const rejected = fixture(t); init(rejected);
    await assert.rejects(createMigration({ ...rejected.settings, readMode: () => ({ mode }) }).apply(patch), { code: 'NOT_MAIN_SESSION' });
  }
});

test('invalid backups are retained; missing references and forbidden paths never write', async t => {
  for (const kind of ['empty', 'symlink', 'file-symlink', 'file', 'unreadable']) {
    const f = fixture(t); init(f);
    if (kind === 'symlink') fs.symlinkSync(f.memory, f.backup);
    else if (kind === 'file') fs.writeFileSync(f.backup, 'invalid');
    else {
      fs.mkdirSync(f.backup);
      if (kind === 'file-symlink') fs.symlinkSync(f.references, path.join(f.backup, 'references.md'));
      if (kind === 'unreadable') fs.writeFileSync(path.join(f.backup, 'references.md'), 'unreadable', { mode: 0 });
    }
    await assert.rejects(f.service.apply(patch), { code: 'BACKUP_INVALID', persisted: [] });
    assert.equal(fs.readFileSync(f.references, 'utf8'), 'original marker\n');
    await assert.rejects(f.service.complete('reviewed'), { code: 'CHECK_FAILED' });
  }
  const f = fixture(t); init(f);
  for (const name of ['identity.md', '../references.md', 'users/a.md', 'session-groups/a.md', '/tmp/test']) {
    await assert.rejects(f.service.apply({ ...patch, path: name }), { code: 'PATH_NOT_ALLOWED', persisted: [] });
    assert.equal(backupState(f.backup), 'absent');
  }
  fs.mkdirSync(path.join(f.memory, 'reference')); fs.symlinkSync(f.root, path.join(f.memory, 'reference/link'));
  await assert.rejects(f.service.apply({ ...patch, path: 'reference/link/out.md' }), { code: 'PATH_NOT_ALLOWED' });
  fs.unlinkSync(f.references); await assert.rejects(f.service.apply(patch), { code: 'REFERENCES_MISSING' });
});

test('fragment conflicts retain first backup and null/empty/duplicate matching is exact', async t => {
  const f = fixture(t); init(f);
  await assert.rejects(f.service.apply({ ...patch, expected: 'missing' }), { code: 'FRAGMENT_CONFLICT', persisted: ['w7.backup'] });
  await assert.rejects(f.service.apply({ ...patch, expected: '' }), { code: 'FRAGMENT_CONFLICT', persisted: [] });
  await assert.rejects(f.service.apply({ ...patch, expected: null }), { code: 'FRAGMENT_CONFLICT' });
  fs.mkdirSync(path.join(f.memory, 'reference'));
  await f.service.apply({ path: 'reference/new.md', expected: null, replacement: 'abc abc' });
  await assert.rejects(f.service.apply({ path: 'reference/new.md', expected: 'abc', replacement: 'x' }), { code: 'FRAGMENT_CONFLICT' });
  await f.service.apply({ path: 'reference/empty.md', expected: null, replacement: '' });
  await f.service.apply({ path: 'reference/empty.md', expected: '', replacement: '$&' });
  assert.equal(fs.readFileSync(path.join(f.memory, 'reference/empty.md'), 'utf8'), '$&');
});

test('backup interruption stages preserve original and reentry ignores staging files', async t => {
  for (const stage of ['backup:started', 'backup:copied', 'backup:verified', 'backup:before-publish', 'backup:after-publish']) {
    const f = fixture(t); init(f);
    const service = createMigration({ ...f.settings, checkpoint: point => { if (point === stage) throw Error('injected interruption'); } });
    await assert.rejects(service.apply(patch), e => e.code === 'BACKUP_WRITE_FAILED' && (stage.endsWith('after-publish') ? e.persisted === null : e.persisted.length === 0));
    assert.equal(fs.readFileSync(f.references, 'utf8'), 'original marker\n');
    assert.ok(['absent', 'valid'].includes(backupState(f.backup)));
    await f.service.apply(patch);
    assert.equal(fs.readFileSync(path.join(f.backup, 'references.md'), 'utf8'), 'original marker\n');
  }
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

test('bounded F8 timeout leaves no waiter and keeps inode stable', async t => {
  const f = fixture(t); init(f); const runDir = path.join(f.root, 'activity-monitor/session-groups/origin');
  let release, entered; const barrier = new Promise(r => { release = r; }); const entering = new Promise(r => { entered = r; });
  const holder = withMemoryLock(runDir, async () => { entered(); await barrier; }); await entering;
  const inode = fs.statSync(path.join(runDir, 'memory.lock')).ino;
  try {
    await timeoutWithoutWaiter(() => f.service.apply(patch, { waitMs: 20 }));
    await timeoutWithoutWaiter(() => f.service.complete('reviewed', { waitMs: 20 }));
    assert.equal(backupState(f.backup), 'absent');
  } finally { release(); await holder; }
  await withMemoryLock(runDir, async () => {});
  assert.equal(fs.statSync(path.join(runDir, 'memory.lock')).ino, inode);
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

test('installed skill uses Core discovery and rejects malformed CLI input without changing W7', async t => {
  const f = fixture(t);
  const installed = path.join(f.root, '.claude/skills');
  fs.mkdirSync(path.join(installed, 'zylos-memory/scripts'), { recursive: true });
  fs.mkdirSync(path.join(installed, 'comm-bridge/scripts'), { recursive: true });
  fs.writeFileSync(path.join(f.root, 'package.json'), '{"type":"module"}');
  const wrapper = path.join(installed, 'zylos-memory/scripts/memory-migration.js');
  fs.copyFileSync(cliScript, wrapper);
  fs.copyFileSync(path.join(path.dirname(cliScript), 'is-main-module.js'), path.join(path.dirname(wrapper), 'is-main-module.js'));
  fs.copyFileSync(fileURLToPath(new URL('../../../skills/comm-bridge/scripts/core-config-loader.js', import.meta.url)),
    path.join(installed, 'comm-bridge/scripts/core-config-loader.js'));
  const env = { ...f.env, ZYLOS_PACKAGE_ROOT: fileURLToPath(new URL('../../../', import.meta.url)) };
  const run = args => childResult(spawn(process.execPath, [wrapper, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] }));
  const ensured = await run(['ensure', '--id', 'references-layout-v1', '--created-by', 'init', '--json']);
  assert.equal(ensured.code, 0, ensured.stderr);
  assert.equal(JSON.parse(ensured.stdout).data.state, 'pending');
  const bytes = fs.readFileSync(f.record);
  for (const args of [ ['status', '--id', 'references-layout-v1', '--fresh-install'],
    ['ensure', '--id', 'references-layout-v1', '--created-by', 'invalid'],
    ['status', '--id', 'references-layout-v1', '--id', 'references-layout-v1'],
    ['apply', '--id', 'references-layout-v1'] ]) {
    for (const json of [false, true]) {
      const result = await run([...args, ...(json ? ['--json'] : [])]);
      assert.equal(result.code, 1, result.stderr);
      if (json) {
        assert.equal(JSON.parse(result.stdout).error.code, 'INVALID_INPUT');
        assert.equal(result.stderr, '');
        assert.equal(result.stdout.trim().split('\n').length, 1);
      } else {
        assert.equal(result.stdout, '');
        assert.match(result.stderr, /^Error \[INVALID_INPUT\]: /);
      }
      assert.deepEqual(fs.readFileSync(f.record), bytes);
    }
  }
  for (const command of ['ensure', 'status']) {
    const args = [command, '--id', 'references-layout-v1', ...(command === 'ensure' ? ['--created-by', 'init'] : [])];
    const text = await run(args);
    assert.equal(text.code, 0); assert.match(text.stdout, /^OK: /); assert.equal(text.stderr, '');
    const json = await run([...args, '--json']);
    assert.equal(json.code, 0); assert.equal(JSON.parse(json.stdout).data.state, 'pending'); assert.equal(json.stderr, '');
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

test('mechanical checks preserve Unicode and delimited space-containing index paths', async t => {
  const f = fixture(t); init(f);
  await f.service.apply({ ...patch, replacement: '`memory/reference/topic space.md` [topic](reference/主题.md)' });
  await assert.rejects(f.service.complete('indexed'), e => e.missingPaths.includes('memory/reference/topic space.md') &&
    e.missingPaths.includes('memory/reference/主题.md'));
  fs.mkdirSync(path.join(f.memory, 'reference'));
  fs.writeFileSync(path.join(f.memory, 'reference/topic space.md'), 'topic');
  fs.writeFileSync(path.join(f.memory, 'reference/主题.md'), 'topic');
  await f.service.complete('indexed');
});
