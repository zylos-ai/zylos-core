import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createChatSandbox } from './chat-integration-harness.js';
import { prepareNativeRuntimeResources, retainNativeFailure, waitForTtlRunEnding, writeNativeRuntimeManifest } from './chat-runtime-support.js';

// A standalone process is required: product configuration modules capture env
// on first import. No module is re-evaluated and no production source is edited.
const [scenario, fixtureConfiguration, parentRoot] = process.argv.slice(2);
assert.ok(['claude', 'codex', 'ttl', 'attachments-claude', 'attachments-codex-fleet'].includes(scenario));
const attachmentScenario = scenario.startsWith('attachments-');
// Parent passes only explicit source paths and executable paths, never secrets.
const fixture = JSON.parse(fixtureConfiguration);
const sandbox = createChatSandbox(null, { runtime: true, existingRoot: parentRoot });
assert.ok(sandbox);
const packageRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const root = sandbox.paths.zylos;
const bin = path.join(root, 'bin');
fs.mkdirSync(bin, { recursive: true });
const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const tmuxBinary = fixture.tmuxBinary;
// The native startup hooks call tmux without passing options. A private PATH
// wrapper selects this same proven socket for those existing product calls.
// The executable still is the real tmux binary; no protocol behavior is mocked.
assert.ok(path.isAbsolute(tmuxBinary), 'Fixture must identify the real tmux binary by absolute path');
fs.writeFileSync(path.join(bin, 'tmux'), `#!/bin/sh\nexec ${shellQuote(tmuxBinary)} -S ${shellQuote(sandbox.paths.socket)} "$@"\n`, { mode: 0o700 });
fs.symlinkSync(process.execPath, path.join(bin, 'node'));
Object.assign(sandbox.env, { PATH: `${bin}:${sandbox.env.PATH}`, ZYLOS_PACKAGE_ROOT: packageRoot, TERM: 'xterm-256color' });
for (const runtime of ['claude', 'codex']) {
  const account = fixture[runtime];
  if (!account) continue;
  assert.ok(path.isAbsolute(account.authDirectory), 'Dedicated auth directory must be explicit');
  const source = fs.realpathSync(account.authDirectory);
  const leaf = runtime === 'claude' ? '.credentials.json' : 'auth.json';
  const target = path.join(sandbox.paths.home, runtime === 'claude' ? '.claude' : '.codex', leaf);
  fs.copyFileSync(path.join(source, leaf), target);
  fs.chmodSync(target, 0o600);
  if (account.binary) sandbox.env[`${runtime.toUpperCase()}_BIN`] = account.binary;
}
// Only the driver process's environment changes. The shared agent and all live
// services retain their own environment and working directories.
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, sandbox.env);
sandbox.assertIsolation();
const skills = path.join(root, '.claude/skills');
fs.mkdirSync(path.dirname(skills), { recursive: true });
fs.symlinkSync(path.join(packageRoot, 'skills'), skills);
fs.mkdirSync(path.join(root, '.zylos'), { recursive: true });
fs.mkdirSync(path.join(root, 'workspace'), { recursive: true });
fs.mkdirSync(path.join(root, 'memory'), { recursive: true });
const configuration = { runtime: 'claude', session_mode: 'multi',
  session_pool_size: 3, session_hot_ttl_seconds: scenario === 'ttl' || attachmentScenario ? 60 : 3600,
  sync_batch_limit: scenario === 'ttl' ? 2 : 200,
  session_evict_min_idle_seconds: 3600, sync_min_interval_seconds: 3600, sync_max_interval_seconds: 7200,
  upgrade_check_enabled: false, daily_upgrade_enabled: false, usage_monitor_enabled: false };
