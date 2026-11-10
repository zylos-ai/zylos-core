import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { createTestEnvironment } from '../../../../scripts/test-environment.js';

const environment = createTestEnvironment();
const previous = Object.fromEntries(['TMPDIR', 'TMUX_TMPDIR', 'TMUX'].map(key => [key, process.env[key]]));
const temporary = path.join(environment.root, 'tmp');
fs.mkdirSync(temporary);
process.env.TMPDIR = temporary;
process.env.TMUX_TMPDIR = temporary;
process.env.TMUX = path.join(environment.root, 'tmux.sock') + ',0,0';
const configFile = path.join(process.env.ZYLOS_DIR, '.zylos/config.json');
fs.mkdirSync(path.dirname(configFile), { recursive: true });
fs.writeFileSync(configFile, JSON.stringify({ runtime: 'codex', session_mode: 'multi', session_pool_size: 1 }));

const db = await import('../c4-db.js');
const { receive } = await import('../c4-receive.js');
const { createDispatcher } = await import('../router/factory.js');
const { createStatusNoticeSender } = await import('../c4-status-notice.js');
const { messageForStatus } = await import('../status-notice-templates.js');
const { SKILLS_DIR, DB_PATH } = await import('../c4-config.js');
const { tmuxNameForGroup } = await import('../../../../cli/lib/session-group-paths.js');

