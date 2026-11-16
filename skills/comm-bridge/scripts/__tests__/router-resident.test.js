import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { routerFixture } from './helpers/router-fixture.js';
import { createSinglePreparation, createLegacyMigration, runningMaintenance } from '../router/resident.js';

test('single preparation waits at most 300 seconds, then cleanup and instruction generation in order', async () => {
  let now = 0; const calls = [];
  const prepare = createSinglePreparation({ now: () => now, sleep: async ms => { now += ms; }, checkMaintenance: async () => 'upgrade',
    clearStaleState: async runtime => calls.push(['clear',runtime]), resetToolLifecycle: async runtime => calls.push(['reset',runtime]),
    buildInstructionFile: async runtime => calls.push(['instructions',runtime]) });
  await prepare('codex'); assert.equal(now, 300000);
  assert.deepEqual(calls, [['clear','codex'],['reset','codex'],['instructions','codex']]);
});

test('maintenance scan is async argv-only and distinguishes no match from observation failure', async () => {
  const patterns = [], unavailable = [];
  const match = await runningMaintenance({ execute: async (file,args,options) => {
    assert.equal(file, 'pgrep');
    assert.deepEqual(args.slice(0, 3), ['-u', String(process.getuid()), '-f']);
    assert.deepEqual(options, { timeout: 500 });
    patterns.push(args[3]);
    if (patterns.length < 2) throw Object.assign(Error(), { code: 1 });
  } });
  assert.match(match, /upgrade-claude\/scripts\/upgrade/);
  assert.equal(patterns.length, 2);
  assert.equal(await runningMaintenance({ execute: async () => { throw Object.assign(Error(),{code:1}); },
    unavailable: error => unavailable.push(error) }), null);
  await assert.rejects(runningMaintenance({ execute: async () => { throw Object.assign(Error('timeout'),{code:'ETIMEDOUT'}); },
    unavailable: error => unavailable.push(error) }), /timeout/);
  assert.equal(unavailable.length, 0);
});

test('pgrep that cannot be run (ENOENT or EACCES) is unavailable, other failures still reject', async () => {
  for (const code of ['ENOENT', 'EACCES']) {
    const unavailable = [];
    assert.equal(await runningMaintenance({ execute: async () => { throw Object.assign(Error(), { code }); },
      unavailable: error => unavailable.push(error.code) }), null);
    assert.deepEqual(unavailable, [code]);
  }
  for (const failure of [{ code: 'ETIMEDOUT' }, { code: 2 }]) {
    const unavailable = [];
    await assert.rejects(runningMaintenance({ execute: async () => { throw Object.assign(Error('pgrep failed'), failure); },
      unavailable: error => unavailable.push(error.code) }), /pgrep failed/);
    assert.equal(unavailable.length, 0);
  }
});

function withoutPgrep(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-pgrep-')), saved = process.env.PATH;
  process.env.PATH = dir;
  t.after(() => { process.env.PATH = saved; fs.rmSync(dir, { recursive: true, force: true }); });
}

// A PATH directory the current user cannot search makes Node report EACCES
// instead of ENOENT when pgrep is absent. Root bypasses the permission.
const runsAsRoot = process.getuid?.() === 0;
function withLockedPathDirectory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'locked-path-')), locked = path.join(dir, 'locked'), saved = process.env.PATH;
  fs.mkdirSync(locked, { mode: 0o000 });
  process.env.PATH = `${locked}${path.delimiter}${dir}`;
  t.after(() => { process.env.PATH = saved; fs.chmodSync(locked, 0o700); fs.rmSync(dir, { recursive: true, force: true }); });
}

test('missing pgrep is reported as unavailable and treated as no maintenance', async t => {
  withoutPgrep(t);
  const unavailable = [];
  assert.equal(await runningMaintenance({ unavailable: error => unavailable.push(error) }), null);
  assert.equal(unavailable.length, 1);
  assert.equal(unavailable[0].code, 'ENOENT');
});

test('single preparation without pgrep starts every time and logs the skipped check once', async t => {
  withoutPgrep(t);
  const calls = [], logs = [];
  const prepare = createSinglePreparation({ sleep: async () => assert.fail('must not wait without pgrep'), log: line => logs.push(line),
    clearStaleState: async () => calls.push('clear'), resetToolLifecycle: async () => calls.push('reset'),
    buildInstructionFile: async () => calls.push('instructions') });
  await prepare('claude'); await prepare('claude'); await prepare('claude');
  assert.deepEqual(calls, ['clear','reset','instructions','clear','reset','instructions','clear','reset','instructions']);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^pgrep was not found \(ENOENT\); skipped the maintenance check .* single-session startup\. Install procps to restore it\.$/);
});

