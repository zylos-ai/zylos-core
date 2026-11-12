import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readyTmuxTarget } from './helpers/ready-tmux-target.js';

// Boundary: a single-session upgrade restart from the real requestRuntimeRestart
// (default dependencies: the session mode file, the transition record, the
// installed check prompt and c4-control enqueue) through the real Router
// dispatcher, Claude session adapter and paste on a private tmux socket into a
// line recorder that stands in for the runtime, on a private C4 database. It
// shows the check is pasted before /exit and only once, /exit follows the
// acknowledged check, an unanswered check expires after 60 seconds and /exit
// still follows, and a busy session or a new message never drops or overtakes
// the queued /exit. Run for changes to the single-session restart producer, the
// check prompt, control ordering, require-idle gating or control expiry; other
// changes may skip. Session state is injected and the Router clock jumps (no real
// minute is waited), the runtime is a recorder, and no authenticated model or
// service is started. The official runner isolates HOME, ZYLOS_DIR, PM2_HOME and
// a short TMPDIR; the case checks them, owns one private root, tmux socket and
// database, and stops the Router, kills the tmux server and removes the root on
// success or failure.
test('single-session upgrade checks waiting work before /exit, at most 60 seconds, and never drops /exit', { timeout: 60000 }, async t => {
  const realHome = fs.realpathSync(os.userInfo().homedir);
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) {
    const value = process.env[key] && (fs.existsSync(process.env[key]) ? fs.realpathSync(process.env[key]) : path.resolve(process.env[key]));
    assert.ok(value && !value.startsWith(realHome + path.sep), `${key} must be isolated`);
  }
  const repository = fileURLToPath(new URL('../', import.meta.url));
  let dispatcher = null;
  const f = readyTmuxTarget(t, { prefix: 'single-upgrade-', mode: 'single', runtime: 'claude', packageRoot: repository });
  t.after(() => dispatcher?.stop());
  const oldEnv = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!Object.hasOwn(oldEnv, key)) delete process.env[key];
    Object.assign(process.env, oldEnv);
  });
  for (const key of ['HOME', 'ZYLOS_DIR', 'TMUX', 'TMUX_TMPDIR', 'ZYLOS_PACKAGE_ROOT']) process.env[key] = f.env[key];
  for (const key of ['ZYLOS_SESSION_GROUP', 'ZYLOS_RUN_ID']) delete process.env[key];
  // The producer runs the installed skills; here they are the repository's.
  fs.mkdirSync(path.join(f.root, '.claude/skills'), { recursive: true });
  for (const skill of ['comm-bridge', 'activity-monitor', 'scheduler']) {
    fs.symlinkSync(path.join(repository, 'skills', skill), path.join(f.root, '.claude/skills', skill));
  }
  fs.mkdirSync(path.join(f.root, '.claude/skills/telegram')); // the installed channel of the test messages
  // A line recorder named claude in place of the runtime.
  const lines = path.join(f.root, 'pasted.jsonl');
  const recorder = path.join(f.root, 'claude');
  fs.writeFileSync(recorder, `#!${process.execPath}\nconst fs=require('node:fs');let text='';
const prompt=()=>process.stdout.write('\\x1b[2J\\x1b[H\\u276f ');process.stdin.setRawMode(true);process.stdin.setEncoding('utf8');prompt();
process.stdin.on('data',chunk=>{text+=chunk;let i;while((i=text.indexOf('\\r'))>=0){
fs.appendFileSync(${JSON.stringify(lines)},JSON.stringify(text.slice(0,i).replace(/\\x1b\\[20[01]~/g,''))+'\\n');text=text.slice(i+1);prompt();}});
setInterval(()=>{},1000);\n`, { mode: 0o700 });
  f.tmux('set-option', '-g', 'remain-on-exit', 'off');
  f.tmux('respawn-pane', '-k', '-t', 'zylos-group-origin', recorder);
  for (let n = 0; n < 100 && !f.tmux('capture-pane', '-p', '-t', 'zylos-group-origin').includes('❯'); n++) await new Promise(r => setTimeout(r, 20));

  const { DB_PATH } = await import('../skills/comm-bridge/scripts/c4-config.js');
  assert.equal(DB_PATH, path.join(f.root, 'comm-bridge/c4.db'));
  console.log('Single upgrade check isolation:', JSON.stringify({ root: f.root, database: DB_PATH, socket: f.socketPath,
    env: Object.fromEntries(['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR', 'TMUX'].map(key => [key, process.env[key]])) }));
  const db = await import('../skills/comm-bridge/scripts/c4-db.js');
  t.after(() => db.close());
  const { requestRuntimeRestart } = await import('../cli/lib/request-runtime-restart.js');
  const { SINGLE_UPGRADE_RESTART_CHECK_PROMPT } = await import('../skills/activity-monitor/scripts/reclaim-prompts.js');
  const { createDispatcher } = await import('../skills/comm-bridge/scripts/router/factory.js');

  // The real clock plus a test-controlled jump, so delivery's own short waits still elapse.
  let offset = 0;
  const setClock = ms => { offset = ms - Date.now(); };
  const events = []; // the latest dispatcher events, for failure messages only
  const record = event => { events.push(event); if (events.length > 20) events.shift(); };
  // Each paste starts a runtime turn that lasts until endTurn(); other work is the busy flag.
  let busy = false, turnsEnded = 0;
  const pasted = () => fs.existsSync(lines) ? fs.readFileSync(lines, 'utf8').trim().split('\n').map(JSON.parse) : [];
  const endTurn = () => { turnsEnded = pasted().length; };
  const session = () => busy || pasted().length > turnsEnded ? { state: 'busy', idle_seconds: 0 } : { state: 'idle', idle_seconds: 10 };
  const ready = JSON.parse(fs.readFileSync(f.readyPath, 'utf8'));
  dispatcher = createDispatcher({
    env: { ...process.env }, now: () => Date.now() + offset,
    readSessionState: async () => ({ identity: { runId: ready.runId, runtime: 'claude', ready: true },
      status: { valid: true, value: { ...session(), health: 'ok', proc: { alive: true } } } }),
    readRuntimeHealth: () => ({ health: 'ok', publicHealth: 'ok' }),
    diagnostics: { diagnostic: (...a) => record(a), maintain() {} }, log: m => record(['log', m]), notifyDelivered() {},
    sendAlert: () => assert.fail('External send forbidden'),
    submit: async () => assert.fail('a running single session needs no start_attempt'),
    prepareSingle: async () => {}, findLegacySessions: async () => [], advanceLegacy: async () => {},
  }, { tmux: { socketPath: f.socketPath, binary: f.binary, configFile: '/dev/null' },
    delivery: { periodicEnabled: false, verifyWaitMs: 20, idleHoldMs: 1, idleWaitMs: 50, idlePollMs: 1, gateBackoffBaseMs: 1, gateBackoffMaxMs: 5 } });
  await dispatcher.initialize(); await dispatcher.idle();

  const control = id => db.getControlById(id);
  const run = async (rounds = 3) => {
    for (let n = 0; n < rounds; n++) { dispatcher.tick(); await dispatcher.idle(); await new Promise(r => setTimeout(r, 30)); }
  };
  const isCheck = line => line.startsWith(`Meanwhile, ${SINGLE_UPGRADE_RESTART_CHECK_PROMPT}`);
  const restart = async () => {
    const started = performance.now();
    const result = await requestRuntimeRestart();
    assert.ok(performance.now() - started < 10000, 'the producer returns within its submission budget');
    assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.data.result, 'exit_enqueued');
    const check = control(result.data.checkControlId), exit = control(result.data.exitControlId);
    assert.ok(check.id < exit.id);
    assert.deepEqual([check.status, check.raw_content, check.priority, check.require_idle, check.content.includes(` ---- ack via: `), check.ack_deadline_at - check.created_at],
      ['pending', SINGLE_UPGRADE_RESTART_CHECK_PROMPT, 1, 1, true, 60]);
    assert.deepEqual([exit.status, exit.raw_content, exit.priority, exit.require_idle, exit.content, exit.ack_deadline_at],
      ['pending', '/exit', 1, 1, '/exit', null]);
    return { check, exit };
  };

  const conversation = id => db.getDb().prepare('SELECT status FROM conversations WHERE id=?').get(id).status;
  const reset = () => { fs.rmSync(lines, { force: true }); turnsEnded = 0; busy = false; offset = 0; };

  // Answered: the check is pasted alone; neither /exit nor a new message goes during its turn; /exit follows the answer.
  {
    const { check, exit } = await restart();
    await run();
    assert.equal(pasted().length, 1, JSON.stringify({ pasted: pasted(), events: events.slice(-8) }));
    assert.ok(isCheck(pasted()[0])); assert.ok(pasted()[0].endsWith(`ack --id ${check.id}`));
    assert.equal(control(check.id).status, 'running'); assert.equal(control(exit.id).status, 'pending');
    const message = db.insertConversation('in', 'telegram', 'chat-1', 'new message during the check');
    await run();
    assert.equal(pasted().length, 1, 'neither /exit nor the new message during the check turn');
    assert.equal(db.ackControl(check.id).status, 'done');
    endTurn();
    await run();
    assert.equal(pasted()[1], '/exit', 'the next paste after the answer is /exit');
    assert.equal(control(exit.id).status, 'done');
    // A runtime that exits would leave the message to its replacement; it is kept, after /exit.
    assert.equal(conversation(message.id), 'delivered');
    assert.ok(pasted().findIndex(line => line.includes('new message during the check')) > 1);
    assert.equal(pasted().filter(isCheck).length, 1, 'asked once');
  }

  // Unanswered: the delivered check is not acknowledged; at 60 seconds it expires and /exit follows once idle.
  {
    reset();
    const { check, exit } = await restart();
    await run();
    assert.equal(pasted().length, 1); assert.ok(isCheck(pasted()[0]));
    setClock(check.ack_deadline_at * 1000 - 500);
    await run();
    assert.equal(control(check.id).status, 'running', 'not expired before 60 seconds');
    setClock((check.ack_deadline_at + 1) * 1000);
    await run();
    assert.equal(control(check.id).status, 'timeout'); assert.equal(control(exit.id).status, 'pending');
    assert.equal(pasted().length, 1, '/exit does not cut into the turn');
    endTurn();
    await run();
    assert.deepEqual(pasted().slice(1), ['/exit']); assert.equal(control(exit.id).status, 'done');
  }

  // Busy throughout: other activity keeps the check from being delivered; it expires at 60 seconds and the queued
  // /exit still goes first once idle, ahead of a message that arrived meanwhile.
  {
    reset();
    busy = true;
    const { check, exit } = await restart();
    const message = db.insertConversation('in', 'telegram', 'chat-2', 'new message while busy');
    await run();
    setClock(check.ack_deadline_at * 1000 - 500);
    await run();
    assert.equal(control(check.id).status, 'pending'); assert.equal(pasted().length, 0);
    setClock((check.ack_deadline_at + 1) * 1000);
    await run();
    assert.equal(control(check.id).status, 'timeout'); assert.equal(control(exit.id).status, 'pending');
    busy = false;
    await run();
    assert.equal(pasted()[0], '/exit', 'the queued /exit goes before the new message');
    assert.equal(control(exit.id).status, 'done');
    assert.equal(conversation(message.id), 'delivered');
    assert.ok(pasted().findIndex(line => line.includes('new message while busy')) > 0);
    assert.equal(pasted().filter(isCheck).length, 0);
  }
  const rows = db.getDb().prepare('SELECT raw_content FROM control_queue').all();
  assert.equal(rows.filter(row => row.raw_content === SINGLE_UPGRADE_RESTART_CHECK_PROMPT).length, 3, 'one check per restart');
  console.log('Single upgrade check outcome:', JSON.stringify({ controls: db.getDb().prepare('SELECT id, raw_content = ? AS check_control, status FROM control_queue ORDER BY id')
    .all(SINGLE_UPGRADE_RESTART_CHECK_PROMPT) }));
});
