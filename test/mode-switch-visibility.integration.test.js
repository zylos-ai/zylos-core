import { test, expect, afterEach } from '@jest/globals';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
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
function root(mode = 'single') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p10-recovery-')); roots.push(dir);
  fs.mkdirSync(path.join(dir, '.zylos')); fs.writeFileSync(path.join(dir, '.zylos/config.json'), JSON.stringify({ runtime: 'claude', session_mode: mode }));
  fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'memory/state.md'), 'prior source state\n');
  return dir;
}
function launch(dir, fault = '') {
  const child = fork(fileURLToPath(new URL('./helpers/mode-switch-supervisor-worker.js', import.meta.url)), [fault], {
    env: { ...process.env, HOME: dir, ZYLOS_DIR: dir, ZYLOS_PACKAGE_ROOT: repository }, silent: true });
  let stderr = ''; child.stderr.on('data', chunk => stderr += chunk);
  const messages = [], waits = [];
  child.on('message', data => waits.length ? waits.shift().resolve(data) : messages.push(data));
  child.on('exit', (code, signal) => { for (const wait of waits.splice(0)) wait.reject(new Error(`M4 exit ${code ?? signal}: ${stderr}`)); });
  const next = () => messages.length ? Promise.resolve(messages.shift()) : new Promise((resolve, reject) => waits.push({ resolve, reject }));
  const worker = { child, next, stderr: () => stderr, command: async value => { child.send(value); const answer = await next(); assert.equal(answer.error, undefined, answer.stack); return answer; } }; workers.add(worker); return worker;
}
async function request(dir, target = 'multi') {
  const socket = net.createConnection(path.join(dir, 'activity-monitor/am.sock')); await once(socket, 'connect');
  socket.end(JSON.stringify({ version: 1, type: 'mode_switch', requestId: 'p10-integration', target }) + '\n');
  let text = ''; for await (const chunk of socket) text += chunk; return JSON.parse(text);
}
async function kill(worker) { worker.child.kill('SIGKILL'); await once(worker.child, 'exit'); workers.delete(worker); }
async function finish(worker) {
  let value;
  for (let index = 0; index < 8; index++) { value = await worker.command('tick'); if (value.last?.phase === 'complete' && !value.row) return value; }
  throw new Error(`Transition failed to finish: ${JSON.stringify(value)}`);
}
for (const source of ['single', 'multi']) for (const phase of ['gating', 'converting', 'cutover']) test(`IF-39 ${source} real M4 crash during ${phase} resumes same D9/cutoff and completes atomically`, async () => {
  const target = source === 'single' ? 'multi' : 'single';
  const dir = root(source); let worker = launch(dir); expect((await worker.next()).ready).toBe(true);
  await worker.command({ seed: [{ content: 'pending source message' }] });
  const accepted = await request(dir, target); expect(accepted.result).toBe('accepted');
  if (phase !== 'gating') await worker.command('tick');
  if (phase === 'cutover') await worker.command('tick');
  const before = await worker.command('snapshot'); expect(before.row.phase).toBe(phase);
  await kill(worker); worker = launch(dir); const restored = await worker.next(); expect(restored.ready).toBe(true);
  const done = await finish(worker); expect(done.last.run_id).toBe(accepted.runId); expect(done.last.cutoff).toBe(before.row.cutoff ?? 1);
  expect(done.fences).toEqual([]); expect(done.mode.mode).toBe(target);
  if (source === 'single') expect(fs.readFileSync(path.join(dir, 'memory/state.md'), 'utf8')).toBe('prior source state\n');
}, 20000);

for (const source of ['single','multi']) for (const point of ['before-config', 'after-config', 'before-confirm', 'before-complete', 'after-complete']) test(`IF-39 ${source} real M4 SIGKILL ${point} preserves artifacts and recovers forward`, async () => {
  const target=source==='single'?'multi':'single';
  const dir = root(source); let worker = launch(dir, point); await worker.next();
  await worker.command({ seed: [{ content: 'pending source message' }] });
  const accepted = await request(dir,target);
  await worker.command('tick'); await worker.command('tick');
  let signal = await worker.command('tick');
  if (!signal.boundary) signal = await worker.command('tick');
  expect(signal.boundary).toBe(point);
  const state = path.join(dir, source==='single'?'memory/session-groups/origin/state.md':'memory/state.md');
  const written = fs.readFileSync(state, 'utf8');
  await kill(worker); worker = launch(dir); const first = await worker.next();
  const done = first.last?.phase === 'complete' ? first : await finish(worker);
  expect(done.last.run_id).toBe(accepted.runId); expect(done.fences).toEqual([]); expect(done.mode.mode).toBe(target);
  expect(fs.readFileSync(state, 'utf8')).toBe(written);
}, 20000);