test('single preparation with a PATH directory that denies access starts every time and logs EACCES once', { skip: runsAsRoot && 'root bypasses directory permissions' }, async t => {
  withLockedPathDirectory(t);
  const unavailable = [];
  assert.equal(await runningMaintenance({ unavailable: error => unavailable.push(error.code) }), null);
  assert.deepEqual(unavailable, ['EACCES']);
  const calls = [], logs = [];
  const prepare = createSinglePreparation({ sleep: async () => assert.fail('must not wait when pgrep cannot be run'), log: line => logs.push(line),
    clearStaleState: async () => calls.push('clear'), resetToolLifecycle: async () => calls.push('reset'),
    buildInstructionFile: async () => calls.push('instructions') });
  await prepare('claude'); await prepare('claude');
  assert.deepEqual(calls, ['clear','reset','instructions','clear','reset','instructions']);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^pgrep could not be run \(EACCES\); skipped the maintenance check .* single-session startup\. Install procps and make every PATH directory accessible to restore it\.$/);
  assert.doesNotMatch(logs[0], /not found/);
});

const hasPgrep = spawnSync('pgrep', ['-f', '[n]o-such-process-pattern']).status === 1;

// Real pgrep and disposable processes only; run for maintenance matching changes,
// skip unrelated edits. No live service, tmux socket or database is opened here.
function isolationReadback() {
  const home = fs.realpathSync(process.env.HOME);
  assert.notEqual(home, fs.realpathSync(os.userInfo().homedir));
  const root = path.dirname(home);
  for (const key of ['ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) {
    assert.ok(process.env[key]?.startsWith(root + path.sep), `${key} must be isolated`);
  }
  console.log(JSON.stringify({ HOME: home, ZYLOS_DIR: process.env.ZYLOS_DIR,
    PM2_HOME: process.env.PM2_HOME, TMPDIR: process.env.TMPDIR,
    socket: path.join(process.env.TMPDIR, 'tmux.sock'), database: 'unused', uid: process.getuid() }));
}

async function maintenanceProcess(t, script, mentions = []) {
  isolationReadback();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maintenance-'));
  const file = path.join(root, script);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.copyFileSync(new URL('./fixtures/maintenance-process.js', import.meta.url), file);
  const child = spawn(process.execPath, [file, ...mentions], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const [ready] = await once(child, 'message', { signal: AbortSignal.timeout(5000) });
  assert.equal(ready.ready, true);
  return { child, exited };
}

// Covers same-UID incidental arguments, including the concurrent test runner.
// Run for matching changes; skip unrelated work. Children are stopped and awaited.
test('maintenance ignores same-user commands that only mention script words or test paths', { skip: !hasPgrep, timeout: 15000 }, async t => {
  isolationReadback();
  const grep = spawn('grep', ['upgrade-claude'], { stdio: ['pipe', 'ignore', 'ignore'] });
  const grepExited = once(grep, 'exit');
  t.after(async () => {
    if (grep.exitCode === null && grep.signalCode === null) grep.kill('SIGKILL');
    await grepExited;
  });
  await once(grep, 'spawn');
  await maintenanceProcess(t, 'grep.js', ['upgrade-claude', 'restart-claude', 'https://claude.ai/install.sh']);
  await maintenanceProcess(t, 'runner.js', ['skills/upgrade-claude/scripts/__tests__/process-check.test.js',
    'skills/restart-claude/scripts/restart.js', 'skills/upgrade-claude/scripts/upgrade.js']);
  assert.equal(await runningMaintenance(), null);
});

// Exact argv contract excludes other OS users without a privileged test fixture.
// Real cross-user process acceptance runs on the review host.
test('every maintenance pattern restricts pgrep to the current OS user', async () => {
  let calls = 0;
  assert.equal(await runningMaintenance({ execute: async (file, args) => {
    assert.equal(file, 'pgrep');
    assert.deepEqual(args.slice(0, 3), ['-u', String(process.getuid()), '-f']);
    calls++;
    throw Object.assign(Error('No current-user match'), { code: 1 });
  } }), null);
  assert.equal(calls, 4);
});

// Real upgrade script invocation remains observable. Run for maintenance matching;
// no installer/control code runs, only a disposable fixture at the script path.
test('maintenance recognizes a current-user upgrade script invocation', { skip: !hasPgrep, timeout: 15000 }, async t => {
  await maintenanceProcess(t, 'upgrade-claude/scripts/upgrade.js');
  assert.match(await runningMaintenance(), /upgrade-claude\/scripts\/upgrade/);
});

// Real pgrep filters a real script child by OS ownership. Only the observer UID
// is substituted, so this needs no sudo, setuid or second-user process fixture.
// Run for user-filter changes; actual second-user startup is review acceptance.
test('maintenance excludes a real restart script process belonging to another observed UID', { skip: !hasPgrep, timeout: 15000 }, async t => {
  const uid = process.getuid();
  await maintenanceProcess(t, 'restart-claude/scripts/restart.js');
  assert.match(await runningMaintenance(), /restart-claude\/scripts\/restart/);
  t.mock.method(process, 'getuid', () => uid === 0 ? 65534 : 0);
  assert.equal(await runningMaintenance(), null);
});

// Harmless fixture titles exercise real pgrep against the installer command-line
// shapes; no curl, network or installer is executed. Run for pattern changes.
for (const title of ['curl -fsSL https://claude.ai/install.sh',
  '/bin/sh -c curl -fsSL https://claude.ai/install.sh | bash']) {
  test(`maintenance recognizes the installer command line ${title}`, { skip: !hasPgrep, timeout: 15000 }, async t => {
    await maintenanceProcess(t, 'held.js', ['--title', title]);
    assert.match(await runningMaintenance(), /install/);
  });
}

// Real script/pgrep/preparation boundary; run for maintenance checks, skip unrelated
// work. The isolated child is stopped and awaited; no live restart is performed.
test('with pgrep, a running restart-claude process holds single preparation until it exits', { skip: !hasPgrep && 'pgrep is not installed', timeout: 15000 }, async t => {
  const { child, exited } = await maintenanceProcess(t, 'restart-claude/scripts/restart.js');
  assert.match(await runningMaintenance(), /restart-claude\/scripts\/restart/);
  let now = 0; const waits = [], logs = [], calls = [];
  const prepare = createSinglePreparation({ now: () => now, log: line => logs.push(line),
    sleep: async ms => { waits.push(ms); now += ms; if (waits.length === 2) { child.kill('SIGTERM'); await exited; } },
    clearStaleState: async () => calls.push('clear'), resetToolLifecycle: async () => calls.push('reset'),
    buildInstructionFile: async () => calls.push('instructions') });
  await prepare('claude');
  assert.deepEqual(waits, [1000, 1000]);
  assert.deepEqual(calls, ['clear','reset','instructions']);
  assert.equal(logs.some(line => /pgrep/.test(line)), false);
});

test('legacy waits idle, sends exit once, confirms disappearance; busy target forced at 300s by observed runtime', async () => {
  let now = 0; const live = new Map([['claude-main',{ present:true,tmuxName:'claude-main',runtime:'claude',runId:null }],
    ['codex-main',{ present:true,tmuxName:'codex-main',runtime:'codex',runId:'old' }]]);
  const calls = [];
  const migration = createLegacyMigration({ now: () => now, readLegacy: async name => live.get(name) ?? {present:false},
    readLegacyStatus: async name => ({state:name==='claude-main'?'idle':'busy', idle_seconds:4}),
    sendExit: async target => calls.push(['exit',target.tmuxName]), getSessionAdapter: runtime => ({stop: async input => { calls.push(['stop',runtime,input]); live.delete(input.tmuxName); }}),
    diagnostic: (event, fields) => calls.push([event,fields]) });
  const entries = await migration.findLegacySessions(); await migration.advanceLegacy(entries); await migration.advanceLegacy(entries);
  assert.deepEqual(calls.filter(x => x[0]==='exit'), [['exit','claude-main']]);
  live.delete('claude-main'); await migration.advanceLegacy(entries);
  now = 299999; await migration.advanceLegacy(entries);
  assert.equal(calls.some(x => x[0] === 'stop'), false);
  now = 300000; await migration.advanceLegacy(entries);
  assert.deepEqual(calls.find(x => x[0]==='stop'), ['stop','codex',{tmuxName:'codex-main',expectedRunId:'old'}]);
  assert.deepEqual(calls.filter(x => x[0]==='legacy_tmux_stopped').map(x => x[1].reason), ['exited','forced']);
});

test('unknown legacy runtime never guesses adapter; failed stop remains pending', async () => {
  let now = 0, runtime = 'unknown', stopCount = 0;
  const migration = createLegacyMigration({ now:()=>now, readLegacy:async name => ({present:name==='claude-main',runtime,tmuxName:name,runId:null}),
    readLegacyStatus:async()=>({state:'busy'}),sendExit:async()=>assert.fail('busy'),getSessionAdapter:()=>({stop:async()=>{stopCount++;throw Error('unconfirmed');}}) });
  const entries=await migration.findLegacySessions(); now=300001; await migration.advanceLegacy(entries); assert.equal(stopCount,0);
  runtime='claude';await migration.advanceLegacy(entries); assert.equal(stopCount,1);assert.equal(entries[0].stopped,false);
});

for (const runtime of ['claude', 'codex']) {
  test(`${runtime} legacy exit gets sixty seconds from successful submission`, async () => {
    let now = 0, stops = 0;
    const events = [];
    const migration = createLegacyMigration({ now: () => now,
      readLegacy: async name => ({ present: name === 'claude-main', tmuxName: name, runtime, runId: null }),
      readLegacyStatus: async () => ({ state: 'idle', idle_seconds: 3 }),
      sendExit: async () => { now += 50; },
      getSessionAdapter: () => ({ stop: async () => { stops++; } }),
      diagnostic: (event, fields) => events.push({ event, ...fields }),
    });
    const entries = await migration.findLegacySessions();
    now = 10000; await migration.advanceLegacy(entries);
    assert.equal(entries[0].exitSentAt, 10050);
    now = 70049; await migration.advanceLegacy(entries); assert.equal(stops, 0);
    now = 70050; await migration.advanceLegacy(entries); assert.equal(stops, 1);
    await migration.advanceLegacy(entries); assert.equal(stops, 1);
    assert.deepEqual(events, [
      { event: 'legacy_exit_forced', tmuxName: 'claude-main', reason: 'exit_timeout' },
      { event: 'legacy_tmux_stopped', tmuxName: 'claude-main', reason: 'forced' },
    ]);
  });
}

test('failed exit submission does not start the sixty second timer', async () => {
  let now = 0, stops = 0;
  const migration = createLegacyMigration({ now: () => now,
    readLegacy: async name => ({ present: name === 'claude-main', tmuxName: name, runtime: 'codex', runId: null }),
    readLegacyStatus: async () => ({ state: 'idle', idle_seconds: 3 }),
    sendExit: async () => { throw Error('submission failed'); },
    getSessionAdapter: () => ({ stop: async () => { stops++; } }),
  });
  const entries = await migration.findLegacySessions(); await migration.advanceLegacy(entries);
  now = 60000; await migration.advanceLegacy(entries);
  assert.equal(entries[0].exitSent, false); assert.equal(entries[0].exitSentAt, undefined);
  assert.equal(stops, 0);
  now = 300000; await migration.advanceLegacy(entries); assert.equal(stops, 1);
});

for (const runtime of ['claude', 'codex']) {
  test(`${runtime} disappearance before the exit deadline skips forced stop`, async () => {
    let now = 0, present = true, exits = 0, stops = 0;
    const events = [];
    const migration = createLegacyMigration({ now: () => now,
      readLegacy: async name => ({ present: present && name === 'claude-main', tmuxName: name, runtime, runId: null }),
      readLegacyStatus: async () => ({ state: 'idle', idle_seconds: 3 }),
      sendExit: async () => { exits++; },
      getSessionAdapter: () => ({ stop: async () => { stops++; } }),
      diagnostic: (event, fields) => events.push({ event, ...fields }),
    });
    const entries = await migration.findLegacySessions(); await migration.advanceLegacy(entries);
    await migration.advanceLegacy(entries); await migration.advanceLegacy(entries);
    assert.equal(exits, 1);
    present = false; now = 59999; await migration.advanceLegacy(entries);
    assert.equal(entries[0].stopped, true); assert.equal(stops, 0);
    now = 60000; await migration.advanceLegacy(entries); assert.equal(stops, 0);
    assert.deepEqual(events, [{ event: 'legacy_tmux_stopped', tmuxName: 'claude-main', reason: 'exited' }]);
  });
}

for (const reason of ['exit_timeout', 'startup_timeout']) {
  test(`${reason} logs forced exit once while failed stops keep retrying`, async () => {
    let now = 0, stops = 0;
    const events = [];
    const migration = createLegacyMigration({ now: () => now,
      readLegacy: async name => ({ present: name === 'claude-main', tmuxName: name, runtime: 'claude', runId: null }),
      readLegacyStatus: async () => ({ state: reason === 'exit_timeout' ? 'idle' : 'busy', idle_seconds: 3 }),
      sendExit: async () => {},
      getSessionAdapter: () => ({ stop: async () => { if (++stops <= 3) throw Error('stop failed'); } }),
      diagnostic: (event, fields) => events.push({ event, ...fields }),
    });
    const entries = await migration.findLegacySessions();
    await migration.advanceLegacy(entries);
    now = reason === 'exit_timeout' ? 60000 : 300000;
    for (let attempt = 1; attempt <= 3; attempt++) {
      await migration.advanceLegacy(entries);
      assert.equal(stops, attempt); assert.equal(entries[0].stopped, false);
      now += 1000;
    }
    await migration.advanceLegacy(entries);
    assert.equal(stops, 4); assert.equal(entries[0].stopped, true);
    await migration.advanceLegacy(entries); assert.equal(stops, 4);
    assert.deepEqual(events.filter(row => row.event === 'legacy_exit_forced'), [
      { event: 'legacy_exit_forced', tmuxName: 'claude-main', reason },
    ]);
    assert.equal(events.filter(row => row.event === 'legacy_stop_unconfirmed').length, 3);
    assert.equal(events.filter(row => row.event === 'legacy_tmux_stopped').length, 1);
  });
}


for (const health of ['ok', 'auth_failed']) {
  test(`single resident starts without queued work even when health is ${health}`, async t => {
    const f = routerFixture(t, { mode: 'single' });
    f.health.set('claude', { health });
    f.deps.readRuntimeHealth = () => assert.fail('single resident startup does not read runtime health');
    const router = f.create(); await router.initialize(); await f.rounds(2);
    f.advance(4999); await f.rounds(2);
    assert.equal(f.calls.filter(row => row[0] === 'launch').length, 0);
    f.advance(1); await f.rounds(2);
    assert.equal(f.calls.filter(row => row[0] === 'launch').length, 1);
    assert.equal(f.calls.find(row => row[0] === 'launch')[1].sessionGroup, null);
    assert.equal(f.calls.filter(row => row[0] === 'submit').length, 0);
  });
}

test('failed Origin launches retain the five ten twenty forty sixty second backoff', async t => {
  const f = routerFixture(t);
  f.db.insertControl('Needed work', { sessionGroup: 'origin', appendAckSuffix: false });
  f.deps.getSessionAdapter = () => ({
    launch: async input => { f.calls.push(['launch', input]); throw new Error('launch failed'); },
    stop: async input => { f.calls.push(['stop', input]); },
  });
  const router = f.create(); await router.initialize(); await f.rounds(2);
  for (const [index, delay] of [5000, 10000, 20000, 40000, 60000].entries()) {
    f.advance(delay - 1); await f.rounds(2);
    assert.equal(f.calls.filter(row => row[0] === 'launch').length, index);
    f.advance(1); await f.rounds(2);
    assert.equal(f.calls.filter(row => row[0] === 'launch').length, index + 1);
    assert.equal(router.state.resident.failures, index + 1);
  }
});

test('a stable ready Origin clears failure backoff before an hour asleep and a fresh demand', async t => {
  const f = routerFixture(t);
  f.db.insertControl('Initial work', { sessionGroup: 'origin', appendAckSuffix: false });
  const adapter = f.deps.getSessionAdapter;
  let failuresLeft = 2;
  f.deps.getSessionAdapter = runtime => ({ ...adapter(runtime), launch: async input => {
    if (failuresLeft-- > 0) { f.calls.push(['launch', input]); throw new Error('launch failed'); }
    return adapter(runtime).launch(input);
  } });
  const router = f.create(); await router.initialize(); await f.rounds(2);
  for (const delay of [5000, 10000, 20000]) { f.advance(delay); await f.rounds(3); }
  assert.equal(router.state.resident.failures, 3);
  f.advance(60000); await f.rounds(2);
  assert.equal(router.state.resident.failures, 0);
  f.scene.delete('origin'); f.current.delete('origin'); await f.rounds(2);
  const count = f.calls.filter(row => row[0] === 'launch').length;
  f.advance(3600000); await f.rounds(3);
  assert.equal(f.calls.filter(row => row[0] === 'launch').length, count);
  f.db.insertControl('Fresh demand', { sessionGroup: 'origin', appendAckSuffix: false });
  await f.rounds(1);
  assert.equal(f.calls.filter(row => row[0] === 'launch').length, count + 1);
});
