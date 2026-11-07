import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { chatEnabled, createChatSandbox } from './helpers/chat-integration-harness.js';
import { prepareNativeRuntimeResources, retainNativeFailure, runtimeProxyNames, waitForTtlRunEnding, writeNativeRuntimeManifest } from './helpers/chat-runtime-support.js';

// Claude: real Supervisor admission, Core receive/router/delivery and native
// Claude session, then Dashboard questions/answers and same-group continuation.
// Codex: the same path with a real Codex session, interleaved with a Claude
// canary group. Both require route/protocol/hook/answer/projection changes.
// TTL: native Claude session reclaimed by Supervisor TTL before answering;
// a fresh session receives the self-contained answer and historical reply route.
// Startup/lifecycle changes require it. CSS-only changes may skip all three.
// Every case skips BEFORE DB, HTTP or runtime allocation unless BOTH switches
// are enabled and a dedicated account fixture has been explicitly supplied.
// No live auth/home/history discovery occurs. ZYLOS_CHAT_RUNTIME_AUTH_DIR is an
// absolute dedicated directory containing claude/.credentials.json and
// codex/auth.json. Only those files are copied; history/settings stay behind.
// Set ZYLOS_CHAT_TMUX_BINARY to an absolute tmux executable. Optional absolute
// ZYLOS_CHAT_CLAUDE_BINARY / ZYLOS_CHAT_CODEX_BINARY select the native CLIs.
// Failures retain bounded logs/panes under the runner's retained TMPDIR, or
// explicit ZYLOS_CHAT_RUNTIME_EVIDENCE_DIR (outside repository and sandbox).
// Example (dedicated test Unix user only):
// ZYLOS_CHAT_INTEGRATION=1 ZYLOS_CHAT_RUNTIME=1 \
// ZYLOS_CHAT_RUNTIME_AUTH_DIR=/private/test-auth \
// ZYLOS_CHAT_TMUX_BINARY=/usr/bin/tmux node scripts/run-node-tests.js \
// skills/dashboard/test/chat-runtime.test.js
const enabled = chatEnabled(process.env, { runtime: true });
const authDirectory = process.env.ZYLOS_CHAT_RUNTIME_AUTH_DIR;
const driver = fileURLToPath(new URL('./helpers/chat-runtime-driver.js', import.meta.url));
const evidenceDirectory = path.resolve(process.env.ZYLOS_CHAT_RUNTIME_EVIDENCE_DIR || path.join(process.env.TMPDIR || '/tmp', 'chat-runtime-evidence'));