for (const source of ['single','multi']) test(`IF-39 ${source} real P05 reclaim waits starting runtime then ends exact source run`, async () => {
  const dir=root(source), worker=launch(dir); await worker.next();
  const target=source==='single'?'multi':'single';
  await worker.command({scenes:[{sessionGroup:'origin',runId:'old-source',present:true,ready:false,processRunning:false}]});
  const accepted=await request(dir,target); expect(accepted.result).toBe('accepted');
  const waiting=await worker.command('tick'); expect(waiting.row.phase).toBe('gating'); expect(waiting.stoppedRuns).toEqual([]);
  expect(waiting.fences.map(row=>row.sessionGroup)).toEqual(['*']);
  await worker.command({scenes:[{sessionGroup:'origin',runId:'old-source',present:true,ready:true,processRunning:false}]});
  const reclaimed=await worker.command('tick'); expect(reclaimed.row.phase).toBe('converting'); expect(reclaimed.stoppedRuns).toEqual(['old-source']);
  const done=await finish(worker); expect(done.mode.mode).toBe(target); expect(done.fences).toEqual([]);
},20000);

for (const source of ['single','multi']) test(`IF-39 ${source} converting recovery keeps frozen cutoff and leaves later input pending`,async()=>{
 const dir=root(source); let worker=launch(dir); await worker.next();
 await worker.command({seed:[{content:'before cutoff'}]}); const accepted=await request(dir,source==='single'?'multi':'single');
 const absorbed=await worker.command('tick'); expect(absorbed.row.phase).toBe('converting'); expect(absorbed.row.cutoff).toBe(1);
 await worker.command({seed:[{content:'after cutoff'}]}); await kill(worker); worker=launch(dir); await worker.next();
 const done=await finish(worker); expect(done.last.run_id).toBe(accepted.runId); expect(done.last.cutoff).toBe(1); expect(done.last.absorbed_ids).toEqual([1]);
 expect(done.messages).toEqual([{id:1,status:'switch_absorbed'},{id:2,status:'pending'}]);
},20000);

