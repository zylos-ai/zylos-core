import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createGroupDeletionFixture } from './helpers/group-deletion-fixture.js';
import { ModeSwitchCoordinator } from '../skills/activity-monitor/scripts/mode-switch.js';
import { createModeSwitchConverter } from '../skills/activity-monitor/scripts/mode-switch-convert.js';
import { createGroupDeletionBridge, createGroupDeletionRoutes } from '../skills/dashboard/src/lib/workbench/group-deletion.js';
import { groupDeletionCliPath } from '../cli/lib/group-delete.js';
import { readSessionModeStatus, formatSessionModeStatus } from '../cli/lib/session-mode-status.js';
import { Store } from '../skills/dashboard/src/lib/store.js';
import { ChatConversations } from '../skills/dashboard/src/lib/chat/conversations.js';
import { formatDoctorSessionModeStatus, buildDiagnosticJson } from '../cli/commands/doctor.js';

const enabled = process.env.ZYLOS_DELETED_GROUP_CUTOVER_INTEGRATION === '1';
const repo = fileURLToPath(new URL('../', import.meta.url));
// The immutable release that exhibited this defect, intentionally not HEAD.
const beta12 = 'fe046d73';
function config(f) { return JSON.parse(fs.readFileSync(path.join(f.root, '.zylos/config.json'))); }
function writeMode(f, mode) {
  fs.writeFileSync(path.join(f.root, '.zylos/config.json'), JSON.stringify({ ...config(f), session_mode: mode }));
}
function checkpoints(f) { return f.database.prepare("SELECT * FROM checkpoints WHERE session_group='*' ORDER BY id").all(); }
function insert(f, group, content, status = 'delivered') {
  const id = Number(f.database.prepare("INSERT INTO conversations(direction,channel,endpoint_id,content,status,session_group) VALUES('in','dashboard',?,?,?,?)").run(group === 'origin' ? 'origin' : group.split(':')[1], content, status, group).lastInsertRowid);
  f.database.prepare('INSERT INTO group_heads(session_group,head_id) VALUES(?,?) ON CONFLICT(session_group) DO UPDATE SET head_id=excluded.head_id').run(group, id);
  return id;
}
async function command(f, args, extraEnv = {}) {
  const child = f.sandbox.startChild(process.execPath, args, { env: { ...f.env, ...extraEnv }, timeoutMs: 30_000 });
  child.stdin.end();
  const result = await child.completion;
  assert.equal(result.code, 0, result.stdout + result.stderr);
  return JSON.parse(result.stdout.trim());
}
async function stopMonitor(f) {
  f.monitor.kill('SIGTERM'); await f.monitor.completion;
}
async function setup(t, { noCurrentMessages = false, checkpointSource = 'cutover' } = {}) {
  const f = await createGroupDeletionFixture(t, { group: 'dashboard:cutover-a', timezone: 'Asia/Singapore' });
  assert.equal(f.env.TZ, 'Asia/Singapore');
  assert.equal(fs.readFileSync(path.join(f.root, '.env'), 'utf8'), 'TZ=Asia/Singapore\n');
  f.groups = ['dashboard:cutover-a', 'dashboard:cutover-b'];
  f.group = f.groups[0];
  f.env.PATH = path.dirname(process.execPath) + path.delimiter + f.env.PATH;
  const skills = path.join(f.root, '.claude/skills');
  fs.mkdirSync(skills, { recursive: true });
  for (const name of ['dashboard', 'comm-bridge']) fs.symlinkSync(path.join(repo, 'skills', name), path.join(skills, name), 'dir');
  f.store.registerChannelNamespace('dashboard', 'dashboard');
  const dashboard = new Store(f.sandbox.paths.dashboardDb);
  f.sandbox.addCleanup(() => dashboard.close());
  const conversations = new ChatConversations({ store: dashboard });
  if (!noCurrentMessages) insert(f, 'origin', 'surviving old message');
  for (const group of f.groups) {
    insert(f, group, 'deleted Dashboard message ' + group);
    conversations.registerExistingGroup(group, { _open: () => f.database });
    assert.equal(conversations.findByGroup(group).state, 'active');
  }
  fs.mkdirSync(path.join(f.root, 'memory/session-groups/origin'), { recursive: true });
  fs.writeFileSync(path.join(f.root, 'memory/session-groups/origin/state.md'), 'Origin material must remain recoverable\n');
  // Establish coverage through a real multi -> single -> multi cycle first.
  await stopMonitor(f); f.tmux(['kill-server']);
  const warm = coordinator(f, []);
  if (checkpointSource === 'single') {
    // Ordinary Memory Sync in single mode predates any transition.
    writeMode(f, 'single');
    const end = f.database.prepare('SELECT MAX(id) AS n FROM conversations').get().n;
    f.store.createCheckpoint('*', end, 'Normal single-mode Memory Sync');
  }
  for (const target of checkpointSource === 'single' ? ['multi'] : ['single', 'multi']) {
    const accepted = await warm.handle({ target }); await finish(f, warm, accepted.runId);
  }
  f.covered = f.store.getGlobalCoverageEnd();
  f.expectedCutoff = noCurrentMessages ? 0 : 1;
  f.startRuntime('origin');
  for (const group of f.groups) f.startRuntime(group);
  fs.rmSync(path.join(f.root, 'monitor-round.json'), { force: true });
  f.monitor = f.sandbox.startChild(process.execPath, [path.join(repo, 'test/fixtures/group-deletion-monitor.js')], { env: f.env, timeoutMs: 120_000 });
  await f.waitFor(() => fs.existsSync(path.join(f.root, 'monitor-round.json')), 'Private monitor must restart before deletion');
  return f;
}
async function deletion(f, entry) {
  for (const group of f.groups) await deleteOne(f, entry, group);
  assert.equal(f.database.prepare('SELECT COALESCE(MAX(id),0) AS n FROM conversations').get().n, f.expectedCutoff);
  assert.equal(f.store.getGlobalCoverageEnd(), f.covered);
  await stopMonitor(f); f.tmux(['kill-server']);
}
async function deleteOne(f, entry, group) {
  const operationId = randomUUID();
  if (entry === 'cli') {
    const result = await f.startDeleteChild({ operationId, group }).completion;
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.equal(JSON.parse(result.stdout.trim()).pending, false);
  } else {
    const core = createGroupDeletionBridge({ zylosDir: f.root, env: f.env,
      loadCoreModule: async () => ({ groupDeletionCliPath }),
      execute: async (binary, args, options) => {
        assert.equal(binary, process.execPath);
        const child = f.sandbox.startChild(binary, args, { env: options.env, timeoutMs: options.timeout });
        child.stdin.end(); const result = await child.completion;
        if (result.code !== 0) throw Object.assign(new Error('Core CLI failed'), result);
        return result;
      } });
    const routes = createGroupDeletionRoutes({ core, conversations: {},
      auth: { enabled: true, resolveAuthContext: () => ({ kind: 'cookie', scope: 'admin', principalId: 'owner' }) },
      config: { zylosDir: f.root, auth: { password: 'test-owner-password' } } });
    // Authentication is a local owner seam; real route validation, HTTP body,
    // bridge, Core child, AM stop, and storage removal are exercised unchanged.
    const url = await f.sandbox.startHttp(http.createServer(async (req, res) => {
      if (!await routes(req, res, new URL(req.url, 'http://localhost'))) { res.writeHead(404); res.end(); }
    }));
    const endpoint = `${url}/api/groups/${encodeURIComponent(group)}`;
    const previewResponse = await fetch(endpoint + '/deletion-preview');
    assert.equal(previewResponse.status, 200);
    const preview = await previewResponse.json();
    const response = await fetch(endpoint, { method: 'DELETE', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({ confirmed: true, operationId, cutoffId: preview.cutoffId }) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).pending, false);
  }
  assert.equal(f.store.getGroupDeletionAudit(operationId).status, 'done');
  assert.equal(f.runtimePresent(group), false);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM conversations WHERE session_group=?').get(group).n, 0);

}
function coordinator(f, events) {
  return new ModeSwitchCoordinator({ db: f.store,
    readMode: () => ({ mode: config(f).session_mode }), readConfiguration: () => config(f),
    readRequests: () => [], legacyPresent: () => false,
    // Deletion and private tmux shutdown above prove that no source executor remains.
    observe: () => [], lifecycle: { advanceReclaim: () => assert.fail('No runtime remains to reclaim') },
    convert: createModeSwitchConverter({ db: f.store, zylosDir: f.root }),
    writeMode: mode => writeMode(f, mode),
    // PM2 is deliberately not started; its confirmation boundary is a receipt.
    restart: { advance: () => ({ confirmed: true, pending: false }) }, diagnostic: event => events.push(event) });
}
async function finish(f, coordinator, runId, maxTicks = 6) {
  for (let tick = 0; tick < maxTicks && f.store.getModeTransition(); tick++) await coordinator.advance();
  assert.equal(f.store.getModeTransition(), null);
  const done = f.store.getModeTransition({ runId });
  assert.equal(done.phase, 'complete'); assert.equal(done.reason, null);
  assert.deepEqual(f.store.listDrainFences(), []);
  return done;
}
async function status(f, events) {
  const value = await readSessionModeStatus({ zylosDir: f.root, db: f.store,
    readMode: () => ({ mode: config(f).session_mode }), readEvents: () => events,
    probeSupervisor: () => false, readPm2: () => 'daemon_not_running' });
  const cli = await command(f, [path.join(repo, 'cli/zylos.js'), 'session-mode', 'status', '--json']);
  assert.equal(cli.ok, true);
  assert.equal(cli.data.transition, null); assert.equal(cli.data.blocked, null);
  assert.equal(cli.data.globalGate.present, false);
  assert.equal(cli.data.lastCompleted.runId, value.lastCompleted.runId);
  assert.equal(value.transition, null); assert.equal(value.blocked, null);
  assert.equal(value.globalGate.present, false);
  assert.match(formatSessionModeStatus(value), /Transition: none/);
  const doctor = formatDoctorSessionModeStatus({ status: value, error: null }).join('\n');
  assert.match(doctor, /Mode transition: none/); assert.match(doctor, /Global gate: absent/);
  assert.doesNotMatch(doctor, /blocked/i);
  return value;
}

