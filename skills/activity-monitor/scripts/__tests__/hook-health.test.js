import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, mock } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { collectHealthHook, readHealthInbox, acknowledgeHealthEvent, wakeHealthMonitor } from '../hook-health.js';
import { createRuntimeGeneration, readRuntimeGeneration, runtimeGenerationEnv, readProcessStart } from '../runtime-generation.js';
import {writeHealthQuota} from '../health-quota.js';

function fixture(t) {
  const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-hook-'));
  t.after(() => fs.rmSync(zylosDir, { recursive: true, force: true }));
  const identity = createRuntimeGeneration('claude', { zylosDir, nowMs: 100 });
  return { zylosDir, identity, env: runtimeGenerationEnv(identity), pid: 1234, processStart: 'boot:42', nowMs: 200 };
}
const failure = { hook_event_name: 'StopFailure', session_id: 'session-1', prompt_id: 'prompt-1', error: 'rate_limit' };
test('durable sanitized failure survives lost wake and can be acknowledged only after import', async (t) => {
  const options = fixture(t);
  const event = collectHealthHook({ ...failure, prompt: 'PRIVATE PROMPT', error_details: 'PRIVATE TOKEN', last_assistant_message: 'PRIVATE ANSWER' }, options);
  assert.equal(event.runtime_generation, options.identity.runtime_generation);
  assert.equal(event.process_start, 'boot:42');
  assert.equal(event.error, 'rate_limit');
  assert.equal(JSON.stringify(event).includes('PRIVATE'), false);
  await wakeHealthMonitor({ zylosDir: options.zylosDir, timeoutMs: 10 });
  const records = readHealthInbox(options);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].event, event);
  assert.equal(fs.statSync(records[0].file).mode & 0o777, 0o600);
  assert.throws(() => acknowledgeHealthEvent(path.join(options.zylosDir, 'unrelated.json'), options));
  acknowledgeHealthEvent(records[0].file, options);
  assert.deepEqual(readHealthInbox(options), []);
});
test('exact prompt duplicates coalesce; missing prompt IDs remain independent without invented turn ordering', (t) => {
  const options = fixture(t);
  const a = collectHealthHook(failure, options);
  const b = collectHealthHook(failure, options);
  const c = collectHealthHook({ ...failure, prompt_id: undefined }, options);
  assert.equal(a.event_id, b.event_id);
  assert.equal(c.prompt_id, null);
  assert.equal(readHealthInbox(options).length, 2);
  assert.equal(Object.hasOwn(c, 'turn'), false);
});
test('rejects old launches, missing inherited provenance, malformed events and subagents', (t) => {
  const options = fixture(t);
  for (const payload of [{ ...failure, agent_id: 'nested' }, { ...failure, error: 'secret value' }, { ...failure, session_id: '' }, { ...failure, hook_event_name: 'PostToolUse' }]) assert.equal(collectHealthHook(payload, options), null);
  assert.equal(collectHealthHook(failure, { ...options, env: {} }), null);
  createRuntimeGeneration('codex', options);
  assert.equal(collectHealthHook(failure, options), null);
  assert.deepEqual(readHealthInbox(options), []);
});
test('unknown error identifiers do not persist arbitrary diagnostic tokens', (t) => {
  const options = fixture(t);
  const event = collectHealthHook({ ...failure, error: 'PRIVATE_TOKEN_VALUE' }, options);
  assert.equal(event.error, 'unknown');
  assert.equal(JSON.stringify(event).includes('PRIVATE'), false);
});
test('session and prompt events retain metadata but never prompt content', (t) => {
  const options = fixture(t);
  assert.equal(collectHealthHook({ ...failure, hook_event_name: 'SessionStart' }, options).event, 'session_start');
  const event = collectHealthHook({ ...failure, hook_event_name: 'UserPromptSubmit', prompt: 'PRIVATE' }, options);
  assert.equal(event.event, 'prompt_submit');
  assert.equal(event.error, null);
  assert.equal(JSON.stringify(event).includes('PRIVATE'), false);
});
test('failed file sync is not acknowledged and does not leave a partial event', (t) => {
  const options = fixture(t);
  fs.mkdirSync(path.join(options.zylosDir, 'activity-monitor', 'health-inbox'));
  const sync = mock.method(fs, 'fsyncSync', () => { throw new Error('disk fault'); });
  try { assert.throws(() => collectHealthHook(failure, options), /disk fault/); } finally { sync.mock.restore(); }
  assert.deepEqual(readHealthInbox(options), []);
});
test('failure after rename retains a recoverable event rather than deleting its only copy', (t) => {
  const options = fixture(t);
  fs.mkdirSync(path.join(options.zylosDir, 'activity-monitor', 'health-inbox'));
  const original = fs.fsyncSync;
  let count = 0;
  const sync = mock.method(fs, 'fsyncSync', (fd) => { if (++count === 2) throw new Error('directory fault'); return original(fd); });
  try { assert.throws(() => collectHealthHook(failure, options), /directory fault/); } finally { sync.mock.restore(); }
  assert.equal(readHealthInbox(options).length, 1);
});
test('Stop records completed-response metadata only', t => {
  const options=fixture(t);
  const event=collectHealthHook({...failure,hook_event_name:'Stop',last_assistant_message:'PRIVATE'},options);
  assert.equal(event.event,'stop');assert.equal(event.error,null);
  assert.equal(JSON.stringify(event).includes('PRIVATE'),false);
});
test('capacity preserves pending failures, accepts duplicates, and explicitly reports lost unique events', t => {
  const options={...fixture(t),inboxLimit:1};
  const first=collectHealthHook(failure,options);
  assert.equal(collectHealthHook(failure,options).event_id,first.event_id);
  assert.throws(()=>collectHealthHook({...failure,prompt_id:'other'},options),/capacity/);
  assert.equal(readHealthInbox(options).length,1);
  const diagnostic=JSON.parse(fs.readFileSync(path.join(options.zylosDir,'activity-monitor','health-inbox-overflow.json')));
  assert.equal(diagnostic.event_lost,true);
  acknowledgeHealthEvent(readHealthInbox(options)[0].file,options);
  assert.ok(collectHealthHook({...failure,prompt_id:'other'},options));
});
test('concurrent collectors cannot exceed admission cap', async t => {
  const options={...fixture(t),inboxLimit:2};
  const script=new URL('../hook-health.js',import.meta.url).href;
  await Promise.all(Array.from({length:8},(_,index)=>new Promise((resolve,reject)=>{
    const source=`import {collectHealthHook} from ${JSON.stringify(script)};try{collectHealthHook(${JSON.stringify({...failure,prompt_id:`p${index}`})},${JSON.stringify(options)});}catch{}`;
    const child=spawn(process.execPath,['--input-type=module','-e',source],{stdio:'ignore'});
    child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error('collector failed')));
  })));
  assert.ok(readHealthInbox(options).length<=2);
  assert.ok(fs.existsSync(path.join(options.zylosDir,'activity-monitor','health-inbox-overflow.json')));
});
test('kernel admission lock releases when owner crashes', async t => {
  const options=fixture(t);
  const directory=path.join(options.zylosDir,'activity-monitor','health-inbox');fs.mkdirSync(directory);
  const source=`import fs from 'node:fs';import{execFileSync}from'node:child_process';const fd=fs.openSync(${JSON.stringify(path.join(directory,'.admission'))},'a');execFileSync('flock',['-n','3'],{stdio:['ignore','ignore','ignore',fd]});console.log('ready');setInterval(()=>{},1000);`;
  const child=spawn(process.execPath,['--input-type=module','-e',source],{stdio:['ignore','pipe','ignore']});
  t.after(()=>child.kill('SIGKILL'));
  await once(child.stdout,'data');
  assert.throws(()=>collectHealthHook(failure,options),/admission busy/);
  const exited=once(child,'exit');child.kill('SIGKILL');await exited;
  assert.ok(collectHealthHook(failure,options));
});
test('crash after temporary fsync recovers original event before admitting new records', async t=>{
  const options={...fixture(t),inboxLimit:1,pid:process.pid,processStart:readProcessStart(process.pid)};
  fs.writeFileSync(path.join(options.zylosDir,'activity-monitor','foreground-session.json'),JSON.stringify({runtime_generation:options.identity.runtime_generation,session_id:failure.session_id,claude_pid:options.pid,process_start:options.processStart}));
  writeHealthQuota({session_id:failure.session_id,rate_limits:{five_hour:{used_percentage:100}}},options);
  const failureWithMatch={...failure,last_assistant_message:"You've hit your session limit"};
  const script=new URL('../hook-health.js',import.meta.url).href;
  const source=`import fs from 'node:fs';import{collectHealthHook}from ${JSON.stringify(script)};const rename=fs.renameSync;fs.renameSync=(from,to)=>{if(to.includes('/health-inbox/')&&to.endsWith('.json'))process.kill(process.pid,'SIGKILL');return rename(from,to);};collectHealthHook(${JSON.stringify(failureWithMatch)},${JSON.stringify(options)});`;
  const child=spawn(process.execPath,['--input-type=module','-e',source],{stdio:'ignore'});
  const [,signal]=await once(child,'exit');assert.equal(signal,'SIGKILL');
  const directory=path.join(options.zylosDir,'activity-monitor','health-inbox');
  assert.equal(readHealthInbox(options).length,0);
  assert.equal(fs.readdirSync(directory).filter(n=>n.endsWith('.tmp')).length,1);
  assert.throws(()=>collectHealthHook({...failure,prompt_id:'new'},options),/capacity/);
  const recovered=collectHealthHook(failure,{...options,nowMs:9999});
  assert.equal(recovered.received_at,options.nowMs);
  assert.equal(recovered.quota.rate_limits.five_hour.used_percentage,100);
  assert.equal(recovered.notice_match.kind,'quota');
  assert.equal(readHealthInbox(options).length,1);
  assert.equal(fs.readdirSync(directory).filter(n=>n.endsWith('.tmp')||n.endsWith('.staged')).length,0);
});
test('admission removes only malformed writer-owned temporaries and recovers old staged copies',t=>{
  const options=fixture(t);const original=collectHealthHook(failure,options);
  const directory=path.join(options.zylosDir,'activity-monitor','health-inbox');
  const final=path.join(directory,`${original.event_id}.json`);
  fs.renameSync(final,path.join(directory,`${original.event_id}.00000000-0000-0000-0000-000000000001.staged`));
  const malformed=path.join(directory,'00000000-0000-0000-0000-000000000002.json.00000000-0000-0000-0000-000000000003.tmp');
  fs.writeFileSync(malformed,'{"unfinished":');
  fs.writeFileSync(path.join(directory,'unrelated.tmp'),'retain');
  collectHealthHook({...failure,prompt_id:'next'},options);
  assert.equal(readHealthInbox(options).length,2);
  assert.equal(fs.existsSync(malformed),false);
  assert.equal(fs.readFileSync(path.join(directory,'unrelated.tmp'),'utf8'),'retain');
});
test('launch generation changes even within the same millisecond and process proof handles command parentheses', (t) => {
  const options = fixture(t);
  const next = createRuntimeGeneration('claude', { zylosDir: options.zylosDir, nowMs: 100 });
  assert.notEqual(next.runtime_generation, options.identity.runtime_generation);
  assert.deepEqual(readRuntimeGeneration(options.zylosDir), next);
  const fields = ['S', ...Array(18).fill('0'), '987'];
  assert.equal(readProcessStart(12, { platform: 'linux', readFileSync: file => file.endsWith('/stat') ? `12 (a tricky) command) ${fields.join(' ')}` : 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }), 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa:987');
  assert.equal(readProcessStart(12, { platform: 'darwin' }), null);
});