for (const [name, scenario, accounts] of [
  // Private HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR/socket/test DB readback before
  // allocation and launch; lifecycle owns children/server/DB/auth cleanup.
  ['Claude conversation completes the real structured answer chain', 'claude', ['claude']],
  // Private HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR/socket/test DB readback before
  // allocation and launch; lifecycle owns children/server/DB/auth cleanup.
  ['Codex conversation completes the real chain without crossing the Claude group', 'codex', ['claude', 'codex']],
  // Private HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR/socket/test DB readback before
  // allocation and launch; lifecycle owns children/server/DB/auth cleanup.
  ['TTL recovery keeps answer summary and historical reply in the original group', 'ttl', ['claude', 'codex']],
]) test(name, { skip: !enabled, timeout: 660_000 }, async t => {
  if (!authDirectory) { t.skip('Dedicated runtime authentication directory is not supplied'); return; }
  assert.ok(path.isAbsolute(authDirectory), 'Dedicated authentication directory must be absolute');
  const fixture = { tmuxBinary: process.env.ZYLOS_CHAT_TMUX_BINARY, evidenceDirectory };
  assert.ok(fixture.tmuxBinary && path.isAbsolute(fixture.tmuxBinary), 'Set an absolute ZYLOS_CHAT_TMUX_BINARY');
  for (const runtime of accounts) {
    const directory = path.join(authDirectory, runtime);
    const filename = path.join(directory, runtime === 'claude' ? '.credentials.json' : 'auth.json');
    if (!fs.existsSync(filename)) { t.skip(`Dedicated ${runtime} authentication file is not supplied`); return; }
    assert.ok(fs.statSync(filename).isFile(), 'Dedicated authentication must be a regular file');
    const binary = process.env[`ZYLOS_CHAT_${runtime.toUpperCase()}_BINARY`];
    if (binary) assert.ok(path.isAbsolute(binary), 'Native CLI override must be absolute');
    fixture[runtime] = { authDirectory: directory, ...(binary ? { binary } : {}) };
  }
  const sandbox = createChatSandbox(t, { runtime: true });
  const tmux = fixture.tmuxBinary;
  let completed = false, childResult;
  // A model CLI can outlive its launcher if it is held by a tmux daemon. The
  // parent owns this exact private socket even when the driver is timed out.
  sandbox.addCleanup(() => {
    const result = spawnSync(tmux, ['-S', sandbox.paths.socket, 'kill-server'], { env: sandbox.env,
      cwd: sandbox.paths.zylos, encoding: 'utf8', timeout: 5000, maxBuffer: 65536 });
    assert.ok(result.status === 0 || /no server running|No such file|error connecting/.test(result.stderr || ''), 'Private tmux cleanup confirmed');
  });
  // Added last: runs before kill-server, including after a driver timeout.
  sandbox.addCleanup(() => {
    if (completed) return;
    try {
      t.diagnostic(JSON.stringify({ runtimeFailureEvidence: retainNativeFailure(sandbox, { directory: evidenceDirectory,
        scenario: `${scenario}-parent`, tmuxBinary: tmux, error: childResult?.error || 'Native case did not complete',
        stdout: childResult?.stdout, stderr: childResult?.stderr }) }));
    } catch (error) { t.diagnostic(`Runtime failure evidence could not be retained: ${error.message}`); }
  });
  await sandbox.runCase(async () => {
    const child = sandbox.startChild(process.execPath, [driver, scenario, JSON.stringify(fixture), sandbox.root], {
      timeoutMs: 620_000, maxOutputBytes: 524288,
    });
    child.stdin.end();
    const result = await child.completion;
    childResult = result;
    assert.equal(result.code, 0, result.stderr.slice(-12000));
    assert.equal(result.outputExceeded, false);
    const line = result.stdout.split('\n').find(line => line.startsWith('CHAT_RUNTIME_RESULT '));
    assert.ok(line, 'Driver returned an actual completed-chain receipt');
    const receipt = JSON.parse(line.slice('CHAT_RUNTIME_RESULT '.length));
    assert.equal(receipt.scenario, scenario);
    assert.ok(receipt.answers >= 4, 'All supported question action types traversed the real model chain');
    assert.ok(receipt.assertions > 0);
    assert.equal(receipt.runtime, scenario === 'codex' ? 'codex' : 'claude');
    if (scenario === 'ttl') assert.equal(receipt.reclaimed, true);
    t.diagnostic(JSON.stringify(receipt));
    completed = true;
  }, { timeoutMs: 630_000 });
});

