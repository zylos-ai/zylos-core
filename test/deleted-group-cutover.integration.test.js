import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createGroupDeletionFixture } from './helpers/group-deletion-fixture.js';
import { waitForServerExit } from './helpers/isolated-tmux.js';
import { ModeSwitchCoordinator } from '../skills/activity-monitor/scripts/mode-switch.js';
import { createGroupDeletionBridge, createGroupDeletionRoutes } from '../skills/dashboard/src/lib/workbench/group-deletion.js';
import { groupDeletionCliPath } from '../cli/lib/group-delete.js';
import { readSessionModeStatus, formatSessionModeStatus } from '../cli/lib/session-mode-status.js';
import { Store } from '../skills/dashboard/src/lib/store.js';
import { ChatConversations } from '../skills/dashboard/src/lib/chat/conversations.js';
import { formatDoctorSessionModeStatus } from '../cli/commands/doctor.js';

const enabled = process.env.ZYLOS_DELETED_GROUP_CUTOVER_INTEGRATION === '1';
const repo = fileURLToPath(new URL('../', import.meta.url));
function config(f) { return JSON.parse(fs.readFileSync(path.join(f.root, '.zylos/config.json'))); }
function writeMode(f, mode) {
  fs.writeFileSync(path.join(f.root, '.zylos/config.json'), JSON.stringify({ ...config(f), session_mode: mode }));
}
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
async function stopRuntimes(f) {
  try { f.tmux(['kill-server']); }
  catch (error) { if (!/no server running|error connecting[^\n]*No such file/.test(String(error.stderr))) throw error; }
  await waitForServerExit({ binary: 'tmux', socketPath: f.sandbox.paths.socket });
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
  // Retained pre-upgrade global coverage, independent of native switches.
  await stopMonitor(f); await stopRuntimes(f);
  const end = f.database.prepare('SELECT MAX(id) AS n FROM conversations').get().n;
  f.store.createCheckpoint('*', end, checkpointSource === 'single' ? 'Legacy single-mode summary' : 'Legacy cutover boundary');
  f.covered = f.store.getGlobalCoverageEnd();
  f.expectedHead = noCurrentMessages ? 0 : 1;
  f.startRuntime('origin');
  for (const group of f.groups) f.startRuntime(group);
  fs.rmSync(path.join(f.root, 'monitor-round.json'), { force: true });
  f.monitor = f.sandbox.startChild(process.execPath, [path.join(repo, 'test/fixtures/group-deletion-monitor.js')], { env: f.env, timeoutMs: 120_000 });
  await f.waitFor(() => fs.existsSync(path.join(f.root, 'monitor-round.json')), 'Private monitor must restart before deletion');
  return f;
}
async function deletion(f, entry) {
  for (const group of f.groups) await deleteOne(f, entry, group);
  assert.equal(f.database.prepare('SELECT COALESCE(MAX(id),0) AS n FROM conversations').get().n, f.expectedHead);
  assert.equal(f.store.getGlobalCoverageEnd(), f.covered);
  await stopMonitor(f); await stopRuntimes(f);
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
    readMode: () => ({ mode: config(f).session_mode, keyPresent: true }), readConfiguration: () => config(f),
    readRequests: () => [], legacyPresent: () => false,
    // Deletion and private tmux shutdown above prove that no source executor remains.
    observe: () => [], lifecycle: { advanceReclaim: () => assert.fail('No runtime remains to reclaim') },
    convert: () => assert.fail('Native switching must not convert memory'),
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
    readMode: () => ({ mode: config(f).session_mode, keyPresent: true }), readEvents: () => events,
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

function nativePayload(f) {
  const memory = path.join(f.root, 'memory');
  const files = [];
  const visit = (directory, prefix = '') => {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name), relative = path.join(prefix, name);
      if (fs.statSync(file).isDirectory()) visit(file, relative);
      else files.push([relative, fs.readFileSync(file).toString('base64')]);
    }
  };
  visit(memory);
  return JSON.stringify({ memory: files, tables: Object.fromEntries(
    ['conversations', 'checkpoints', 'origin_sync_cursors'].map(table =>
      [table, f.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])) });
}
function assertNativeTransition(row) {
  assert.equal(row.kind, 'switch');
  for (const field of ['cutoff', 'coverage_snapshot', 'absorbed_ids']) assert.equal(row[field], null, field);
}