const diagnostics = dir => fs.readFileSync(path.join(dir,'activity-monitor/supervisor-events.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
test('IF-66 real M4 conversion/config/PM2 failures persist reasons, dedup A-B-A, unblock and keep gate until complete',async()=>{
 const dir=root(), worker=launch(dir); await worker.next(); await worker.command({seed:[{content:'pending'}]});
 const accepted=await request(dir); await worker.command('tick');
 for(const step of ['export','export','check','export']){
  await worker.command({failure:step}); const state=await worker.command('tick');
  expect(state.row.reason).toBe(`conversion_failed:${step}:EIO`); expect(state.row.phase).toBe('converting'); expect(state.fences.map(f=>f.sessionGroup)).toEqual(['*']);
 }
 expect(diagnostics(dir).filter(e=>e.event==='transition_convert_failed').map(e=>e.reason)).toEqual(['conversion_failed:export:EIO','conversion_failed:check:EIO','conversion_failed:export:EIO']);
 await worker.command({failure:''}); expect((await worker.command('tick')).row.phase).toBe('cutover');
 await worker.command({failure:'config'}); let state=await worker.command('tick'); expect(state.row.reason).toBe('config_write_failed:CONFIG_LOCK_TIMEOUT'); expect(state.mode.mode).toBe('single');
 await worker.command({failure:'pm2'}); state=await worker.command('tick'); expect(state.row.reason).toBe('m1_restart_unconfirmed'); expect(state.mode.mode).toBe('multi'); expect(state.fences.map(f=>f.sessionGroup)).toEqual(['*']);
 await worker.command({failure:''}); const done=await finish(worker); expect(done.last.run_id).toBe(accepted.runId); expect(done.last.reason).toBeNull(); expect(done.fences).toEqual([]);
 expect(diagnostics(dir).filter(e=>e.event==='transition_unblocked').length).toBeGreaterThanOrEqual(2);
 expect(done.logs.some(e=>String(e.error).includes('external notification'))).toBe(false);
},20000);

for(const intent of ['manual','corrupt'])test(`IF-36/38 real M4 automatic migration defers to ${intent} F9`,async()=>{
 const dir=root(); fs.writeFileSync(path.join(dir,'.zylos/config.json'),JSON.stringify({runtime:'claude'}));
 fs.mkdirSync(path.join(dir,'activity-monitor'),{recursive:true});
 const file=path.join(dir,'activity-monitor/restart-requests.json');
 const content=intent==='manual'?JSON.stringify([{requestId:'earlier-manual',reason:'manual_restart',acceptedAt:Date.now(),runIds:['older-run'],mode:'single',expectedRunId:'older-run'}]):'{broken';
 fs.writeFileSync(file,content); const worker=launch(dir), ready=await worker.next();
 expect(ready.row).toBeNull(); expect(ready.fences).toEqual([]); expect(ready.mode.mode).toBeNull();
 if(intent==='corrupt'){expect(fs.readFileSync(file,'utf8')).toBe(content); expect((await worker.command('tick')).row).toBeNull();}
 else {const tick=await worker.command('tick'); expect(tick.row?.phase).toBe('gating');}
},20000);

test('IF-66 real M4 missing deadlines and mode conflict remain blocked across restart then recover',async()=>{
 const dir=root(); let worker=launch(dir); await worker.next(); await worker.command({controlGroup:null}); await request(dir);
 let state=await worker.command('tick'); expect(state.row.reason).toBe('running_control_without_deadline:machine:1');
 await worker.command('tick'); expect(diagnostics(dir).filter(e=>e.event==='transition_blocked').length).toBe(1);
 await kill(worker); worker=launch(dir); state=await worker.next(); expect(state.row.reason).toBe('running_control_without_deadline:machine:1');
 expect(diagnostics(dir).filter(e=>e.event==='transition_blocked').length).toBe(2);
 await worker.command('expire-controls'); await worker.command({controlGroup:'origin'}); state=await worker.command('tick'); expect(state.row.reason).toBe('running_control_without_deadline:allSessionGroups:2');
 fs.writeFileSync(path.join(dir,'.zylos/config.json'),JSON.stringify({runtime:'claude',session_mode:'multi'}));
 state=await worker.command('tick'); expect(state.row.reason).toBe('mode_conflict:gating:multi'); expect(state.fences.map(f=>f.sessionGroup)).toEqual(['*']);
 fs.writeFileSync(path.join(dir,'.zylos/config.json'),JSON.stringify({runtime:'claude',session_mode:'single'}));
 await worker.command('expire-controls'); const done=await finish(worker); expect(done.last.reason).toBeNull(); expect(done.fences).toEqual([]);
},20000);


for (const source of ['single', 'multi']) test(`DM-41 ${source} real M4 archive collision retains gate and completes after operator moves conflict`, async () => {
  const dir = root(source), worker = launch(dir);
  await worker.next();
  await worker.command({ seed: [{ content: 'pending source message' }] });
  const target = source === 'single' ? 'multi' : 'single';
  const accepted = await request(dir, target);
  const absorbed = await worker.command('tick');
  expect(absorbed.row.phase).toBe('converting');
  const targetDir = path.join(dir, source === 'single' ? 'memory/session-groups/origin' : 'memory');
  const previous = path.join(dir, 'memory/mode-switch', accepted.runId, 'previous', source === 'single' ? 'origin' : '_global');
  fs.mkdirSync(targetDir, { recursive: true });
  fs.mkdirSync(previous, { recursive: true });
  fs.writeFileSync(path.join(targetDir, 'state.md'), 'old target state\n');
  const conflict = path.join(previous, 'state.md');
  fs.writeFileSync(conflict, 'conflicting archived state\n');
  for (let tick = 0; tick < 2; tick++) {
    const blocked = await worker.command('tick');
    expect(blocked.row.phase).toBe('converting');
    expect(blocked.row.reason).toBe('conversion_failed:archive:EEXIST');
    expect(blocked.row.run_id).toBe(accepted.runId);
    expect(blocked.row.cutoff).toBe(absorbed.row.cutoff);
    expect(blocked.row.absorbed_ids).toEqual(absorbed.row.absorbed_ids);
    expect(blocked.fences.map(fence => fence.sessionGroup)).toEqual(['*']);
    expect(blocked.mode.mode).toBe(source);
  }
  expect(fs.readFileSync(path.join(targetDir, 'state.md'), 'utf8')).toBe('old target state\n');
  expect(fs.existsSync(path.join(previous, '.done'))).toBe(false);
  expect(diagnostics(dir).filter(event => event.event === 'transition_convert_failed').map(event => event.reason)).toEqual(['conversion_failed:archive:EEXIST']);
  const retained = path.join(dir, 'operator-retained-conflict.md');
  expect(fs.readFileSync(conflict, 'utf8')).toBe('conflicting archived state\n');
  fs.renameSync(path.join(targetDir, 'state.md'), retained);
  const done = await finish(worker);
  expect(done.last.run_id).toBe(accepted.runId);
  expect(done.last.cutoff).toBe(absorbed.row.cutoff);
  expect(done.last.reason).toBeNull();
  expect(done.mode.mode).toBe(target);
  expect(done.fences).toEqual([]);
  expect(fs.readFileSync(retained, 'utf8')).toBe('old target state\n');
  expect(fs.readFileSync(path.join(previous, 'state.md'), 'utf8')).toBe('conflicting archived state\n');
  expect(diagnostics(dir).filter(event => event.event === 'absorb')).toHaveLength(1);
}, 20000);