// Credential-free support cases exercise actual product launch preparation and
// failure collection. They use private HOME/ZYLOS_DIR/PM2_HOME/TMPDIR/socket/DB
// paths from the same proven sandbox, no model/auth/HTTP/default tmux server.
// Run for native environment/evidence changes; absent integration gate skips.
test('bounded Sync checkpoints retain a genuine startup route while full coverage removes it', { skip: !chatEnabled() }, async t => {
  const sandbox = createChatSandbox(t);
  const { default: Database } = await import('better-sqlite3');
  const { guardDatabase } = await import('../../comm-bridge/scripts/sqlite-schema.js');
  const schema = await import('../../comm-bridge/scripts/c4-schema.js');
  const { createStore } = await import('../../comm-bridge/scripts/c4-v2-store.js');
  const { emitC4Conversations } = await import('../../comm-bridge/scripts/c4-session-init.js');
  const { formatConversationsForAgent } = await import('../../comm-bridge/scripts/c4-db.js');
  const { buildReplyViaSuffix } = await import('../../comm-bridge/scripts/c4-utils.js');
  const database = sandbox.openDatabase(sandbox.paths.c4Db, filename => new Database(filename));
  guardDatabase(database, schema);
  const store = createStore(database, { validateComponent: () => true,
    readConfig: () => ({ state: 'ok', config: { runtime: 'claude', session_mode: 'multi' } }) });
  const endpoint = 'startup-route-fixture';
  const insertInput = content => {
    const row = store.insertConversation('in', 'dashboard', endpoint, content, { groupName: endpoint });
    assert.equal(store.claimConversation(row.id), true);
    assert.equal(store.markDelivered(row.id, { sessionId: 'private-native-session' }), true);
    return row;
  };
  const initial = insertInput('FIXTURE_BEGIN:startup-route-fixture');
  const sessionGroup = initial.session_group;
  const oldQuestion = { summary: 'original question summary must not reach startup', interruptId: 'original-interrupt-sentinel' };
  const questionRow = store.insertConversation('out', 'dashboard', endpoint,
    `${oldQuestion.summary}; ${oldQuestion.interruptId}`, { groupName: endpoint });
  assert.equal(store.getUnsummarizedRange(sessionGroup).safeEnd, questionRow.id);
  store.createCheckpoint(sessionGroup, questionRow.id, 'Dedicated fixture history processed; no pending business.');
  const anchors = Array.from({ length: 5 }, (_, index) => insertInput(`FIXTURE_ROUTE_ANCHOR:bounded:${index}`));
  for (let batch = 0; batch < 2; batch++) {
    const result = store.queries.unsummarized({ group: sessionGroup, limit: 2 });
    assert.equal(result.rows.length, 2);
    assert.equal(result.rows[0].id, anchors[batch * 2].id, 'Actual bounded query starts at the oldest uncovered row');
    assert.equal(result.upTo, anchors[batch * 2 + 1].id, 'Checkpoint target is the returned batch end, not the safe frontier');
    assert.equal(result.safeEnd, anchors[4].id);
    store.createCheckpoint(sessionGroup, result.upTo, 'Summary-free ordinary route anchors processed.');
  }
  const readStartup = () => emitC4Conversations({}, null, {
    withDb: async (_label, action) => action({
      getCoverageEnd: group => store.getCoverageEnd(group),
      getDeliveredSince: (...args) => store.getDeliveredSince(...args),
      formatConversationsForAgent,
    }),
    scopeReader: async () => ({ mode: 'multi', sessionGroup, scope: sessionGroup,
      root: sandbox.paths.zylos, memoryDir: path.join(sandbox.paths.zylos, 'memory/session-groups', sessionGroup) }),
  });
  assert.equal(store.getCoverageEnd(sessionGroup), anchors[3].id);
  const retained = store.getDeliveredSince(sessionGroup, store.getCoverageEnd(sessionGroup), { limit: 6 });
  assert.equal(retained.length, 1);
  assert.equal(retained[0].id, anchors[4].id);
  const startup = await readStartup();
  assert.ok(startup.includes(anchors[4].content));
  assert.ok(startup.includes(buildReplyViaSuffix('dashboard', endpoint)));
  assert.equal(startup.includes('--session-group'), false);
  for (const value of [oldQuestion.summary, oldQuestion.interruptId]) assert.equal(startup.includes(value), false);
  // Negative control reproduces the former one-anchor premise: real full
  // coverage legitimately leaves no route-bearing C4 input in startup.
  const remainder = store.queries.unsummarized({ group: sessionGroup, limit: 2 });
  assert.equal(remainder.rows.length, 1);
  store.createCheckpoint(sessionGroup, remainder.upTo, 'All ordinary history processed.');
  const coveredStartup = await readStartup();
  assert.equal(store.getDeliveredSince(sessionGroup, store.getCoverageEnd(sessionGroup), { limit: 6 }).length, 0);
  assert.equal(coveredStartup.includes('FIXTURE_ROUTE_ANCHOR:'), false);
  assert.equal(coveredStartup.includes('---- reply via:'), false);
});