for (const entry of ['cli', 'dashboard']) {
  // Boundary: real deletion entry point -> private tmux/C4 -> native coordinator
  // -> CLI/doctor status. Run for deletion/native-cutover changes with the opt-in
  // gate and a separate Unix user. Actual cutover requires the upstream control
  // APIs that preserve Origin; until available, select only gating/cancel cases.
  // Fixture teardown stops every service and child before removing private data.
  test(`${entry} deletion permits repeated native cutovers with unchanged memory and coverage`, { skip: !enabled, timeout: 90_000 }, async t => {
    const f = await setup(t);
    await f.sandbox.runCase(async () => {
      await deletion(f, entry);
      const before = nativePayload(f), events = [], c = coordinator(f, events);
      for (const target of ['single', 'multi', 'single']) {
        const accepted = await c.handle({ target }); assert.equal(accepted.result, 'accepted');
        const done = await finish(f, c, accepted.runId); assertNativeTransition(done);
        assert.equal(config(f).session_mode, target); assert.equal(nativePayload(f), before);
        const observed = await status(f, events); assert.equal(observed.lastCompleted.runId, accepted.runId);
      }
      assert.equal(events.some(event => ['absorb', 'transition_cutover_failed'].includes(event.event)), false);
      assert.equal(f.database.prepare('SELECT content FROM conversations WHERE id=1').get().content, 'surviving old message');
      assert.equal(fs.existsSync(path.join(f.root, 'memory/state.md')), false);
      assert.equal(fs.existsSync(path.join(f.root, 'memory/mode-switch')), false);
      const pending = insert(f, 'dashboard:waiting', 'new work remains in its original group', 'pending');
      const queued = nativePayload(f);
      for (const target of ['multi', 'single']) {
        const accepted = await c.handle({ target }); assert.equal(accepted.result, 'accepted');
        assertNativeTransition(await finish(f, c, accepted.runId));
        assert.equal(nativePayload(f), queued);
      }
      assert.deepEqual(f.database.prepare('SELECT status,session_group FROM conversations WHERE id=?').get(pending),
        { status: 'pending', session_group: 'dashboard:waiting' });
      await status(f, events);
    }, { timeoutMs: 75_000 });
  });
}

// Boundary: physically empty current C4 after both Dashboard groups disappear,
// while a retained legacy global checkpoint remains. Run for deletion /
// empty-history changes with actual Origin-preserving cutover APIs available,
// under the same opt-in gate and full sandbox isolation; otherwise select gating.
for (const checkpointSource of ['cutover', 'single']) test(`${checkpointSource} checkpoint with no current messages leaves native cutoff unset`, { skip: !enabled, timeout: 90_000 }, async t => {
  const f = await setup(t, { noCurrentMessages: true, checkpointSource });
  await f.sandbox.runCase(async () => {
    await deletion(f, 'cli');
    assert.equal(f.database.prepare('SELECT count(*) AS n FROM conversations').get().n, 0);
    const before = nativePayload(f), events = [], c = coordinator(f, events);
    const accepted = await c.handle({ target: 'single' });
    const done = await finish(f, c, accepted.runId);
    assertNativeTransition(done); assert.equal(nativePayload(f), before);
    assert.equal(fs.existsSync(path.join(f.root, 'memory/state.md')), false);
    assert.equal(fs.existsSync(path.join(f.root, 'memory/mode-switch')), false);
    assert.equal(f.store.getGlobalCoverageEnd(), f.covered);
    await status(f, events);
  }, { timeoutMs: 75_000 });
});