for (const entry of ['cli', 'dashboard']) {
  // Boundary: real deletion entry point -> AM/tmux lifecycle -> C4 store ->
  // converter/coordinator -> CLI/doctor display. Run for deletion/cutover changes;
  // skip unrelated changes unless ZYLOS_DELETED_GROUP_CUTOVER_INTEGRATION=1.
  // Every subprocess/DB/HTTP server is fixture-owned; HOME, ZYLOS_DIR, PM2_HOME,
  // short TMPDIR and the explicit private tmux socket are asserted before startup.
  test(`${entry} deletion permits repeated multi/single cutovers with preserved coverage`, { skip: !enabled, timeout: 90_000 }, async t => {
    const f = await setup(t);
    await f.sandbox.runCase(async () => {
      await deletion(f, entry);
      const before = checkpoints(f), events = [], c = coordinator(f, events);
      for (const target of ['single', 'multi', 'single']) {
        const accepted = await c.handle({ target }); assert.equal(accepted.ok, true);
        const done = await finish(f, c, accepted.runId);
        assert.equal(done.cutoff, f.expectedCutoff); assert.deepEqual(done.absorbed_ids, []);
        assert.equal(config(f).session_mode, target);
        assert.deepEqual(checkpoints(f), before, 'An already-covered cutoff must not append a checkpoint');
        const observed = await status(f, events); assert.equal(observed.lastCompleted.runId, accepted.runId);
      }
      const skips = events.filter(event => event.event === 'transition_cutover' && event.checkpointWritten === false);
      assert.equal(skips.length, 2); assert.ok(skips.every(event => event.cutoff === f.expectedCutoff && event.covered === f.covered));
      assert.equal(events.some(event => event.event === 'transition_cutover_failed'), false);
      assert.equal(f.database.prepare('SELECT content FROM conversations WHERE id=1').get().content, 'surviving old message');
      assert.ok(fs.existsSync(path.join(f.root, 'memory/state.md')));
      // Memory Sync reads only fresh unsummarized work after the covered skip.
      const fresh = insert(f, 'origin', 'fresh Memory Sync input');
      assert.deepEqual(f.store.getGlobalUnsummarizedConversations({ upToConversationId: fresh }).map(row => row.id), [fresh]);
      f.store.createCheckpoint('*', fresh, 'Memory Sync fresh summary');
      assert.equal(f.store.getGlobalCoverageEnd(), fresh);
      // New work beyond the retained coverage still uses the normal cutover path.
      const multi = await c.handle({ target: 'multi' }); await finish(f, c, multi.runId);
      const next = insert(f, 'origin', 'new work beyond retained coverage', 'pending');
      assert.ok(next > f.covered);
      const single = await c.handle({ target: 'single' });
      const completed = await finish(f, c, single.runId);
      assert.deepEqual(completed.absorbed_ids, [next]);
      assert.equal(f.store.getGlobalCoverageEnd(), next);
      assert.equal(checkpoints(f).length, before.length + 2);
      await status(f, events);
    }, { timeoutMs: 75_000 });
  });
}