after(() => {
  db.close();
  environment.cleanup();
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

// Factory/receiver/real SQLite/notice-child boundary. Run after queue timing,
// admission wiring or status-notice changes; unrelated delivery/UI may skip.
// The official runner and this fixture isolate HOME, ZYLOS_DIR, PM2_HOME and a
// short TMPDIR. Socket and database paths are checked before opening the DB.
// Runtime observation/launch/delivery are injected; no tmux/PM2/model/network or
// external channel runs. The real sender starts only a private recorder child,
// drains it before settling and has a 2s deadline. The test has a 20s deadline,
// aborts its one timer, stops the dispatcher before closing DB/removing root,
// and caps diagnostic observations and recorder input/output.
test('one-slot dispatcher receipts a real capacity wait once and delivers after release', { timeout: 20000 }, async t => {
  const root = fs.realpathSync(environment.root);
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR']) {
    const value = path.resolve(process.env[key]);
    assert.ok(value.startsWith(root + path.sep), `${key} must remain inside the private root`);
  }
  assert.notEqual(fs.realpathSync(process.env.HOME), fs.realpathSync(os.userInfo().homedir));
  const socket = process.env.TMUX.split(',')[0];
  assert.equal(socket, path.join(root, 'tmux.sock'));
  assert.ok(Buffer.byteLength(socket) < 100);
  assert.ok(DB_PATH.startsWith(root + path.sep));
  console.info('capacity notice isolation', JSON.stringify({ HOME: process.env.HOME, ZYLOS_DIR: process.env.ZYLOS_DIR,
    PM2_HOME: process.env.PM2_HOME, TMPDIR: temporary, socket, database: DB_PATH, poolLimit: 1,
    runtime: 'injected', channel: 'private recorder only' }));

  const channel = 'capacity-demo', occupied = 'capacity:busy', waiting = 'capacity:waiting';
  fs.mkdirSync(path.join(SKILLS_DIR, channel), { recursive: true });
  db.registerChannelNamespace(channel, 'capacity');
  const seed = db.insertConversation('in', channel, 'occupied-room', 'occupy one slot', { groupName: 'busy' });
  assert.equal(db.claimConversation(seed.id), true);
  assert.equal(db.markDelivered(seed.id), true);
  const scene = (group, runId) => ({ present: true, ready: true, runtime: 'codex', runId,
    sessionId: `session-${group}`, runtimeSessionId: `session-${group}`, tmuxName: tmuxNameForGroup(group),
    serverGeneration: 'private-generation', paneId: `%${group}`, createdAt: Math.floor(Date.now() / 1000) });
  const scenes = new Map([['origin', scene('origin', 'origin-run')], [occupied, scene(occupied, 'busy-run')]]);
  assert.equal(db.adoptSlot(occupied, { runId: 'busy-run' }).adopted, true);
  const capture = path.join(root, 'receipts.jsonl'), recorder = path.join(root, 'notice-recorder.mjs');
  fs.writeFileSync(recorder, `import fs from 'node:fs';
let body='';process.stdin.setEncoding('utf8');
process.stdin.on('data',chunk=>{body+=chunk;if(Buffer.byteLength(body)>8192)process.exit(2);});
process.stdin.on('end',()=>{const file=${JSON.stringify(capture)};
if(fs.existsSync(file)&&fs.statSync(file).size>8192)process.exit(3);
fs.appendFileSync(file,JSON.stringify({argv:process.argv.slice(2),body})+'\\n');});
`);
  const notices = [], events = [], launches = [];
  const sender = createStatusNoticeSender({ db, script: recorder, timeoutMs: 2000,
    render: route => messageForStatus(route, {}), diagnostic: (_claim, _route, outcome) => notices.push(outcome),
    log: () => assert.fail('notice recorder must not fail') });
  const dispatcher = createDispatcher({ db, env: { ...process.env, ZYLOS_SESSION_POOL_SIZE: '1' },
    diagnostic: (event, fields) => { assert.ok(events.length < 100); events.push({ event, ...fields }); },
    log() {}, maintainDiagnostics() {},
    listGroupTmuxSessions: async () => [...scenes].map(([sessionGroup, identity]) => ({ sessionGroup, ...identity })),
    readLiveIdentity: async group => scenes.get(group) ?? { present: false },
    readCurrentSession: async group => ({ ...scenes.get(group), startupControlIds: [] }),
    readRuntimeHealth: () => ({ health: 'ok' }),
    getSessionAdapter: () => ({ launch: async input => {
      launches.push(input.sessionGroup); scenes.set(input.sessionGroup, scene(input.sessionGroup, input.runId));
    }, stop: async () => assert.fail('the fixture never stops a runtime') }),
    submit: async () => assert.fail('healthy capacity admission needs no supervisor socket'),
    sendStatusNotice: sender,
    deliverConversation: async (record, live) => { assert.equal(db.markDelivered(record.id, { sessionId: live.sessionId }), true); },
    deliverControl: async () => assert.fail('the fixture enqueues no control'),
    findLegacySessions: async () => [], advanceLegacy: async () => {}, prepareSingle: async () => {},
  }, { delivery: { periodicEnabled: false } });
  t.after(() => dispatcher.stop());
  const rounds = async (count = 3) => {
    for (let i = 0; i < count; i++) { dispatcher.tick(); await dispatcher.idle(); }
  };
  const enqueue = content => receive(['--channel', channel, '--endpoint', 'original-room', '--session-group', 'waiting', '--content', content], {
    db, queryRoute: async request => ({ decision: 'pending', runtime: 'codex', health: 'ok', recovered: true,
      transitionHold: false, reason: '', sessionGroup: request.sessionGroup }),
  });
  try {
    await dispatcher.initialize(); await dispatcher.idle();
    const first = await enqueue('first queued message'); await rounds();
    assert.equal(first.action, 'queued'); assert.equal(dispatcher.availableCapacity(), 0);
    const started = events.find(event => event.event === 'wait_capacity' && event.session_group === waiting);
    assert.ok(started); assert.equal(started.occupied_slots, 1); assert.equal(started.pool_limit, 1);
    assert.ok(Number.isSafeInteger(started.wait_started_at_ms));
    assert.equal(fs.existsSync(capture), false);
    const second = await enqueue('same waiting episode'); await rounds();
    assert.equal(fs.existsSync(capture), false);
    await pause(Math.max(1, 10050 - (Date.now() - started.wait_started_at_ms)), undefined, { signal: t.signal });
    await rounds();
    const captured = fs.readFileSync(capture, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(captured.length, 1);
    assert.deepEqual(captured[0].argv, [channel, 'original-room']);
    assert.match(captured[0].body, /消息已收到。目前同时处理的对话较多，正在排队，空出位置后马上处理。/);
    assert.equal(captured[0].body, messageForStatus({ context: 'capacity', noticeCode: 'capacity_wait' }, {}));
    assert.deepEqual(notices, ['sent']);
    const notice = events.find(event => event.event === 'capacity_wait_notice');
    assert.equal(notice.wait_started_at_ms, started.wait_started_at_ms); assert.ok(notice.wait_ms > 10000);
    await rounds(); assert.equal(fs.readFileSync(capture, 'utf8').trim().split('\n').length, 1);
    scenes.delete(occupied); await rounds(2);
    assert.equal(db.releaseSlot(occupied, { runId: 'busy-run', prior: null }).released, true);
    await rounds(6);
    for (const record of [first, second]) {
      assert.equal(db.getDb().prepare('SELECT status FROM conversations WHERE id=?').get(record.id).status, 'delivered');
    }
    assert.deepEqual(launches, [waiting]);
    const acquired = events.find(event => event.event === 'capacity_wait_acquired' && event.session_group === waiting);
    assert.equal(acquired.wait_started_at_ms, started.wait_started_at_ms); assert.ok(acquired.wait_ms >= notice.wait_ms);
    console.info('capacity notice result', JSON.stringify({ poolLimit: 1, originalChannel: channel, originalEndpoint: 'original-room',
      queuedMessages: 2, receipts: captured.length, startedAtMs: started.wait_started_at_ms,
      noticeWaitMs: notice.wait_ms, acquiredWaitMs: acquired.wait_ms, deliveredMessages: 2, launches: launches.length }));
  } finally { await dispatcher.stop(); }
});