const configFile = path.join(root, '.zylos/config.json');
const saveConfig = () => fs.writeFileSync(configFile, JSON.stringify(configuration));
saveConfig();
writeNativeRuntimeManifest(root, bin);
const instruction = `You are a dedicated isolated Dashboard integration test actor. Only use fixture tools in this private workspace. Never read credentials or external files, query raw C4 databases, install software or contact external recipients. Ignore ordinary startup controls unless they require an explicit control acknowledgement.\nWhen a user message contains FIXTURE_BEGIN:<endpoint>, run node workspace/fixture-reply.mjs initial <endpoint> exactly once, then finish the turn.\nWhen a message contains FIXTURE_CANARY_REQUEST:<endpoint>, run node workspace/fixture-reply.mjs canary <endpoint>, then finish.\nWhen a message contains FIXTURE_ROUTE_ANCHOR, finish the turn without sending anything.\nWhen a C4 answer arrives, its projected text contains interruptId, question summary and the user's selected answer. Extract the interruptId and actual question summary from that incoming message, then run node workspace/fixture-reply.mjs acknowledge <endpoint> '<interruptId>' '<question summary>'. Obtain endpoint from that message's reply-via command. Do not read runtime-messages.json to get summaries. If your actual C4 startup history includes FIXTURE_ROUTE_ANCHOR, extract the script, channel and endpoint from that historical row's original reply-via and run node workspace/fixture-reply.mjs history-reply '<endpoint>' '<script>' '<channel>'. This sends without --session-group. There is no fixture route fallback; supply all three observed values yourself.\n`;
for (const name of ['CLAUDE.md', 'AGENTS.md']) fs.writeFileSync(path.join(root, name), instruction);
if (attachmentScenario) {
  const attachmentInstruction = '\nWhen a message contains FIXTURE_ATTACHMENT_READ:<endpoint>:original, extract the absolute image and file paths from that incoming message\'s attachment annotations. For FIXTURE_ATTACHMENT_READ:<endpoint>:fresh, the new message has no attachments: run the exact bounded c4-fetch.js --begin ID --end ID history command provided in that message, and extract the two paths from the original historical row\'s annotations, not from an earlier reply. Then run node workspace/fixture-attachment-reply.mjs <endpoint> <phase> <image-path> <file-path> exactly once. Supply the actual observed paths, never invent paths or query a database directly, and do not read fixture-attachment-observed files for paths. This helper reads the bytes, registers private reply copies and sends one mixed image/file envelope. For FIXTURE_ATTACHMENT_IDLE, finish without sending.\n';
  for (const name of ['CLAUDE.md', 'AGENTS.md']) fs.appendFileSync(path.join(root, name), attachmentInstruction);
  fs.copyFileSync(new URL('./chat-runtime-attachment-reply.js', import.meta.url), path.join(root, 'workspace/fixture-attachment-reply.mjs'));
}
for (const name of ['identity.md', 'state.md', 'references.md']) fs.writeFileSync(path.join(root, 'memory', name), name === 'state.md' ? '# State\nNo prior tasks.\n' : '# Dedicated test fixture\n');
fs.copyFileSync(new URL('./chat-runtime-reply.js', import.meta.url), path.join(root, 'workspace/fixture-reply.mjs'));

