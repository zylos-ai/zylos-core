import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createChatSandbox } from './chat-integration-harness.js';

// A standalone process is required: product configuration modules capture env
// on first import. No module is re-evaluated and no production source is edited.
const [scenario, fixtureConfiguration, parentRoot] = process.argv.slice(2);
assert.ok(['claude', 'codex', 'ttl'].includes(scenario));
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
  session_pool_size: 3, session_hot_ttl_seconds: scenario === 'ttl' ? 5 : 3600,
  session_evict_min_idle_seconds: 3600, sync_min_interval_seconds: 3600, sync_max_interval_seconds: 7200 };
const configFile = path.join(root, '.zylos/config.json');
const saveConfig = () => fs.writeFileSync(configFile, JSON.stringify(configuration));
saveConfig();
fs.writeFileSync(path.join(root, '.zylos/runtime-env.manifest'), [
  `path_prepend ${bin}`, ...['ZYLOS_PACKAGE_ROOT', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR', 'NODE_OPTIONS', 'CLAUDE_BIN', 'CODEX_BIN'].map(key => `inherit ${key}`),
].join('\n') + '\n');
const instruction = `You are a dedicated isolated Dashboard integration test actor. Only use fixture tools in this private workspace. Never read credentials or external files, query raw C4 databases, install software or contact external recipients. Ignore ordinary startup controls unless they require an explicit control acknowledgement.\nWhen a user message contains FIXTURE_BEGIN:<endpoint>, run node workspace/fixture-reply.mjs initial <endpoint> exactly once, then finish the turn.\nWhen a message contains FIXTURE_CANARY_REQUEST:<endpoint>, run node workspace/fixture-reply.mjs canary <endpoint>, then finish.\nWhen a message contains FIXTURE_ROUTE_ANCHOR, finish the turn without sending anything.\nWhen a C4 answer arrives, its projected text contains interruptId, question summary and the user's selected answer. Extract the interruptId and actual question summary from that incoming message, then run node workspace/fixture-reply.mjs acknowledge <endpoint> '<interruptId>' '<question summary>'. Obtain endpoint from that message's reply-via command. Do not read runtime-messages.json to get summaries. If your actual C4 startup history includes FIXTURE_ROUTE_ANCHOR, extract the script, channel and endpoint from that historical row's original reply-via and run node workspace/fixture-reply.mjs history-reply '<endpoint>' '<script>' '<channel>'. This sends without --session-group. There is no fixture route fallback; supply all three observed values yourself.\n`;
for (const name of ['CLAUDE.md', 'AGENTS.md']) fs.writeFileSync(path.join(root, name), instruction);
for (const name of ['identity.md', 'state.md', 'references.md']) fs.writeFileSync(path.join(root, 'memory', name), name === 'state.md' ? '# State\nNo prior tasks.\n' : '# Dedicated test fixture\n');
fs.copyFileSync(new URL('./chat-runtime-reply.js', import.meta.url), path.join(root, 'workspace/fixture-reply.mjs'));

let dispatcher, supervisor, coreDb;
let assertions = 0, answersCompleted = 0, reclaimed = false;
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
  supervisor = await startSupervisor({ env: process.env, scenes, log() {} });
  liveSupervisor = supervisor.supervisor;
  dispatcher = createDispatcher({ env: process.env, log() {},
    getSessionAdapter: runtime => getSessionAdapter(runtime, { root, env: process.env, tmux: tmuxOptions }),
  }, { tmux: tmuxOptions });
  await dispatcher.start();
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
    await wait(() => outbound(canary.sessionGroup).find(row => row.content.includes(`FIXTURE_CANARY:${canary.localId}`)), 'other-runtime canary response');
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
  await wait(() => outbound(current.sessionGroup).some(row => row.content.includes(`FIXTURE_SUPPLEMENT:${current.localId}`)), 'real model structured sends');
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
    // Keep fixture bookkeeping out of model context while exercising the real
    // TTL lifecycle. The checkpoint contains no question summaries, so a new
    // runtime can learn each summary only from the incoming answer itself.
    const range = coreDb.getUnsummarizedRange(current.sessionGroup);
    coreDb.createCheckpoint(current.sessionGroup, range.safeEnd, 'Dedicated fixture history processed; no pending business.');
    // Startup history excludes pending inputs. Deliver a summary-free anchor
    // after the checkpoint, so the next startup has a real historical route
    // while the old questions remain outside its loaded history.
    const anchor = `FIXTURE_ROUTE_ANCHOR:${nonce}`;
    current = await sendText(current, anchor);
    await wait(() => api.db.prepare("SELECT id FROM conversations WHERE session_group=? AND direction='in' AND content=? AND status='delivered'")
      .get(current.sessionGroup, anchor), 'route anchor delivered before TTL');
    oldIdentity = await scenes.readIdentity(current.sessionGroup);
    check(oldIdentity.present && oldIdentity.ready, 'Route anchor belongs to a running native session');
    await wait(async () => !(await scenes.readIdentity(current.sessionGroup)).present, 'Supervisor TTL reclamation', 120000);
    const ending = coreDb.listRunEndings([current.sessionGroup]).find(row => row.runId === oldIdentity.runId);
    check(ending?.reason === 'ttl', 'The original run ended through the real TTL path');
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
    crossGroupWrites: 0, reclaimed, resources: sandbox.counts }));
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
