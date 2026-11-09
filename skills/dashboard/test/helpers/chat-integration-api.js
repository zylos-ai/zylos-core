import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import Database from '../../../comm-bridge/scripts/sqlite-driver.js';
import { Store } from '../../src/lib/store.js';
import { AuthGate } from '../../src/lib/auth.js';
import { C4Reader } from '../../src/lib/c4-reader.js';
import { FleetProxy } from '../../src/lib/fleet-proxy.js';
import { sendJson, sendHtml, serveStatic } from '../../src/lib/http.js';
import { createGroupSnapshot, workbenchResponse } from '../../src/lib/workbench/group-snapshot.js';
import { createDisplayNames } from '../../src/lib/workbench/display-names.js';
import { createQueryHandlers } from '../../../comm-bridge/scripts/c4-v2-cli.js';
import { ChatConversations, isChatLocalIdUsed } from '../../src/lib/chat/conversations.js';
import { ChatSender } from '../../src/lib/chat/send.js';
import { ChatAttachments } from '../../src/lib/chat/attachments.js';
import { handleChatAttachments } from '../../src/lib/chat/attachment-routes.js';
import { ChatHistory } from '../../src/lib/chat/history.js';
import { ChatAnswers } from '../../src/lib/chat/answers.js';
import { ChatAnswerDelivery } from '../../src/lib/chat/delivery.js';
import { handleChatConversations } from '../../src/lib/chat/write-routes.js';
import { handleChatHistory } from '../../src/lib/chat/history-routes.js';
import { ChatActivity } from '../../src/lib/chat/activity.js';
import { handleChatAnswers } from '../../src/lib/chat/answer-routes.js';
import { handleChatSettings } from '../../src/lib/chat/settings.js';
import { acceptDelivery } from '../../src/lib/chat/channel.js';
import { evaluateBeforeSend } from '../../scripts/send-hook.js';
import { createStore } from '../../../comm-bridge/scripts/c4-v2-store.js';
import { guardDatabase } from '../../../comm-bridge/scripts/sqlite-schema.js';
import * as schema from '../../../comm-bridge/scripts/c4-schema.js';
import { receive } from '../../../comm-bridge/scripts/c4-receive.js';
import { isDataError } from '../../../comm-bridge/scripts/c4-session-group.js';
import { SKILLS_DIR, DATA_DIR } from '../../../comm-bridge/scripts/c4-config.js';
import { ModeSwitchCoordinator } from '../../../activity-monitor/scripts/mode-switch.js';
import { createModeSwitchConverter } from '../../../activity-monitor/scripts/mode-switch-convert.js';
import { CONTENT_PREFIX, parseC4Content } from '../../../comm-bridge/scripts/c4-content-schema.js';

const publicDir = path.resolve(fileURLToPath(new URL('../../public/', import.meta.url)));
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
export const protocolFixtures = JSON.parse(fs.readFileSync(new URL('../../../../test/fixtures/c4-content-protocol.json', import.meta.url), 'utf8'));

// These imports capture environment at module load. Prove their instance is
// owned by either the Node runner or this sandbox before creating directories.
export function assertChatProcessIsolation(sandbox, { env = process.env, skillsDir = SKILLS_DIR, dataDir = DATA_DIR } = {}) {
  sandbox.assertIsolation();
  const runnerRoot = path.dirname(sandbox.paths.parentTmp || path.dirname(sandbox.root));
  const loadedRoot = fs.realpathSync(env.ZYLOS_DIR);
  const inside = (parent, child) => child.startsWith(parent + path.sep);
  const realHome = fs.realpathSync(os.userInfo().homedir);
  assert.ok(loadedRoot !== realHome && !inside(realHome, loadedRoot), 'Loaded Core instance must stay outside the real account home');
  assert.ok(inside(runnerRoot, loadedRoot) || inside(sandbox.root, loadedRoot), 'Loaded Core instance must belong to the runner or case');
  // macOS's runner may spell the same private root /tmp rather than /private/tmp.
  // Compare captured paths against that spelling, and prove their real owners.
  assert.equal(dataDir, path.join(env.ZYLOS_DIR, 'comm-bridge'), 'Loaded Core data path must match the proven process instance');
  assert.equal(skillsDir, path.join(env.ZYLOS_DIR, '.claude/skills'), 'Loaded Core skills path must match the proven process instance');
  if (fs.existsSync(dataDir)) assert.equal(fs.realpathSync(dataDir), path.join(loadedRoot, 'comm-bridge'), 'Core data directory cannot redirect outside its instance');
  return { loadedRoot, skillsDir, dataDir, runnerRoot };
}