test('TTL completion waits for the durable ending after the native identity disappears', { skip: !chatEnabled(), timeout: 5000 }, async t => {
  const sandbox = createChatSandbox(t);
  const { default: Database } = await import('better-sqlite3');
  const { guardDatabase } = await import('../../comm-bridge/scripts/sqlite-schema.js');
  const schema = await import('../../comm-bridge/scripts/c4-schema.js');
  const { createStore } = await import('../../comm-bridge/scripts/c4-v2-store.js');
  const { SupervisorLifecycle } = await import('../../activity-monitor/scripts/supervisor-lifecycle.js');
  const database = sandbox.openDatabase(sandbox.paths.c4Db, filename => new Database(filename));
  guardDatabase(database, schema);
  const store = createStore(database, { validateComponent: () => true,
    readConfig: () => ({ state: 'ok', config: { runtime: 'claude', session_mode: 'multi' } }) });
  const sessionGroup = 'dashboard:ttl-support', runId = 'current-native-run';
  store.recordRunEnd(sessionGroup, { runId: 'previous-native-run', reason: 'ttl' });
  store.takeSlot(sessionGroup, { runId, k: 1 });
  store.setDrainFence(sessionGroup, { runId, reason: 'ttl' });
  const scene = { sessionGroup, runId, sessionId: 'native-session', runtime: 'claude',
    present: true, ready: true, processRunning: true, state: 'idle', idleSince: 0 };
  let identity = scene, releaseEnding, stopped;
  const endingBarrier = new Promise(resolve => { releaseEnding = resolve; });
  const stopObserved = new Promise(resolve => { stopped = resolve; });
  const lifecycle = new SupervisorLifecycle({ db: store, observeGroup: () => identity,
    stop: () => { identity = { sessionGroup, present: false }; },
    intentionalStop: async () => { stopped(); await endingBarrier; },
    readSyncMarker: () => ({ held: false, stale: false }) }, { now: () => 10000 });
  const context = { configuration: { mode: 'multi' }, scenes: [scene],
    fences: store.listDrainFences(), restartRequests: [], transition: null };
  const reclaim = lifecycle.advanceReclaim(store.getDrainFence(sessionGroup), context);
  let waiter;
  try {
    await Promise.race([stopObserved, reclaim.then(() => assert.fail('Reclaim finished without reaching the stopped-before-ending barrier'))]);
    assert.equal(identity.present, false, 'The actual lifecycle already stopped the observed run');
    assert.equal(store.listRunEndings([sessionGroup]).some(row => row.runId === runId), false);
    assert.equal(store.listSlotOccupancy().some(row => row.runId === runId), true, 'The durable reclaim is not complete yet');
    let reads = 0, settled = false;
    waiter = waitForTtlRunEnding({ listRunEndings: groups => { reads++; return store.listRunEndings(groups); } },
      sessionGroup, runId, { timeoutMs: 1000 });
    waiter.then(() => { settled = true; }, () => { settled = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(reads, 1);
    assert.equal(settled, false, 'Identity disappearance and an older ending cannot satisfy the wait');
    releaseEnding();
    assert.equal(await reclaim, 'done');
    const ending = await waiter;
    assert.equal(ending.runId, runId);
    assert.equal(ending.reason, 'ttl');
    assert.equal(store.listSlotOccupancy().length, 0);
    assert.equal(store.getDrainFence(sessionGroup), null);
    store.recordRunEnd(sessionGroup, { runId: 'unexpected-native-run', reason: 'unexpected' });
    await assert.rejects(waitForTtlRunEnding(store, sessionGroup, 'unexpected-native-run'), /outside the real TTL path/);
    await assert.rejects(waitForTtlRunEnding(store, sessionGroup, 'absent-native-run', { timeoutMs: 1 }), /Timed out waiting/);
  } finally {
    releaseEnding();
    await reclaim.catch(() => {});
    await waiter?.catch(() => {});
  }
});

// Integration-gated private files and real launch preparation only; no model,
// default socket, external history or live instance is accessed.
test('native fixture shares Claude onboarding config and preserves proxy launch environment', { skip: !chatEnabled() }, async t => {
  const proxies = Object.fromEntries(runtimeProxyNames.map(key => [key, `http://fixture-${key}.invalid:8080`]));
  const sandbox = createChatSandbox(t, { gateEnv: { ...process.env, ...proxies } });
  const env = sandbox.env;
  const resources = prepareNativeRuntimeResources(sandbox);
  assert.equal(resources.agents.length, 3);
  for (const name of ['zylos-group-sync.md', 'zylos-origin-sync.md', 'zylos-global-sync.md']) {
    assert.ok(resources.agents.includes(name));
    assert.equal(fs.readFileSync(path.join(resources.destination, name), 'utf8'), fs.readFileSync(path.join(resources.source, name), 'utf8'));
  }
  assert.equal(resources.codexSkill, path.join(sandbox.paths.zylos, '.agents/skills/zylos-memory'));
  assert.equal(fs.realpathSync(resources.codexSkill), fs.realpathSync(resources.memorySkill));
  const memorySkill = fs.readFileSync(path.join(resources.codexSkill, 'SKILL.md'), 'utf8');
  assert.equal(memorySkill, fs.readFileSync(path.join(resources.memorySkill, 'SKILL.md'), 'utf8'));
  assert.match(memorySkill, /^---\nname: zylos-memory\n/);
  assert.equal(Object.hasOwn(env, 'CLAUDE_CONFIG_DIR'), false);
  fs.mkdirSync(path.join(sandbox.paths.zylos, '.zylos'), { recursive: true });
  writeNativeRuntimeManifest(sandbox.paths.zylos, path.dirname(process.execPath));
  const { launchEnvironment } = await import('../../../cli/lib/runtime/session-command.js');
  const launchEnv = launchEnvironment(sandbox.paths.zylos, env);
  assert.equal(launchEnv.HOME, sandbox.paths.home);
  assert.equal(Object.hasOwn(launchEnv, 'CLAUDE_CONFIG_DIR'), false);
  for (const key of runtimeProxyNames) { assert.equal(env[key], proxies[key]); assert.equal(launchEnv[key], proxies[key]); }
  const { ClaudeAdapter } = await import('../../../cli/lib/runtime/claude.js');
  const adapter = new ClaudeAdapter({ root: sandbox.paths.zylos, env: { ...env, CLAUDE_BIN: process.execPath },
    dependencies: { openTmuxConnection: async () => { const error = Error('Private preflight boundary'); error.code = 'TMUX_NO_SERVER'; throw error; } },
    runtimeExecutable: () => { throw Error('Stop after real onboarding, before runtime launch'); } });
  await assert.rejects(adapter.launch({ sessionGroup: null, runId: 'private-onboarding', sessionMode: 'single', launchConfig: { runtime: 'claude', mode: 'default' } }), { code: 'LAUNCH_FAILED' });
  const config = JSON.parse(fs.readFileSync(path.join(env.HOME, '.claude.json'), 'utf8'));
  assert.equal(config.hasCompletedOnboarding, true);
  assert.equal(config.projects[sandbox.paths.zylos].hasTrustDialogAccepted, true);
  assert.equal(fs.existsSync(path.join(env.HOME, '.claude/.claude.json')), false);
});

test('native failure evidence survives sandbox removal without copying auth or exceeding limits', { skip: !chatEnabled() }, async t => {
  const sandbox = createChatSandbox(t);
  const target = path.join(process.env.TMPDIR, 'native-evidence-support');
  const runtimeLog = path.join(sandbox.paths.zylos, 'activity-monitor/native-fixture.log');
  fs.mkdirSync(path.dirname(runtimeLog), { recursive: true });
  sandbox.env.HTTPS_PROXY = 'http://fixture-user:fixture-password@proxy.invalid:8080';
  const claudeCredentials = { claudeAiOauth: { accessToken: 'fixture-claude-access-value', refreshToken: 'fixture-claude-refresh-value' },
    nested: ['fixture-nested-"quoted"-secret'] };
  const codexCredentials = { tokens: { id_token: 'fixture-codex-id-value', account_id: 'fixture-codex-account-value' } };
  const credentialValues = [claudeCredentials.claudeAiOauth.accessToken, claudeCredentials.claudeAiOauth.refreshToken,
    ...claudeCredentials.nested, codexCredentials.tokens.id_token, codexCredentials.tokens.account_id];
  const claudeAuthFile = path.join(sandbox.paths.home, '.claude/.credentials.json');
  fs.writeFileSync(claudeAuthFile, JSON.stringify(claudeCredentials));
  fs.writeFileSync(path.join(sandbox.paths.home, '.codex/auth.json'), JSON.stringify(codexCredentials));
  const genericSecrets = ['sk-ant-oat01-fixture-bare-secret', 'sk-ant-fixture-environment-secret',
    'sk-ant-api03-fixture-api-secret', 'sk-ant-sid01-fixture-session-secret', 'eyJfixture.eyJpayload.fixturesignature'];
  const secretOutput = [JSON.stringify(claudeCredentials), JSON.stringify(codexCredentials), ...credentialValues,
    genericSecrets[0], `CLAUDE_CODE_OAUTH_TOKEN=${genericSecrets[1]}`, `x-api-key: ${genericSecrets[2]}`,
    `sessionKey=${genericSecrets[3]}`, `id-token: ${genericSecrets[4]}`, 'Bearer synthetic-bearer-secret',
    'refreshToken="synthetic-secret"', sandbox.env.HTTPS_PROXY].join('\n');
  fs.writeFileSync(runtimeLog, 'x'.repeat(100000) + '\n' + secretOutput);
  fs.symlinkSync(claudeAuthFile, path.join(sandbox.paths.zylos, 'activity-monitor/supervisor-events.jsonl'));
  const executable = path.join(sandbox.paths.tmp, 'capture-fixture');
  const commands = path.join(sandbox.paths.tmp, 'capture-commands.jsonl');
  fs.writeFileSync(executable, `#!${process.execPath}\nimport fs from 'node:fs';\nconst args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(commands)}, JSON.stringify(args)+'\\n');\nprocess.stdout.write(args.includes('list-panes')?'%1\\n%2\\n%3\\n%4\\n%5\\n%6\\n':${JSON.stringify('Synthetic model terminal\n' + secretOutput)});\n`, { mode: 0o700 });
  assert.throws(() => retainNativeFailure(sandbox, { directory: path.join(sandbox.root, 'forbidden-evidence'), scenario: 'controlled', tmuxBinary: executable }), /outlive the sandbox/);
  const receipt = retainNativeFailure(sandbox, { directory: target, scenario: 'controlled', tmuxBinary: executable,
    error: Error('controlled native failure\n' + secretOutput), stdout: secretOutput, stderr: secretOutput });
  assert.ok(receipt.files.includes('pane-1.log'));
  assert.ok(receipt.files.includes('activity-monitor_native-fixture.log'));
  assert.equal(receipt.files.includes('activity-monitor_supervisor-events.jsonl'), false, 'Credential-targeting log symlink is skipped');
  assert.equal(fs.existsSync(path.join(receipt.directory, 'activity-monitor_supervisor-events.jsonl')), false);
  const invocations = fs.readFileSync(commands, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(invocations.length, 5, 'At most four panes are captured');
  for (const args of invocations) { assert.equal(args[0], '-S'); assert.equal(args[1], sandbox.paths.socket); }
  for (const file of receipt.files) {
    const bytes = fs.readFileSync(path.join(receipt.directory, file));
    assert.ok(bytes.length <= 65536);
    for (const secret of ['synthetic-secret', 'synthetic-bearer-secret', sandbox.env.HTTPS_PROXY, ...credentialValues, ...genericSecrets]) {
      assert.equal(bytes.includes(secret), false, 'Captured output must not retain a synthetic credential');
      assert.equal(bytes.includes(JSON.stringify(secret).slice(1, -1)), false, 'JSON-escaped credential must also be redacted');
    }
  }
  const pane = fs.readFileSync(path.join(receipt.directory, 'pane-1.log'), 'utf8');
  assert.ok(pane.startsWith('Synthetic model terminal\n'));
  assert.ok(pane.includes('[REDACTED]'), 'The synthetic pane really contained credential-bearing output');
  await sandbox.close();
  assert.equal(fs.existsSync(sandbox.root), false);
  assert.equal(fs.existsSync(path.join(receipt.directory, 'failure.log')), true);
});