// Boundary: an actual immutable beta.12 package naturally fails and leaves the transition
// converting on disk; the current store+converter+coordinator resumes that same
// record after code replacement, without SQL repair. Run for upgrade/recovery
// or cutover changes; same explicit gate/isolation as the lifecycle cases above.
// Requires the local fe046d73 release object; no network or package install.
test('beta.12 persisted converting transition heals after code replacement', { skip: !enabled, timeout: 90_000 }, async t => {
  const f = await setup(t);
  await f.sandbox.runCase(async () => {
    await deletion(f, 'cli');
    const before = checkpoints(f);
    const archived = path.join(f.sandbox.root, 'beta12'); fs.mkdirSync(archived);
    const tar = execFileSync('git', ['archive', '--format=tar', beta12], { cwd: repo, env: f.env, maxBuffer: 50 * 1024 * 1024 });
    execFileSync('tar', ['-xf', '-', '-C', archived], { input: tar, env: f.env });
    fs.symlinkSync(path.join(repo, 'node_modules'), path.join(archived, 'node_modules'), 'dir');
    const old = await command(f, [path.join(repo, 'test/helpers/deleted-group-beta12-transition.js'), archived], { ZYLOS_PACKAGE_ROOT: archived });
    assert.equal(old.code, 'CHECKPOINT_REGRESSION');
    assert.equal(old.transition.phase, 'converting'); assert.equal(old.transition.cutoff, f.expectedCutoff);
    assert.deepEqual(checkpoints(f), before);
    const events = [], c = coordinator(f, events);
    const completed = await finish(f, c, old.transition.run_id, 2);
    assert.equal(completed.run_id, old.transition.run_id);
    assert.equal(completed.cutoff, old.transition.cutoff);
    assert.deepEqual(completed.coverage_snapshot, old.transition.coverage_snapshot);
    assert.deepEqual(completed.absorbed_ids, old.transition.absorbed_ids);
    assert.deepEqual(checkpoints(f), before);
    assert.equal(config(f).session_mode, 'single');
    await status(f, events);
    assert.equal(events.filter(event => event.event === 'transition_cutover' && event.checkpointWritten === false).length, 1);
  }, { timeoutMs: 75_000 });
});