// Real HTTP/AuthGate/chat modules and two SQLite owners. Only the Core route and
// notification adapter are controlled: no model, PM2 or tmux is launched here.
export async function createChatApiFixture(t, sandbox, { name = 'instance', extraHandler, attachmentService = true, instanceTz = null } = {}) {
  console.log('Chat HTTP isolation:', JSON.stringify(sandbox.assertIsolation()));
  console.log('Chat Core process isolation:', JSON.stringify(assertChatProcessIsolation(sandbox)));
  const zylos = sandbox.paths.zylos;
  const configPath = path.join(zylos, 'components/dashboard/config.json');
  for (const directory of [path.dirname(sandbox.paths.c4Db), path.dirname(sandbox.paths.dashboardDb), path.dirname(configPath), path.join(zylos, '.zylos')]) fs.mkdirSync(directory, { recursive: true });
  // receive validates the runner-owned installed channel directory before
  // calling the injected route adapter. This is not a live installation.
  const installedChannel = path.join(SKILLS_DIR, 'dashboard');
  if (!fs.existsSync(installedChannel)) {
    // Native fixtures may symlink the installed skills to read-only sources;
    // only create the runner's empty validation directory when no link exists.
    const loadedRoot = fs.realpathSync(process.env.ZYLOS_DIR);
    for (const relative of ['.claude', '.claude/skills']) {
      const directory = path.join(loadedRoot, relative);
      fs.mkdirSync(directory, { recursive: true });
      assert.equal(fs.realpathSync(directory), directory, 'Writable installed-channel parents must remain private');
    }
    fs.mkdirSync(installedChannel);
  }
  const db = sandbox.openDatabase(sandbox.paths.c4Db, filename => new Database(filename));
  guardDatabase(db, schema);
  const store = sandbox.openDatabase(sandbox.paths.dashboardDb, filename => new Store(filename));
  const config = { configPath, auth: { enabled: true, password: 'scrypt:private-fixture' }, chat: { allowRemote: false } };
  fs.writeFileSync(configPath, JSON.stringify(config));
  const modePath = path.join(zylos, '.zylos/config.json');
  fs.writeFileSync(modePath, JSON.stringify({ runtime: 'claude', session_mode: 'multi' }));
  const readMode = () => JSON.parse(fs.readFileSync(modePath, 'utf8')).session_mode;
  const c4 = createStore(db, { validateComponent: channel => ['dashboard', 'telegram'].includes(channel),
    readConfig: () => ({ state: 'ok', config: { runtime: 'claude', session_mode: readMode() } }) });
  const reader = new C4Reader(zylos);
  const conversations = new ChatConversations({ store, isUsed: id => isChatLocalIdUsed(reader, id) });
  let route = { decision: 'pending', runtime: 'claude' }, notification = 'sent', invoke = null, lookupUnavailable = false;
  const counts = { receive: 0, notifications: 0, queries: 0, upstream: 0 };
  const originalOpen = reader._open.bind(reader);
  reader._open = () => {
    if (lookupUnavailable) throw Error('controlled private C4 lookup outage');
    counts.queries++;
    return originalOpen();
  };
  const realReceive = args => receive(args, { db: c4, queryRoute: async () => route,
    appendEntryEvent: async () => true,
    reserveStatusNotice: () => ({ suppressed: notification === 'suppressed' }),
    sendStatusNotice: () => { counts.notifications++; return { outcome: notification }; }, diagnostic() {} });
  const core = { receive: async args => { counts.receive++; return (invoke || realReceive)(args); }, isDataError,
    getChannelNamespace: channel => c4.getChannelNamespace(channel), ensureChannelNamespace: channel => c4.ensureChannelNamespace(channel) };
  const attachments = attachmentService ? new ChatAttachments({ store, c4Reader: reader, zylosDir: zylos }) : null;
  const sender = new ChatSender({ conversations, c4Reader: reader, attachments, loadCore: async () => core, zylosDir: zylos });
  let answers = new ChatAnswers({ store }), delivery = new ChatAnswerDelivery({ answers, sender, c4Reader: reader });
  const history = new ChatHistory({ c4Reader: reader, conversations, attachments });
  // The real activity reader on the same C4 history and Dashboard event store, as the server wires it.
  const activity = new ChatActivity({ history, store });
  const query = createQueryHandlers(c4);
  const runC4Db = async args => {
    const argument = key => args.includes(key) ? args[args.indexOf(key) + 1] : undefined;
    if (args[0] === 'group-queues') return { ok: true, data: query.groupQueues() };
    if (args[0] !== 'groups') throw Error('Unexpected workbench Core query');
    return { ok: true, data: query.groups({ ...(argument('--active-since') ? { activeSince: Number(argument('--active-since')) } : {}),
      ...(argument('--key-match') ? { keyMatch: argument('--key-match') } : {}), ...(argument('--limit') ? { limit: Number(argument('--limit')) } : {}) }) };
  };
  // Runtime observation is deliberately unavailable in this HTTP-only fixture;
  // actual C4 queue/history, dashboard event store and sanitizer remain real.
  const workbench = createGroupSnapshot({ zylosDir: zylos, store, c4Reader: reader,
    cli: { runC4Db, readOverrides: async () => ({ ok: false, reason: 'fixture_no_runtime' }) },
    displayNames: createDisplayNames({ store, zylosDir: zylos, runC4Db }),
    loadCoreModule: async name => {
      if (name === 'config.js') return { readSessionMode: () => ({ mode: readMode() }) };
      throw Error('No runtime observations in this private HTTP fixture');
    }, readConfigRuntime: () => 'claude' });
  const cookie = `private-${name}-${crypto.randomUUID()}-browser`;
  const tokens = { read: `zylos_st_${crypto.randomBytes(32).toString('hex')}`, admin: `zylos_st_${crypto.randomBytes(32).toString('hex')}` };
  store.insertSession(digest(cookie), Date.now());
  for (const scope of ['read', 'admin']) {
    const key = store.insertApiKey({ name: `${scope}-${crypto.randomUUID()}`, keyHash: `private-${scope}`, scope });
    store.insertApiSession({ tokenHash: digest(tokens[scope]), apiKeyId: key.lastInsertRowid, scope, createdAt: Date.now(), expiresAt: Date.now() + 600000 });
  }
  const auth = new AuthGate(config, store);
  let proxy = null, fixture;
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (await auth.handle(req, res, url)) return;
      if (url.pathname.startsWith('/fleet/') && proxy && await proxy.handle(req, res, url)) return;
      const common = { auth, config, conversations, sender, history, activity, answers, delivery, attachments, readMode, instanceTz };
      if (await handleChatSettings(req, res, url, common)) return;
      if (attachments && await handleChatAttachments(req, res, url, common)) return;
      if (await handleChatConversations(req, res, url, common)) return;
      if (await handleChatAnswers(req, res, url, common)) return;
      if (await handleChatHistory(req, res, url, common)) return;
      if (req.method === 'GET' && ['/api/workbench/groups', '/api/workbench/groups/search', '/api/workbench/activity'].includes(url.pathname)) {
        sendJson(res, 200, await workbenchResponse(workbench, url.pathname, url.searchParams)); return;
      }
      if (await extraHandler?.(req, res, url, fixture)) return;
      if (['/', '/index.html', '/chat'].includes(url.pathname)) {
        sendHtml(res, 200, fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8')
          .replaceAll('__BASE_PATH__', '').replaceAll('__ASSET_ROOT__', '/_assets').replaceAll('__REMOTE_ACCESS__', 'admin')); return;
      }
      if (serveStatic(req, res, publicDir)) return;
      sendJson(res, 404, { error: 'not_found' });
    } catch (error) { sendJson(res, 500, { error: error.code || error.message }); }
  });
  const address = await sandbox.startHttp(server);
  const base = typeof address === 'string' ? address : `http://127.0.0.1:${server.address().port}`;
  sandbox.addCleanup(async () => { clearInterval(auth._cleanupTimer); await attachments?.close(); reader.close(); });
  async function rawRequest(route, { method = 'GET', identity = 'cookie', body, headers = {}, fleet = false, timeoutMs = 5000 } = {}) {
    if (identity === 'cookie') headers = { cookie: `__Secure-zylos_dashboard_session=${cookie}`, ...headers };
    else if (tokens[identity]) headers = { authorization: `Bearer ${tokens[identity]}`, ...headers };
    return fetch(base + (fleet ? '/fleet/Remote' : '') + route, { method, body, headers: { origin: base, ...headers }, signal: AbortSignal.timeout(timeoutMs) });
  }
  async function request(route, { method = 'GET', identity = 'cookie', body, origin = base, fleet = false, timeoutMs = 5000 } = {}) {
    const headers = { 'content-type': 'application/json' };
    if (identity === 'cookie') headers.cookie = `__Secure-zylos_dashboard_session=${cookie}`;
    else if (tokens[identity]) headers.authorization = `Bearer ${tokens[identity]}`;
    if (origin !== null) headers.origin = origin;
    const response = await fetch(base + (fleet ? '/fleet/Remote' : '') + route, { method, headers, signal: AbortSignal.timeout(timeoutMs),
      ...(['GET', 'HEAD'].includes(method) ? {} : { body: JSON.stringify(body ?? {}) }) });
    const text = await response.text();
    let result; try { result = JSON.parse(text); } catch { result = text; }
    return { status: response.status, body: result, text };
  }
  function addOutbound(localId, content) {
    sandbox.assertIsolation();
    const hook = evaluateBeforeSend({ version: 1, hook_event_name: 'BeforeSend', hook_id: 'dashboard.content',
      request_id: crypto.randomUUID(), invocation_id: crypto.randomUUID(), request: { channel: 'dashboard', endpoint: localId, content, options: { groupName: localId } }, context: {} }, { env: sandbox.env });
    assert.equal(hook.decision, 'continue');
    const row = c4.insertConversation('out', 'dashboard', localId, content, { groupName: localId });
    acceptDelivery({ version: 1, c4_id: row.id, channel: row.channel, endpoint_id: row.endpoint_id, session_group: row.session_group, content: row.content }, { env: sandbox.env });
    return row;
  }
  async function createConversation(content = 'isolated first text') {
    const draft = await request('/api/chat/drafts', { method: 'POST', body: { displayName: name } });
    assert.equal(draft.status, 201);
    const first = await request(`/api/chat/conversations/${encodeURIComponent(draft.body.conversation.id)}/send`, { method: 'POST', body: { content } });
    assert.equal(first.status, 200);
    return { draft: draft.body.conversation, receipt: first.body, route: `/api/chat/conversations/${encodeURIComponent(first.body.conversationId)}` };
  }
  fixture = { sandbox, base, request, rawRequest, attachments, config, configPath, store, db, c4, reader, history, conversations, sender, get answers() { return answers; }, get delivery() { return delivery; },
    addOutbound, createConversation, realReceive, readMode, modePath, cookie, tokens, counts,
    setRoute: value => { route = value; }, setNotification: value => { notification = value; }, setInvoke: value => { invoke = value; },
    setLookupUnavailable: value => { lookupUnavailable = value; },
    async convertToSingle() {
      sandbox.assertIsolation();
      const { runId } = c4.beginModeTransition('multi', 'single');
      c4.setDrainFence('*'); c4.absorbForTransition(runId);
      const coordinator = new ModeSwitchCoordinator({ db: c4, readMode: () => ({ mode: readMode() }),
        convert: createModeSwitchConverter({ db: c4, zylosDir: zylos }),
        writeMode: target => fs.writeFileSync(modePath, JSON.stringify({ runtime: 'claude', session_mode: target })),
        restart: { advance: async () => ({ confirmed: true }) } });
      await coordinator.advance();
      assert.equal(c4.getModeTransition().phase, 'cutover');
      await coordinator.advance();
      assert.equal(c4.getModeTransition(), null); assert.equal(readMode(), 'single');
      return c4.getLastCompletedModeTransition();
    },
    async restartDelivery() { answers = new ChatAnswers({ store }); delivery = new ChatAnswerDelivery({ answers, sender, c4Reader: reader }); return delivery.recover(); },
    setProxy(remote) { proxy = new FleetProxy({ config: { fleet: { agents: [{ name: 'Remote', base_url: remote.base }] } }, rootDir: publicDir, authGate: auth,
      poller: { getSessionToken: async () => remote.tokens.admin, getAgentAccess: () => 'admin' }, fetch: async (...args) => { counts.upstream++; return fetch(...args); } }); },
    question(name = 'single', suffix = crypto.randomUUID()) {
      const envelope = structuredClone(protocolFixtures.valid.find(item => item.name === name).envelope);
      envelope.messageId += `_${suffix}`; envelope.interruptId += `_${suffix}`; return envelope;
    },
    answer(question, id = crypto.randomUUID()) {
      const block = question.blocks.find(block => block.id === question.interrupt.blockId);
      return { interruptId: question.interruptId, action: { id, protocolVersion: '0.1', type: block.data.action.type, target: block.data.action.target,
        context: { messageId: question.messageId, blockId: block.id }, payload: { selected: ['a'] } } };
    },
    answerRows(id) { return db.prepare("SELECT * FROM conversations WHERE direction='in' ORDER BY id").all().filter(row => {
      const parsed = parseC4Content(row.content); return parsed.kind === 'envelope' && parsed.envelope.kind === 'answer' && parsed.envelope.metadata.zylos.answerId === id;
    }); },
  };
  return fixture;
}

