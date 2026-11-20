import { test, expect, afterEach } from '@jest/globals';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const workers = new Set(), roots = [];
const repository = fileURLToPath(new URL('../', import.meta.url));
afterEach(async () => {
  for (const worker of workers) if (worker.child.exitCode === null && worker.child.signalCode === null) { worker.child.kill('SIGKILL'); await once(worker.child, 'exit'); }
  workers.clear();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function root() {
  const temporary = fs.realpathSync(process.env.TMPDIR);
  const dir = fs.mkdtempSync(path.join(temporary, 'sw-')); roots.push(dir);
  fs.mkdirSync(path.join(dir, '.zylos')); fs.writeFileSync(path.join(dir, '.zylos/config.json'), JSON.stringify({ runtime: 'claude', session_mode: 'single' }));
  fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });
  return dir;
}
function launch(dir, fault = '', initialScenes = []) {
  const env = { ...process.env, HOME: dir, ZYLOS_DIR: dir, PM2_HOME: path.join(dir, 'pm2'),
    TMPDIR: dir, TMUX_TMPDIR: dir, ZYLOS_PACKAGE_ROOT: repository };
  delete env.TMUX;
  for (const key of ['ZYLOS_RUN_ID', 'ZYLOS_SESSION_GROUP', 'CLAUDE_SESSION_ID', 'CODEX_SESSION_ID']) delete env[key];
  const actual = fs.realpathSync(dir);
  const realHome = fs.realpathSync(process.env.HOME);
  assert.ok(!actual.startsWith(realHome + path.sep) && actual !== realHome);
  const database = path.join(dir, 'comm-bridge/c4.db');
  const socket = path.join(dir, 'activity-monitor/am.sock');
  for (const target of [env.PM2_HOME, database, socket]) assert.ok(target.startsWith(actual + path.sep));
  console.info({ HOME: env.HOME, ZYLOS_DIR: env.ZYLOS_DIR, PM2_HOME: env.PM2_HOME, TMPDIR: env.TMPDIR, database, socket });
  const child = fork(fileURLToPath(new URL('./helpers/mode-switch-supervisor-worker.js', import.meta.url)), [fault, JSON.stringify(initialScenes)], {
    env, silent: true });
  let stderr = ''; child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
  const messages = [], waits = [];
  child.on('message', data => waits.length ? waits.shift().resolve(data) : messages.push(data));
  child.on('exit', (code, signal) => { for (const wait of waits.splice(0)) wait.reject(new Error(`supervisor exit ${code ?? signal}: ${stderr}`)); });
  const next = () => messages.length ? Promise.resolve(messages.shift()) : new Promise((resolve, reject) => waits.push({ resolve, reject }));
  const worker = { child, next, stderr: () => stderr, command: async value => { child.send(value); const answer = await next(); assert.equal(answer.error, undefined, answer.stack); return answer; } }; workers.add(worker); return worker;
}
// Keep startup explicit and empty, then admit the missing-key first migration
// through the real socket before the next observation tick.
async function request(dir, target = 'multi') {
  fs.writeFileSync(path.join(dir, '.zylos/config.json'), JSON.stringify({ runtime: 'claude' }));
  fs.writeFileSync(path.join(dir, 'memory/state.md'), 'prior source state\n');
  const socket = net.createConnection(path.join(dir, 'activity-monitor/am.sock')); await once(socket, 'connect');
  socket.end(JSON.stringify({ version: 1, type: 'mode_switch', requestId: 'mode-switch-integration', target }) + '\n');
  socket.setTimeout(2000, () => socket.destroy(new Error('Supervisor reply timed out')));
  let text = '';
  for await (const chunk of socket) {
    text += chunk;
    assert.ok(text.length < 8192, 'supervisor reply exceeds fixture limit');
  }
  return JSON.parse(text);
}
async function kill(worker) { worker.child.kill('SIGKILL'); await once(worker.child, 'exit'); workers.delete(worker); }
async function finish(worker) {
  let value;
  for (let index = 0; index < 8; index++) { value = await worker.command('tick'); if (value.last?.phase === 'complete' && !value.row) return value; }
  throw new Error(`Transition failed to finish: ${JSON.stringify(value)}`);
}
// Run for config publication, dispatcher confirmation and completion ordering.
// The private worker uses its own database and supervisor socket, with injected
// runtime and process-manager boundaries. Skip for unrelated changes.
for (const point of ['before-config', 'after-config', 'before-confirm', 'before-complete', 'after-complete']) {
  test(`first migration recovers after interruption at ${point}`, async () => {
    const dir = root();
    let worker = launch(dir, point);
    await worker.next();
    await worker.command({ seed: [{ content: 'pending source message' }] });
    const accepted = await request(dir);
    assert.equal(accepted.result, 'accepted');
    let signal;
    for (let tick = 0; tick < 8; tick++) {
      signal = await worker.command('tick');
      if (signal.boundary) break;
    }
    expect(signal.boundary).toBe(point);
    await kill(worker);
    worker = launch(dir);
    const first = await worker.next();
    const done = first.last?.phase === 'complete' ? first : await finish(worker);
    expect(done.last.run_id).toBe(accepted.runId);
    expect(done.fences).toEqual([]);
    expect(done.mode.mode).toBe('multi');
    expect(done.messages).toEqual([{ id: 1, status: 'pending', session_group: 'origin' }]);
  }, 20000);
}