let dispatcher, supervisor, coreDb;
let assertions = 0, answersCompleted = 0, reclaimed = false;
const fixtureLog = path.join(root, 'activity-monitor/native-fixture.log');
fs.mkdirSync(path.dirname(fixtureLog), { recursive: true });
let fixtureLogTail = '';
const log = (...values) => {
  fixtureLogTail = (fixtureLogTail + `[${new Date().toISOString()}] ${values.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join(' ')}\n`).slice(-65536);
  fs.writeFileSync(fixtureLog, fixtureLogTail, { mode: 0o600 });
};
const check = (condition, message) => { assertions++; assert.ok(condition, message); };
const tmuxOptions = { binary: tmuxBinary, socketPath: sandbox.paths.socket, configFile: '/dev/null', timeoutMs: 5000 };
const wait = async (predicate, label, timeoutMs = 90000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await delay(100);
  }
  throw Error(`Timed out waiting for ${label}`);
};
try {
  const load = relative => import(pathToFileURL(path.join(packageRoot, relative)).href);
  const { syncRuntimeHooks } = await load('cli/lib/sync-runtime-hooks.js');
  const { writeCodexConfig } = await load('cli/lib/runtime-setup.js');
  // These functions configure only the already-created private fixture homes.
  syncRuntimeHooks({ zylosDir: root, stopFailureSupported: true, log() {} });
  const resources = prepareNativeRuntimeResources(sandbox);
  check(resources.agents.length === 3 && resources.agents.every(name => fs.existsSync(path.join(resources.destination, name))), 'Packaged memory agents installed for native Sync');
  check(fs.realpathSync(resources.codexSkill) === fs.realpathSync(resources.memorySkill)
    && fs.existsSync(path.join(resources.codexSkill, 'SKILL.md')), 'Codex project skill discovery has packaged memory skill');
  check(writeCodexConfig(root, { bypassPermissions: true }), 'Native Codex test hooks configured');
  const { createChatApiFixture } = await import('./chat-integration-api.js');
  const { runtimeMessages, runtimeAnswer } = await import('./chat-runtime-messages.js');
  const api = await createChatApiFixture(null, sandbox);
  saveConfig();
  // Replace only the fixture adapter with the exact production installed-Core
  // loader. All receive, route IPC, scheduling and terminal I/O stay real.
  const { ChatSender } = await load('skills/dashboard/src/lib/chat/send.js');
  const actualCore = await new ChatSender({ zylosDir: root }).loadCore();
  api.setInvoke(args => actualCore.receive(args));
  coreDb = await load('skills/comm-bridge/scripts/c4-db.js');
  const { getSessionAdapter } = await load('cli/lib/runtime/index.js');
  const { SupervisorScenes } = await load('skills/activity-monitor/scripts/supervisor-scenes.js');
  const { startSupervisor } = await load('skills/activity-monitor/scripts/supervisor-main.js');
  const { createDispatcher } = await load('skills/comm-bridge/scripts/router/factory.js');
  let liveSupervisor;
  const scenes = new SupervisorScenes({ env: process.env, connectionOptions: tmuxOptions,
    readMode: () => ({ mode: 'multi' }), readActivity: scene => liveSupervisor?.readActivity(scene) });
  supervisor = await startSupervisor({ env: process.env, scenes, log });
  liveSupervisor = supervisor.supervisor;
  dispatcher = createDispatcher({ env: process.env, log,
    getSessionAdapter: runtime => getSessionAdapter(runtime, { root, env: process.env, tmux: tmuxOptions }),
  }, { tmux: tmuxOptions });
  await dispatcher.start();
  if (attachmentScenario) {
    const { runRuntimeAttachments } = await import('./chat-runtime-attachments.js');
    const receipt = await runRuntimeAttachments({ api, sandbox, root, scenario, configuration, saveConfig,
      scenes, coreDb, check, wait });
    console.log('CHAT_RUNTIME_RESULT ' + JSON.stringify({ ...receipt, scenario, assertions, resources: sandbox.counts }));
  } else {
  const payloadFile = path.join(root, 'workspace/runtime-messages.json');
  const payload = { groups: {} };
  const persistPayload = () => {
    const temporary = `${payloadFile}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(payload)); fs.renameSync(temporary, payloadFile);
  };
  const createDraft = async name => {
    const response = await api.request('/api/chat/drafts', { method: 'POST', body: { displayName: name } });
    check(response.status === 201, 'Draft accepted through real HTTP');
    return response.body.conversation;
  };
  const sendText = async (conversation, content) => {
    const response = await api.request(`/api/chat/conversations/${encodeURIComponent(conversation.id)}/send`, { method: 'POST', body: { content }, timeoutMs: 45000 });
    check(response.status === 200, 'Inbound message committed through real HTTP/Core');
    return api.conversations.get(conversation.localId);
  };
  const outbound = group => api.db.prepare("SELECT id,content,endpoint_id,session_group FROM conversations WHERE session_group=? AND direction='out' ORDER BY id").all(group);
  const countGroup = group => api.db.prepare('SELECT count(*) AS n FROM conversations WHERE session_group=?').get(group).n;
  let canary;
  if (scenario !== 'claude') {
    configuration.runtime = scenario === 'ttl' ? 'codex' : 'claude'; saveConfig();
    canary = await createDraft(`${configuration.runtime} canary`);
    payload.groups[canary.localId] = { messages: [], questions: [] }; persistPayload();
    canary = await sendText(canary, `FIXTURE_CANARY_REQUEST:${canary.localId}`);
    await wait(() => outbound(canary.sessionGroup).find(row => row.content.includes(`FIXTURE_CANARY:${canary.localId}`)), 'other-runtime canary response', 180000);
    coreDb.setSessionRuntimeConfig({ sessionGroup: canary.sessionGroup, runtime: scenario === 'ttl' ? 'codex' : 'claude' });
  }
  const runtime = scenario === 'codex' ? 'codex' : 'claude';
  configuration.runtime = runtime; saveConfig();
  // createChatApiFixture owns the same mode/config file. Keep its readMode and
  // production Core configuration aligned after the fixture initialized it.
  const conversation = await createDraft(`${runtime} structured chain`);
  const { nonce, questions, messages } = runtimeMessages();
  const { CONTENT_PREFIX, parseC4Content } = await load('skills/comm-bridge/scripts/c4-content-schema.js');
  payload.groups[conversation.localId] = { messages, questions }; persistPayload();
  let current = await sendText(conversation, `FIXTURE_BEGIN:${conversation.localId}`);
  coreDb.setSessionRuntimeConfig({ sessionGroup: current.sessionGroup, runtime });
  await wait(() => outbound(current.sessionGroup).some(row => row.content.includes(`FIXTURE_SUPPLEMENT:${current.localId}`)), 'real model structured sends', 180000);
  const route = `/api/chat/conversations/${encodeURIComponent(current.id)}`;
  const beforeAnswer = await api.request(`${route}/questions`);
  check(beforeAnswer.status === 200, 'Refreshed question state is readable');
  check(beforeAnswer.body.items.length === 4, 'All action categories registered');
  check(beforeAnswer.body.items.every(item => item.status === 'paused'), 'Supplementary text leaves every question paused');
  check(outbound(current.sessionGroup).some(row => row.content.includes(`FIXTURE_TEXT:${nonce}`)), 'Plain model output stored');
  check(outbound(current.sessionGroup).some(row => parseC4Content(row.content).envelope?.blocks?.some(block => block.type === 'time_series')), 'Chart model output stored');
  let oldIdentity = await scenes.readIdentity(current.sessionGroup);
  check(oldIdentity.ready && oldIdentity.runtime === runtime, 'Real native runtime reached READY in multi group');
  if (scenario === 'ttl') {
    const { GROUP_SYNC_PROMPT, PRE_RECLAIM_SYNC_PROMPT } = await load('skills/zylos-memory/scripts/sync-prompts.js');
    const { readSyncMarker } = await load('skills/zylos-memory/scripts/sync-lock.js');
    const { emitC4Conversations } = await load('skills/comm-bridge/scripts/c4-session-init.js');
    const { groupRunDir } = await load('cli/lib/session-group-paths.js');
    const controls = prompt => api.db.prepare('SELECT id,status FROM control_queue WHERE session_group=? AND raw_content=? ORDER BY id')
      .all(current.sessionGroup, prompt);
    const assertPreparing = async () => {
      assert.equal(controls(PRE_RECLAIM_SYNC_PROMPT).length, 0, 'TTL preparation started before route-history fixture was ready');
      const identity = await scenes.readIdentity(current.sessionGroup);
      assert.ok(identity.present && identity.runId === oldIdentity.runId, 'Native run changed during route-history preparation');
    };
    await wait(async () => {
      await assertPreparing();
      return api.db.prepare("SELECT id FROM conversations WHERE session_group=? AND direction='in' AND content=? AND status='delivered'")
        .get(current.sessionGroup, `FIXTURE_BEGIN:${current.localId}`);
    }, 'initial input delivery before fixture checkpoint');
    // Keep fixture bookkeeping out of model context while exercising the real
    // TTL lifecycle. The fixture checkpoint contains no question summaries;
    // the actual C4 startup readback below proves they are absent from its tail.
    await wait(async () => {
      await assertPreparing();
      const ordinary = controls(GROUP_SYNC_PROMPT);
      assert.ok(ordinary.length <= 1, 'Unexpected repeated ordinary Group Sync during fixture preparation');
      const marker = readSyncMarker({ runDir: groupRunDir(current.sessionGroup), kind: 'group', currentRunId: oldIdentity.runId });
      // Control delivery alone does not mean its background worker finished.
      // A real checkpoint followed by marker removal proves checkpoint/release.
      // If no control exists yet, checkpoint synchronously before it can launch
      // a worker and fetch the old range. Do not await between this read/write.
      if (ordinary.length && (ordinary[0].status !== 'done' || coreDb.getCoverageEnd(current.sessionGroup) === 0 || marker.reason !== 'missing')) return false;
      if (!ordinary.length && marker.reason !== 'missing') return false;
      assert.equal(controls(PRE_RECLAIM_SYNC_PROMPT).length, 0, 'TTL preparation overtook the fixture checkpoint');
      const range = coreDb.getUnsummarizedRange(current.sessionGroup);
      const questionEnd = Math.max(...outbound(current.sessionGroup).map(row => row.id));
      check(range.safeEnd >= questionEnd, 'Fixture checkpoint frontier covers the original question outputs');
      coreDb.createCheckpoint(current.sessionGroup, range.safeEnd, 'Dedicated fixture history processed; no pending business.');
      check(coreDb.getCoverageEnd(current.sessionGroup) >= questionEnd, 'Original question history is outside the startup tail');
      return true;
    }, 'initial Group Sync checkpoint and released marker before fixture checkpoint', 240000);
    // Existing Sync procedures consume one bounded oldest-first batch. At most
    // one ordinary batch and one pre-TTL batch of two leave one of five genuine
    // delivered inputs available to startup. Final readback verifies the result.
    const anchors = Array.from({ length: 5 }, (_, index) => `FIXTURE_ROUTE_ANCHOR:${nonce}:${index}`);
    for (const anchor of anchors) {
      await assertPreparing();
      current = await sendText(current, anchor);
    }
    await wait(async () => {
      await assertPreparing();
      return anchors.every(anchor => api.db.prepare("SELECT id FROM conversations WHERE session_group=? AND direction='in' AND content=? AND status='delivered'")
        .get(current.sessionGroup, anchor));
    }, 'all ordinary route anchors delivered before TTL');
    await assertPreparing();
    const preparedIdentity = await scenes.readIdentity(current.sessionGroup);
    check(preparedIdentity.present && preparedIdentity.ready && preparedIdentity.runId === oldIdentity.runId, 'All route anchors belong to the original ready native session');
    const ending = await waitForTtlRunEnding(coreDb, current.sessionGroup, oldIdentity.runId);
    check(ending.reason === 'ttl' && !(await scenes.readIdentity(current.sessionGroup)).present, 'The original run completed the real TTL path');
    const coverage = coreDb.getCoverageEnd(current.sessionGroup);
    const tail = coreDb.getDeliveredSince(current.sessionGroup, coverage, { limit: 6 });
    check(tail.some(row => row.direction === 'in' && anchors.includes(row.content)), 'Real Sync leaves a delivered route anchor above actual coverage');
    // Assertion only: never feed this readback or a saved route to the model.
    const startup = await emitC4Conversations({}, null, {
      withDb: async (_label, action) => action(coreDb),
      scopeReader: async () => ({ mode: 'multi', sessionGroup: current.sessionGroup,
        scope: current.sessionGroup, root, memoryDir: path.join(root, 'memory/session-groups', current.sessionGroup) }),
    });
    check(anchors.some(anchor => startup.includes(anchor)), 'Actual startup formatter includes retained ordinary history');
    check(startup.includes(`reply via: node ${path.join(packageRoot, 'skills/comm-bridge/scripts/c4-send.js')} "dashboard" "${current.localId}"`)
      && !startup.includes('--session-group'), 'Actual startup retains the historical endpoint-only reply route');
    check(questions.every(question => !startup.includes(question.questionSummary) && !startup.includes(question.interruptId)), 'Actual startup contains no original pending question summary or interrupt ID');
    const restored = await api.request(`${route}/questions`);
    check(restored.body.items.length === 4 && restored.body.items.every(item => item.status === 'paused'), 'TTL preserves question lifecycle');
    reclaimed = true;
  }
  for (const question of questions) {
    if (canary) {
      const previousReplies = outbound(canary.sessionGroup).filter(row => row.content.includes(`FIXTURE_CANARY:${canary.localId}`)).length;
      canary = await sendText(canary, `FIXTURE_CANARY_REQUEST:${canary.localId}`);
      await wait(() => outbound(canary.sessionGroup).filter(row => row.content.includes(`FIXTURE_CANARY:${canary.localId}`)).length > previousReplies, 'interleaved canary response');
    }
    const canaryCount = canary ? countGroup(canary.sessionGroup) : 0;
    const action = runtimeAnswer(question);
    const response = await api.request(`${route}/answers`, { method: 'POST', body: { interruptId: question.interruptId, action }, timeoutMs: 45000 });
    check(response.status === 200, 'Answer accepted through real HTTP/Core');
    const marker = `FIXTURE_ANSWER_ACK:${question.interruptId}:${question.questionSummary}`;
    await wait(() => outbound(current.sessionGroup).some(row => row.content.includes(marker)), 'same-group model answer acknowledgement');
    if (scenario === 'ttl' && answersCompleted === 0) {
      await wait(() => outbound(current.sessionGroup).some(row => row.content.includes(`FIXTURE_HISTORY_REPLY:${current.localId}`)), 'restored native startup-history route reply');
      check(!outbound(canary.sessionGroup).some(row => row.content.includes(`FIXTURE_HISTORY_REPLY:${current.localId}`)), 'Historical endpoint-only reply stayed in the original group');
    }
    const rows = api.db.prepare("SELECT content FROM conversations WHERE session_group=? AND direction='in' ORDER BY id").all(current.sessionGroup)
      .map(row => parseC4Content(row.content)).filter(parsed => parsed.envelope?.kind === 'answer' && parsed.envelope.interruptId === question.interruptId);
    check(rows.length === 1, 'Exactly one original-group answer row');
    check(rows[0].envelope.questionSummary === question.questionSummary, 'Answer carries the saved question summary');
    check(!outbound(current.sessionGroup).some(row => row.content.includes(`DO_NOT_PROJECT_${nonce}`) && !row.content.startsWith(CONTENT_PREFIX)), 'Model acknowledgements did not expose host metadata');
    if (canary) {
      check(!outbound(canary.sessionGroup).some(row => row.content.includes(marker)), 'Answer never reached the other runtime group');
      check(countGroup(canary.sessionGroup) === canaryCount, 'Other group received no new row while this answer completed');
    }
    answersCompleted++;
  }
  const refreshed = await api.request(`${route}/questions`);
  check(refreshed.body.items.every(item => item.status === 'answered'), 'Refresh restores accepted answer lifecycle');
  if (scenario === 'ttl') {
    const nextIdentity = await scenes.readIdentity(current.sessionGroup);
    check(nextIdentity.runId !== oldIdentity.runId && nextIdentity.runtime === 'claude', 'Answer launched a fresh native Claude session');
  }
  console.log('CHAT_RUNTIME_RESULT ' + JSON.stringify({ scenario, runtime, assertions, answers: answersCompleted,
    reclaimed, resources: sandbox.counts }));
  }
} catch (error) {
  try {
    const retained = retainNativeFailure(sandbox, { directory: fixture.evidenceDirectory,
      scenario: `${scenario}-driver`, tmuxBinary, error });
    console.error('CHAT_RUNTIME_FAILURE_EVIDENCE ' + JSON.stringify(retained));
  } catch (captureError) { console.error(`Native failure evidence capture failed: ${captureError.message}`); }
  throw error;
} finally {
  const stops = await Promise.allSettled([dispatcher?.stop(), supervisor?.stop()]);
  const { runTmuxCommand } = await import(pathToFileURL(path.join(packageRoot, 'cli/lib/runtime/tmux-connection.js')).href);
  try { await runTmuxCommand(['kill-server'], { ...tmuxOptions, timeoutMs: 5000 }); }
  catch (error) { if (error.code !== 'TMUX_NO_SERVER') throw error; }
  coreDb?.close();
  await sandbox.close();
  const failure = stops.find(item => item.status === 'rejected');
  if (failure) throw failure.reason;
}