// Boundary: physically empty current C4 after both Dashboard groups disappear,
// while an earlier real cutover's global checkpoint remains. Run for deletion /
// zero-cutoff changes under the same opt-in gate and full sandbox isolation.
for (const checkpointSource of ['cutover', 'single']) test(`${checkpointSource} checkpoint with no current messages permits cutoff zero`, { skip: !enabled, timeout: 90_000 }, async t => {
  const f = await setup(t, { noCurrentMessages: true, checkpointSource });
  await f.sandbox.runCase(async () => {
    await deletion(f, 'cli');
    assert.equal(f.database.prepare('SELECT count(*) AS n FROM conversations').get().n, 0);
    const before = checkpoints(f), events = [], c = coordinator(f, events);
    const accepted = await c.handle({ target: 'single' });
    const done = await finish(f, c, accepted.runId);
    assert.equal(done.cutoff, 0); assert.deepEqual(checkpoints(f), before);
    assert.equal(f.store.getGlobalCoverageEnd(), f.covered);
    await status(f, events);
  }, { timeoutMs: 75_000 });
});

for (const code of ['CHECKPOINT_GAP', 'CUTOVER_COVERAGE_CONFLICT']) {
  // Boundary: real frozen transition/store failure -> coordinator -> separate CLI
  // read-only connection and doctor output. Run for cutover safety/diagnostics;
  // skip unrelated changes unless explicitly enabled. Inject inconsistent data
  // only into this case's private SQLite after freeze; no product API is mocked.
  test(`${code} remains durably blocked without repeated diagnostics or unblocking`, { skip: !enabled, timeout: 90_000 }, async t => {
    const f = await setup(t);
    await f.sandbox.runCase(async () => {
      await deletion(f, 'cli');
      let gapId;
      if (code === 'CHECKPOINT_GAP') gapId = insert(f, 'origin', 'finished at freeze, inconsistent on retry');
      const before = checkpoints(f), events = [], c = coordinator(f, events);
      const accepted = await c.handle({ target: 'single' });
      await c.advance();
      const frozen = f.store.getModeTransition(); assert.equal(frozen.phase, 'converting');
      if (gapId) f.database.prepare("UPDATE conversations SET status='pending' WHERE id=?").run(gapId);
      else f.database.prepare("INSERT INTO conversations(id,direction,channel,endpoint_id,content,status,session_group) VALUES(2,'in','dashboard','origin','illegal surviving row above cutoff','delivered','origin')").run();
      for (let tick = 0; tick < 3; tick++) await c.advance();
      const row = f.store.getModeTransition();
      assert.equal(row.run_id, accepted.runId); assert.equal(row.phase, 'converting');
      assert.equal(row.reason, `cutover_failed:${code}`);
      assert.equal(config(f).session_mode, 'multi');
      assert.equal(f.store.getDrainFence('*').sessionGroup, '*');
      assert.deepEqual(checkpoints(f), before);
      assert.equal(events.filter(event => event.event === 'transition_cutover_failed').length, 1);
      assert.equal(events.some(event => event.event === 'transition_unblocked'), false);
      // Actual public CLI subprocess reads the persisted transition; it does not share the
      // coordinator connection, diagnostics array or in-memory failure seam.
      const cli = await command(f, [path.join(repo, 'cli/zylos.js'), 'session-mode', 'status', '--json']);
      assert.equal(cli.ok, true);
      assert.equal(cli.data.transition.phase, 'converting');
      assert.equal(cli.data.blocked.reason, `cutover_failed:${code}`);
      assert.equal(cli.data.globalGate.present, true);
      const doctorValue = { status: cli.data, error: null, skipped: false };
      assert.match(formatDoctorSessionModeStatus(doctorValue).join('\n'), new RegExp(`Mode transition blocked: cutover_failed:${code}`));
      const doctor = buildDiagnosticJson({ runtime: 'claude', display: 'Claude', sessionModeStatus: doctorValue,
        system: { tmux: { installed: true }, pm2: { installed: true } },
        ai: { cli: { installed: true }, auth: true, authStatus: 'success', autonomous: true, autonomousApplicable: true },
        services: { running: true, total: 1, procs: [{ name: 'activity-monitor', pm2_env: { status: 'online' } }] },
      }, { success: true, version: 'fixture' });
      assert.equal(doctor.passed, false);
      assert.deepEqual(doctor.issues.map(issue => issue.id), ['session_mode_transition_blocked']);
      assert.match(doctor.issues[0].label, new RegExp(code));
    }, { timeoutMs: 75_000 });
  });
}