export function questionContent(question) { return CONTENT_PREFIX + JSON.stringify(question); }

// A real second Dashboard runs in a separate process because AuthGate owns a
// process-global session store. Sharing its module between instances would be
// an invalid test topology. The child's own harness proves every private target.
export async function createRemoteChatApiFixture(t, sandbox, { timeoutMs = 45000 } = {}) {
  let child, info, serial = 0;
  const pending = new Map();
  async function launch({ lookupUnavailable = false } = {}) {
    child = sandbox.startChild(process.execPath, [fileURLToPath(new URL('./chat-integration-api-child.js', import.meta.url)), ...(lookupUnavailable ? ['--lookup-unavailable'] : [])], {
      // This RPC process serves the whole case, including every matrix reply.
      // The outer case's shorter deadline still owns its final teardown.
      timeoutMs, maxOutputBytes: 1024 * 1024,
    });
    let buffer = '', readyResolve, readyReject;
    const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    child.stdout.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 262144) { readyReject(Error('Private fixture readiness output exceeded its limit')); return; }
      while (buffer.includes('\n')) {
        const index = buffer.indexOf('\n'), line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        if (!line.startsWith('CHAT_RPC ')) continue;
        const message = JSON.parse(line.slice(9));
        if (message.ready) readyResolve(message);
        else {
          const callback = pending.get(message.id); pending.delete(message.id);
          if (message.error) callback?.reject(Error(message.error)); else callback?.resolve(message.value);
        }
      }
    });
    child.once('exit', code => {
      if (code) readyReject(Error(`Private fixture exited with ${code}`));
      for (const callback of pending.values()) callback.reject(Error('Private fixture exited')); pending.clear();
    });
    info = await Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(Error('Private fixture readiness timed out')), 5000).unref())]);
    assert.equal(info.root, sandbox.root);
    console.log('Remote HTTP isolation:', JSON.stringify(info.proof));
  }
  await launch();
  function rpc(operation, ...args) {
    return new Promise((resolve, reject) => {
      const id = ++serial;
      const timer = setTimeout(() => { pending.delete(id); reject(Error('Private fixture request timed out')); }, 5000).unref();
      pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      child.stdin.write(JSON.stringify({ id, operation, args }) + '\n');
    });
  }
  const config = { chat: { allowRemote: false } };
  const remote = { get base() { return info.base; }, get cookie() { return info.cookie; }, get tokens() { return info.tokens; },
    get pid() { return info.pid; }, config,
    snapshot: () => rpc('snapshot'), answerRows: id => rpc('answerRows', id), addOutbound: (...args) => rpc('addOutbound', ...args),
    registerAttachment: (...args) => rpc('registerAttachment', ...args),
    setRoute: route => rpc('route', route), setNotification: outcome => rpc('notification', outcome), setInvoke: mode => rpc('invoke', mode),
    setProxy: target => rpc('proxy', { base: target.base, tokens: target.tokens }),
    async rawRequest(route, { method = 'GET', identity = 'cookie', body, headers = {}, timeoutMs = 5000 } = {}) {
      if (identity === 'cookie') headers = { cookie: `__Secure-zylos_dashboard_session=${info.cookie}`, ...headers };
      else if (info.tokens[identity]) headers = { authorization: `Bearer ${info.tokens[identity]}`, ...headers };
      return fetch(info.base + route, { method, body, headers: { origin: info.base, ...headers }, signal: AbortSignal.timeout(timeoutMs) });
    },
    async restart(options = {}) {
      const previousPid = info.pid;
      await rpc('close'); await child.completion;
      await launch(options);
      assert.notEqual(info.pid, previousPid);
      return { previousPid, pid: info.pid, proof: info.proof };
    },
    async request(route, { method = 'GET', identity = 'cookie', body, origin, timeoutMs = 5000 } = {}) {
      const headers = { 'content-type': 'application/json' };
      if (identity === 'cookie') headers.cookie = `__Secure-zylos_dashboard_session=${info.cookie}`;
      else if (info.tokens[identity]) headers.authorization = `Bearer ${info.tokens[identity]}`;
      if (origin !== null) headers.origin = origin ?? info.base;
      const response = await fetch(info.base + route, { method, headers, signal: AbortSignal.timeout(timeoutMs),
        ...(['GET', 'HEAD'].includes(method) ? {} : { body: JSON.stringify(body ?? {}) }) });
      const text = await response.text(); let value; try { value = JSON.parse(text); } catch { value = text; }
      if (route === '/api/chat/settings' && response.ok) config.chat.allowRemote = value.allowRemote;
      return { status: response.status, body: value, text };
    },
    async createConversation(content = 'isolated remote first text') {
      const draft = await remote.request('/api/chat/drafts', { method: 'POST', body: {} }); assert.equal(draft.status, 201);
      const first = await remote.request(`/api/chat/conversations/${encodeURIComponent(draft.body.conversation.id)}/send`, { method: 'POST', body: { content } }); assert.equal(first.status, 200);
      return { draft: draft.body.conversation, receipt: first.body, route: `/api/chat/conversations/${encodeURIComponent(first.body.conversationId)}` };
    },
    question(name = 'single') {
      const envelope = structuredClone(protocolFixtures.valid.find(item => item.name === name).envelope);
      const suffix = crypto.randomUUID(); envelope.messageId += `_${suffix}`; envelope.interruptId += `_${suffix}`; return envelope;
    },
    answer(question, id = crypto.randomUUID()) {
      const block = question.blocks.find(item => item.id === question.interrupt.blockId);
      return { interruptId: question.interruptId, action: { id, protocolVersion: '0.1', type: block.data.action.type, target: block.data.action.target,
        context: { messageId: question.messageId, blockId: block.id }, payload: { selected: ['a'] } } };
    },
  };
  return remote;
}
