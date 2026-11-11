import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixture } from '../skills/comm-bridge/scripts/__tests__/c4-v2-test-helpers.js';
import { createRouter } from '../skills/comm-bridge/scripts/router/scheduler.js';
import { receive } from '../skills/comm-bridge/scripts/c4-receive.js';
import { sendExternal } from '../skills/comm-bridge/scripts/c4-send-external.js';
import { isDataError } from '../skills/comm-bridge/scripts/c4-session-group.js';
import { SKILLS_DIR } from '../skills/comm-bridge/scripts/c4-config.js';
import { Store } from '../skills/dashboard/src/lib/store.js';
import { C4Reader } from '../skills/dashboard/src/lib/c4-reader.js';
import { ChatConversations } from '../skills/dashboard/src/lib/chat/conversations.js';
import { ChatSender } from '../skills/dashboard/src/lib/chat/send.js';
import { ChatHistory } from '../skills/dashboard/src/lib/chat/history.js';
import { ensureOriginConversation, ORIGIN_CONVERSATION_ID } from '../skills/dashboard/src/lib/chat/origin.js';
import { isolatedTmux } from './helpers/isolated-tmux.js';
import { getSessionAdapter } from '../cli/lib/runtime/index.js';
import { createSessionReader } from '../cli/lib/session-state-reader-async.js';
import { readReadyIdentity } from '../cli/lib/runtime/session-target.js';
import { listGroupTmuxSessions } from '../cli/lib/session-group-paths.js';

const dashboardDir = new URL('../skills/dashboard/', import.meta.url).pathname;

