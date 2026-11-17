import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createTestEnvironment } from '../../../../scripts/test-environment.js';
const environment = createTestEnvironment();
const { diagnoseMessage, readLaunchFailures } = await import('../c4-diagnose.js');
const { fixture } = await import('./c4-v2-test-helpers.js');
const { routerFixture } = await import('./helpers/router-fixture.js');
const { createRouterDiagnostics } = await import('../router/diagnostics.js');
const { createSessionReader } = await import('../../../../cli/lib/session-state-reader-async.js');
const { groupRunDir, routerDiagnosticPath } = await import('../../../../cli/lib/session-group-paths.js');
after(() => environment.cleanup());
const root = process.env.ZYLOS_DIR;
const cli = fileURLToPath(new URL('../c4-diagnose.js', import.meta.url));
const readMode = () => ({ mode: 'multi' });
const absent = { readSessionState: async () => ({ identity: { present: false, ready: false, runtime: 'unknown' }, status: { valid: false } }) };
const digest = filename => createHash('sha256').update(fs.readFileSync(filename)).digest('hex');

// Real Router failure -> durable SQLite -> diagnostic writer/reader; no external
// runtime or transport. Run for diagnostic field/event/lookup changes only.
test('diagnostics join failed-message metadata with real Router launch events without reading bodies', async t => {
  const f = routerFixture(t); f.put('origin'); const row = f.add('diagnostic-group');
  const logEnv = { ...process.env, ZYLOS_DIR: fs.mkdtempSync(path.join(environment.root, 'diagnostic-router-')) };
  const diagnostics = createRouterDiagnostics({ env: logEnv });
  f.deps.diagnostic = diagnostics.diagnostic;
  f.deps.getSessionAdapter = () => ({ launch: async () => { throw Object.assign(Error('SECRET exception'), {
    code: 'LAUNCH_FAILED', cause: 'timeout', launchTiming: { preflight_ms: 8000, new_session_ms: 1999,
      executor_init_ms: 0, exec_confirm_ms: 0, cleanup_ms: 1, total_ms: 10000, timeout_ms: 10000, last_phase: 'new_session' },
  }); }, stop: async () => {} });
  await f.create().initialize(); await f.rounds(6);
  assert.equal(f.row(row.id).status, 'failed');
  const result = await diagnoseMessage(row.id, { connection: f.sqlite, reader: absent, readMode, logFile: routerDiagnosticPath(logEnv) });
  assert.equal(result.message.reason, 'launch_failed');
  assert.equal(result.message.status, 'failed');
  assert.equal(result.message.retry_count, 2);
  assert.equal(result.message.alert_state, 'pending');
  assert.equal(result.launch_failures.events.length, 2);
  assert.deepEqual(result.launch_failures.events.map(event => event.attempt), [1, 2]);
  for (const event of result.launch_failures.events) {
    assert.equal(event.event, 'session_launch_failed');
    assert.equal(event.last_phase, 'new_session');
    assert.equal(event.cause, 'timeout');
    assert.equal(event.preflight_ms, 8000);
    assert.equal(event.total_ms, 10000);
  }
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
  assert.equal(Object.hasOwn(result.message, 'content'), false);
});

test('current target state uses Core identity and freshness validation and projects no tool details', async t => {
  const f = fixture(t), row = f.store.insertConversation('in', 'chat', 'private', 'SECRET body');
  const identity = { present: true, ready: true, runId: 'current-run', sessionId: 'current-session', runtime: 'claude' };
  const filename = path.join(groupRunDir(row.session_group), 'agent-status.json');
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, JSON.stringify({ ...identity, state: 'busy', health: 'ok', active_tool_details: ['SECRET tool'] }));
  const reader = createSessionReader({ open: async () => ({ close() {} }), observe: async () => identity });
  const result = await diagnoseMessage(row.id, { connection: f.db, reader, readMode });
  assert.equal(result.target.present, true);
  assert.equal(result.target.ready, true);
  assert.equal(result.target.status_valid, true);
  assert.equal(result.target.state, 'busy');
  assert.equal(result.target.health, 'ok');
  assert.equal(JSON.stringify(result.target).includes('SECRET'), false);
  fs.utimesSync(filename, new Date(0), new Date(0));
  const stale = await diagnoseMessage(row.id, { connection: f.db, reader, readMode });
  assert.equal(stale.target.status_valid, false);
  assert.equal(stale.target.state, null);
});

test('unobservable targets stay unknown and single mode observes Origin rather than the stored group', async t => {
  const f = fixture(t), row = f.store.insertConversation('in', 'chat', 'private', 'SECRET body');
  let observed;
  const reader = { readSessionState: async group => { observed = group; throw Error('SECRET observation'); } };
  const result = await diagnoseMessage(row.id, { connection: f.db, reader, readMode: () => ({ mode: 'single' }) });
  assert.equal(observed, null);
  assert.equal(result.target.observation, 'unknown');
  assert.equal(result.target.present, null);
  assert.equal(result.target.ready, null);
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
  const legacy = await diagnoseMessage(row.id, { connection: f.db, reader: absent, readMode });
  assert.equal(legacy.message.reason, null);
});