function diagnostics(dir) {
  const file = path.join(dir, 'activity-monitor/supervisor-events.jsonl');
  return fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
}

// Run for missing-deadline/config-conflict gating or supervisor restart changes.
// This required case uses an isolated worker/database and injected scenes, with
// no real tmux session or PM2 service.
test('real supervisor missing deadlines and mode conflict remain blocked across restart then recover',async()=>{
 // A present source executor keeps its controls blocked; absent legacy
 // executors are intentionally cleaned up during single-to-multi migration.
 const scenes=[{sessionGroup:'origin',runId:'source-control-owner',present:true,ready:false,processRunning:true}];
 const dir=root(); let worker=launch(dir,'',scenes); await worker.next(); await worker.command({controlGroup:null});
 const socket = net.createConnection(path.join(dir, 'activity-monitor/am.sock'));
 await once(socket, 'connect');
 socket.end(JSON.stringify({version:1,type:'mode_switch',requestId:'native-fixture',target:'multi'})+'\n');
 const chunks = [];
 for await (const chunk of socket) chunks.push(chunk);
 expect(JSON.parse(Buffer.concat(chunks).toString()).result).toBe('accepted');
 let state=await worker.command('tick'); expect(state.row.reason).toBe('running_control_without_deadline:machine:1');
 await worker.command('tick'); expect(diagnostics(dir).filter(e=>e.event==='transition_blocked').length).toBe(1);
 await kill(worker); worker=launch(dir,'',scenes); await worker.next(); state=await worker.command('tick'); expect(state.row.reason).toBe('running_control_without_deadline:machine:1');
 expect(diagnostics(dir).filter(e=>e.event==='transition_blocked').length).toBe(2);
 await worker.command('expire-controls'); await worker.command({controlGroup:'telegram:other'}); state=await worker.command('tick'); expect(state.row.reason).toBe('running_control_without_deadline:allSessionGroups:2');
 fs.writeFileSync(path.join(dir,'.zylos/config.json'),JSON.stringify({runtime:'claude',session_mode:'multi'}));
 state=await worker.command('tick'); expect(state.row.reason).toBe('mode_conflict:gating:multi'); expect(state.fences.map(f=>f.sessionGroup)).toEqual(['*']);
 fs.writeFileSync(path.join(dir,'.zylos/config.json'),JSON.stringify({runtime:'claude',session_mode:'single'}));
 await worker.command('expire-controls'); await worker.command({scenes:[]}); const done=await finish(worker); expect(done.last.reason).toBeNull(); expect(done.fences).toEqual([]);
},20000);