// Boundary: the Dashboard Origin conversation (real ChatSender -> real
// c4-receive -> private C4 file database) feeding the real Router scheduler,
// the real Claude session adapter on a private tmux socket and a recorder in
// place of the external runtime; the reply goes back through the real
// c4-send path, the real Dashboard BeforeSend hook and send.js, and is read by
// the real Dashboard history. Run for changes to Origin routing, Router
// activation of origin, the Dashboard Origin send/history path or the session
// mode handling of origin; UI-only changes may skip. The mode change itself
// (transition records, drain, legacy handover) is covered by the mode-switch
// integration tests: here the Router is stopped and restarted under the other
// mode on the same databases. The official runner isolates HOME, ZYLOS_DIR,
// PM2_HOME and a short TMPDIR; each case reads them back, owns one private
// root, tmux socket and both databases, and stops the Router, kills its tmux
// server and removes the root on success or failure.
async function setup(t, { mode }) {
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) {
    assert.ok(process.env[key] && !process.env[key].startsWith(os.userInfo().homedir + path.sep), `${key} must be isolated`);
  }
  let router = null;
  let clock = Date.now();
  const tm = isolatedTmux(t, { prefix: 'origin-conv-', beforeCleanup: () => router?.stop() });
  tm.dir = fs.realpathSync(tm.dir);
  assert.ok(tm.dir.startsWith(fs.realpathSync(process.env.TMPDIR) + path.sep));
  assert.ok(Buffer.byteLength(tm.socketPath) < 100);
  const previousRoot = process.env.ZYLOS_DIR;
  process.env.ZYLOS_DIR = tm.dir;
  t.after(() => { process.env.ZYLOS_DIR = previousRoot; });
  const skillsDir = path.join(tm.dir, 'skills');
  for (const dir of ['comm-bridge', 'components/dashboard', 'skills', 'workspace']) fs.mkdirSync(path.join(tm.dir, dir), { recursive: true });
  fs.symlinkSync(dashboardDir, path.join(skillsDir, 'dashboard'));
  // receive validates the runner-owned installed channel directory.
  assert.ok(SKILLS_DIR.startsWith(previousRoot + path.sep));
  fs.mkdirSync(path.join(SKILLS_DIR, 'dashboard'), { recursive: true });
  const configFile = path.join(tm.dir, 'config.json');
  const setMode = value => fs.writeFileSync(configFile, JSON.stringify({ runtime: 'claude', session_mode: value }));
  const readMode = () => JSON.parse(fs.readFileSync(configFile, 'utf8')).session_mode;
  setMode(mode);
  const databasePath = path.join(tm.dir, 'comm-bridge', 'c4.db');
  const f = fixture(t, { validateComponent: name => name === 'dashboard',
    readConfig: () => ({ state: 'ok', config: JSON.parse(fs.readFileSync(configFile, 'utf8')) }) }, databasePath);
  f.db.pragma('journal_mode=WAL');
  console.log('Origin conversation isolation:', JSON.stringify({ root: tm.dir, socket: tm.socketPath, databasePath,
    home: process.env.HOME, pm2Home: process.env.PM2_HOME, tmpdir: process.env.TMPDIR }));

  const store = new Store(path.join(tm.dir, 'components', 'dashboard', 'dashboard.db'));
  ensureOriginConversation(store.db);
  const reader = new C4Reader(tm.dir);
  const conversations = new ChatConversations({ store });
  const history = new ChatHistory({ c4Reader: reader, conversations });
  const core = { isDataError,
    getChannelNamespace: name => f.store.getChannelNamespace(name),
    ensureChannelNamespace: name => f.store.ensureChannelNamespace(name),
    receive: args => receive(args, { db: f.store, queryRoute: async () => ({ decision: 'pending', runtime: 'claude' }),
      appendEntryEvent: async () => true, reserveStatusNotice: () => ({ suppressed: true }),
      sendStatusNotice: () => ({ outcome: 'suppressed' }), diagnostic() {} }) };
  const sender = new ChatSender({ conversations, c4Reader: reader, loadCore: async () => core, zylosDir: tm.dir });
  t.after(() => { reader.close(); store.close(); });

  const records = path.join(tm.dir, 'records.jsonl');
  const executable = path.join(tm.dir, 'record-runtime');
  fs.writeFileSync(executable, `#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path');
if(process.argv.includes('--version')) { console.log('claude-fixture'); process.exit(0); }
const root=process.env.ZYLOS_DIR, group=process.env.ZYLOS_SESSION_GROUP;
const record={runId:process.env.ZYLOS_RUN_ID,group:group??null};
fs.appendFileSync(path.join(root,'records.jsonl'),JSON.stringify(record)+'\\n');
const dir=path.join(root,'activity-monitor/session-groups',group??'origin');fs.mkdirSync(dir,{recursive:true});
fs.writeFileSync(path.join(dir,'current-session.json'),JSON.stringify({runId:record.runId,sessionId:'session-'+record.runId,ts:Date.now(),startupControlIds:[]}));
setInterval(()=>{},1000);
`, { mode: 0o700 });
  const tmux = { binary: tm.binary, socketPath: tm.socketPath, configFile: '/dev/null' };
  const sessions = createSessionReader({ connectionOptions: tmux });
  const delivered = [];
  const db = { ...f.store,
    getControlById: id => f.db.prepare('SELECT * FROM control_queue WHERE id=?').get(id),
    expireTimedOutControls: () => 0, cleanupControlQueue: () => 0 };
  const deps = { db, now: () => clock,
    readSessionMode: () => ({ mode: readMode(), keyPresent: true }),
    readLiveIdentity: sessions.readLiveIdentity,
    readCurrentSession: readReadyIdentity,
    listGroupTmuxSessions: () => listGroupTmuxSessions(tmux),
    readRuntimeHealth: () => ({ health: 'ok', publicHealth: 'ok' }),
    getSessionAdapter: selected => getSessionAdapter(selected, { root: tm.dir, tmux,
      env: { PATH: process.env.PATH, HOME: tm.dir, ZYLOS_DIR: tm.dir }, runtimeExecutable: () => executable }),
    submit: async () => assert.fail('a healthy launch must not submit start_attempt'),
    deliverControl: async () => assert.fail('fixture has no controls'),
    deliverConversation: async (message, identity) => {
      delivered.push({ id: message.id, sessionGroup: identity.sessionGroup ?? null, runId: identity.runId });
      return db.markDelivered(message.id, { sessionId: identity.sessionId });
    },
    handleExpired: async () => assert.fail('fresh fixture must not expire'),
    prepareSingle: async () => {}, findLegacySessions: async () => [], advanceLegacy: async () => {},
    diagnostic() {},
  };
  const runtimes = () => fs.existsSync(records) ? fs.readFileSync(records, 'utf8').trim().split('\n').map(JSON.parse) : [];
  const status = id => f.db.prepare('SELECT status FROM conversations WHERE id=?').get(id).status;

  // Start a Router under the current mode and run it until the row is delivered.
  async function deliver(id) {
    router = createRouter(deps, { poolSize: () => 2, readyTimeoutMs: 10000 });
    await router.initialize(); await router.idle();
    for (let n = 0; n < 40 && status(id) !== 'delivered'; n++) {
      if (n < 7) clock += 1000;
      router.tick(); await router.idle(); await router.idle();
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(status(id), 'delivered', JSON.stringify({ runtimes: runtimes(), delivered }));
    return delivered.find(item => item.id === id);
  }
  // Stop the Router and its runtimes, as a reclaim or restart leaves them.
  async function stopAll() {
    await router?.stop(); router = null;
    try { tm.tmux('kill-server'); } catch {}
    await tm.waitForServerExit();
  }
  // The runtime's reply to the reply-via address, as Origin sends it.
  async function reply(runtime, text) {
    const env = { PATH: process.env.PATH, ZYLOS_DIR: tm.dir, HOME: tm.dir, ZYLOS_RUN_ID: runtime.runId,
      ...(runtime.group ? { ZYLOS_SESSION_GROUP: runtime.group } : {}) };
    return sendExternal({ channel: 'dashboard', endpoint: 'origin' }, text, { api: { ...f.store, getDb: () => f.db }, skillsDir, env });
  }
  const send = content => sender.send(ORIGIN_CONVERSATION_ID, { content });
  const messages = () => history.messages(ORIGIN_CONVERSATION_ID).items.map(row => [row.direction, row.content]);
  return { f, tm, sessions, setMode, deliver, stopAll, reply, send, messages, runtimes, history };
}