test('retained Router logs are bounded, skip other IDs and incomplete lines, and project fixed fields only', async t => {
  const dir = fs.mkdtempSync(path.join(environment.root, 'diagnostic-logs-'));
  const file = path.join(dir, 'router-events.jsonl');
  const diagnostics = createRouterDiagnostics({ stream: { append: value => fs.appendFileSync(file, JSON.stringify(value) + '\n') }, receiveStream: {} });
  await diagnostics.diagnostic('session_launch_failed', { conversation_id: 77, cause: 'timeout', last_phase: 'preflight', total_ms: 5 });
  fs.renameSync(file, path.join(dir, 'router-events.100.jsonl'));
  for (let n = 0; n < 25; n++) await diagnostics.diagnostic('session_launch_failed', {
    conversation_id: 77, attempt: n + 1, cause: n ? 'timeout' : 'SECRET cause', last_phase: 'exec_confirm',
    preflight_ms: 2, new_session_ms: 3, executor_init_ms: 4, exec_confirm_ms: 5, cleanup_ms: 6,
    total_ms: 20, timeout_ms: 10000, script: 'SECRET script', environment: 'SECRET environment', content: 'SECRET body' });
  await diagnostics.diagnostic('session_launch_failed', { conversation_id: 78, total_ms: 999 });
  fs.appendFileSync(file, '{"event":"session_launch_failed","conversation_id":77');
  const result = await readLaunchFailures(77, file);
  assert.equal(result.events.length, 20);
  assert.equal(result.limited, true);
  assert.equal(result.events[0].attempt, 6);
  assert.equal(result.events.at(-1).attempt, 25);
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
  const rotatedOnly = await readLaunchFailures(77, path.join(dir, 'unused.jsonl'));
  assert.equal(rotatedOnly.events.length, 0);
  fs.writeFileSync(file, '');
  const older = await readLaunchFailures(77, file);
  assert.equal(older.events.length, 1);
  assert.equal(older.events[0].last_phase, 'preflight');
  await diagnostics.diagnostic('session_launch_failed', { conversation_id: 77, cause: 'SECRET cause',
    last_phase: 'SECRET phase', new_session_ms: -1, total_ms: 'SECRET duration' });
  const projected = await readLaunchFailures(77, file);
  const invalid = projected.events.at(-1);
  assert.equal(invalid.cause, null);
  assert.equal(invalid.last_phase, null);
  assert.equal(Object.hasOwn(invalid, 'new_session_ms'), false);
  assert.equal(Object.hasOwn(invalid, 'total_ms'), false);
  assert.equal(JSON.stringify(projected).includes('SECRET'), false);
});

// Real installed-entry subprocess -> readonly private DB + Core default reader.
// HOME/ZYLOS_DIR/PM2_HOME/TMPDIR and TMUX_TMPDIR are fixture-owned and read back
// before spawning. No server exists on that private default socket, and -N
// observations cannot create one. Run when the diagnostic CLI/guide changes;
// skip unrelated UI changes. Fixture teardown closes DB and removes private trees.
test('documented diagnose command reads private SQLite and private tmux without mutating message state', async t => {
  const guide = fs.readFileSync(new URL('../../references/delivery-failure-receipts.md', import.meta.url), 'utf8');
  assert.ok(guide.includes('node ~/zylos/.claude/skills/comm-bridge/scripts/c4-diagnose.js --id ID'));
  for (const field of ['session_launch_failed', 'preflight_ms', 'new_session_ms', 'executor_init_ms',
    'exec_confirm_ms', 'cleanup_ms', 'total_ms', 'timeout_ms', 'last_phase', 'cause', 'attempt', 'run_id',
    'conversation_id', 'alert_state', 'status_valid']) assert.ok(guide.includes(field), field);
  assert.ok(guide.includes('reason=null'));
  assert.ok(guide.includes('observation=unknown'));
  assert.ok(guide.includes('limited=true'));

  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME']) assert.ok(process.env[key].startsWith(environment.root + path.sep), key);
  assert.ok(process.env.TMPDIR.startsWith('/tmp/'));
  const databasePath = path.join(root, 'comm-bridge', 'c4.db');
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  fs.mkdirSync(path.join(root, '.zylos'), { recursive: true });
  fs.writeFileSync(path.join(root, '.zylos', 'config.json'), '{"session_mode":"multi","runtime":"claude"}');
  const f = fixture(t, {}, databasePath);
  const row = f.store.insertConversation('in', 'chat', 'diagnostic-private', 'SECRET body');
  f.store.claimConversation(row.id);
  f.store.failDelivery(row.id, { maxRetries: 1, reason: 'delivery_failed' });
  const socketRoot = path.join(environment.root, 'tmux'); fs.mkdirSync(socketRoot);
  const socket = path.join(socketRoot, `tmux-${process.getuid()}`, 'default');
  assert.ok(Buffer.byteLength(socket) < 104);
  assert.equal(fs.existsSync(socket), false);
  const env = { ...process.env, TMUX_TMPDIR: socketRoot };
  delete env.TMUX; delete env.TMUX_PANE;
  const before = digest(databasePath);
  const run = args => spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8', timeout: 10000, maxBuffer: 65536 });
  const help = run(['--help']); assert.equal(help.status, 0); assert.match(help.stdout, /c4-diagnose.js --id ID/);
  const result = run(['--id', String(row.id)]);
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.data.message.reason, 'delivery_failed');
  assert.equal(parsed.data.message.status, 'failed');
  assert.equal(parsed.data.target.observation, 'observed');
  assert.equal(parsed.data.target.present, false);
  assert.equal(result.stdout.includes('SECRET'), false);
  assert.equal(digest(databasePath), before);
  assert.equal(fs.existsSync(socket), false);
  for (const args of [['--id', '0'], ['--id', '1;SELECT'], ['--body'], ['--id', '999999']]) {
    const invalid = run(args); assert.equal(invalid.status, 1); assert.equal(JSON.parse(invalid.stdout).ok, false);
    assert.equal(invalid.stdout.includes('SECRET'), false);
  }
  t.diagnostic(JSON.stringify({ databasePath, socket, unchanged: true, event: 'session_launch_failed' }));
});