test('in multi a reclaimed Origin is woken by a send from the Origin conversation and replies there', { timeout: 60000 }, async t => {
  const s = await setup(t, { mode: 'multi' });
  assert.equal((await s.sessions.readLiveIdentity('origin')).present, false, 'Origin is not running');
  const sent = await s.send('Are you there?');
  assert.equal(sent.stored, true);
  const delivery = await s.deliver(sent.messageId);
  const [runtime] = s.runtimes();
  assert.equal(runtime.group, 'origin', 'the woken runtime is the Origin session');
  assert.equal(delivery.runId, runtime.runId);
  await s.reply(runtime, 'Yes, I am here.');
  assert.deepEqual(s.messages(), [['in', 'Are you there?'], ['out', 'Yes, I am here.']]);
  assert.equal(s.history.list({ tab: 'mine' }).items[0].id, ORIGIN_CONVERSATION_ID);
  await s.stopAll();
});

for (const [first, second] of [['single', 'multi'], ['multi', 'single']]) {
  test(`Origin conversation continues from ${first} to ${second} in the same conversation`, { timeout: 90000 }, async t => {
    const s = await setup(t, { mode: first });
    const before = await s.send(`Before, in ${first}.`);
    await s.deliver(before.messageId);
    const firstRuntime = s.runtimes().at(-1);
    assert.equal(firstRuntime.group, first === 'multi' ? 'origin' : null);
    await s.reply(firstRuntime, `Reply in ${first}.`);
    await s.stopAll();

    s.setMode(second);
    const after = await s.send(`After, in ${second}.`);
    assert.equal(after.conversationId ?? ORIGIN_CONVERSATION_ID, ORIGIN_CONVERSATION_ID);
    await s.deliver(after.messageId);
    const secondRuntime = s.runtimes().at(-1);
    assert.notEqual(secondRuntime.runId, firstRuntime.runId);
    assert.equal(secondRuntime.group, second === 'multi' ? 'origin' : null);
    await s.reply(secondRuntime, `Reply in ${second}.`);
    assert.deepEqual(s.messages(), [
      ['in', `Before, in ${first}.`], ['out', `Reply in ${first}.`],
      ['in', `After, in ${second}.`], ['out', `Reply in ${second}.`],
    ]);
    const groups = s.f.db.prepare("SELECT DISTINCT session_group FROM conversations WHERE channel='dashboard'").all().map(row => row.session_group);
    assert.deepEqual(groups, ['origin']);
    await s.stopAll();
  });
}
