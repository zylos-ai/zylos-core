import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readCodexSampleForIdentity } from '../codex/rollout.js';
import { readRecordedAccountUsage } from '../../recorded-account-usage.js';

const identity={present:true,ready:true,runtime:'codex',runId:'run',sessionId:'session',createdAt:123,serverGeneration:'gen',tmuxSessionId:'$1',paneId:'%1'};
const row=(timestamp='2026-10-22T01:02:03.456Z',used=10)=>({timestamp,type:'event_msg',payload:{type:'token_count',info:{last_token_usage:{input_tokens:used},model_context_window:100},rate_limits:{primary:{window_minutes:10080,used_percent:71,resets_at:42},secondary:{window_minutes:300,used_percent:23,resets_at:43}}}});
const line=value=>JSON.stringify(value)+'\n';
function fixture(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'session-runtime-usage-'));const dir=path.join(root,'activity-monitor/session-groups/lark:x');fs.mkdirSync(dir,{recursive:true});const rollout=path.join(root,'rollout.jsonl');const events=path.join(dir,'events.jsonl');const event={v:1,ts:100,event:'session_start',runtime:'codex',session_group:'lark:x',run_id:'run',session_id:'session',transcript_path:rollout};fs.writeFileSync(events,line(event));fs.writeFileSync(rollout,line(row()));return {root,dir,rollout,events,event,env:{ZYLOS_DIR:root},clean:()=>fs.rmSync(root,{recursive:true,force:true})};}

test('Codex uses exact F6 scope/run/session and last complete token_count with its own timestamp',()=>{
 const f=fixture();const read=()=>readCodexSampleForIdentity({sessionGroup:'lark:x',identity,env:f.env});
 try{
  const sampled=read();assert.deepEqual(sampled.sample.contextUsage,{used:10,ceiling:100});assert.equal(sampled.sample.capturedAt,Date.parse('2026-10-22T01:02:03.456Z'));
  assert.deepEqual(sampled.sample.rateLimits,{sevenDay:{usedPercentage:71,resetsAt:42},fiveHour:{usedPercentage:23,resetsAt:43}});
  fs.appendFileSync(f.rollout,JSON.stringify(row('2026-10-22T01:02:04.789Z',20)));assert.equal(read().sample.contextUsage.used,10);
  fs.appendFileSync(f.rollout,'\n');assert.equal(read().sample.contextUsage.used,20);
  fs.appendFileSync(f.events,line({...f.event,run_id:'other',transcript_path:'/not-used'})+line({...f.event,session_id:'other',transcript_path:'/not-used'})+line({...f.event,session_group:'lark:y',transcript_path:'/not-used'}));assert.equal(read().sample.contextUsage.used,20);
  for(const field of ['run_id','session_id','session_group','runtime']){fs.writeFileSync(f.events,line({...f.event,[field]:'wrong'}));assert.equal(read(),null,field);}
  fs.writeFileSync(f.events,JSON.stringify(f.event));assert.equal(read(),null,'incomplete event must not count');
  fs.writeFileSync(f.events,line({...f.event,transcript_path:'relative.jsonl'}));assert.equal(read(),null);
 }finally{f.clean();}
});

test('recorded Codex account usage follows changes to a group\'s events log and to its latest rollout', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recorded-codex-usage-'));
  const env = { ZYLOS_DIR: root }, now = Date.parse('2026-10-22T02:00:00Z');
  const quota = { primary: { window_minutes: 10080, used_percent: 40, resets_at: 4102444800 } };
  const token = (timestamp, used_percent) => line({ timestamp, type: 'event_msg', payload: { type: 'token_count',
    rate_limits: { primary: { ...quota.primary, used_percent } } } });
  const group = (name) => { const dir = path.join(root, 'activity-monitor/session-groups', name); fs.mkdirSync(dir, { recursive: true }); return path.join(dir, 'events.jsonl'); };
  const start = (name, run, ts, transcript_path) => line({ v: 1, ts, event: 'session_start', runtime: 'codex',
    session_group: name, run_id: run, session_id: run, transcript_path });
  const read = async () => (await readRecordedAccountUsage('codex', env, now))?.recordedAt;
  try {
    const rolloutA = path.join(root, 'a.jsonl'), rolloutB1 = path.join(root, 'b1.jsonl'), rolloutB2 = path.join(root, 'b2.jsonl');
    fs.writeFileSync(rolloutA, token('2026-10-22T01:00:00Z', 40));
    fs.writeFileSync(rolloutB1, token('2026-10-22T00:30:00Z', 30));
    fs.writeFileSync(group('lark:a'), start('lark:a', 'a', 100, rolloutA));
    const eventsB = group('lark:b');
    fs.writeFileSync(eventsB, start('lark:b', 'b1', 100, rolloutB1));
    assert.equal(await read(), Date.parse('2026-10-22T01:00:00Z'));
    assert.equal(await read(), Date.parse('2026-10-22T01:00:00Z'));

    fs.writeFileSync(rolloutB2, token('2026-10-22T01:10:00Z', 50));
    fs.appendFileSync(eventsB, start('lark:b', 'b2', 200, rolloutB2));
    assert.equal(await read(), Date.parse('2026-10-22T01:10:00Z'), 'a new run in events.jsonl must be read');

    fs.appendFileSync(rolloutB2, token('2026-10-22T01:20:00Z', 55));
    const latest = await readRecordedAccountUsage('codex', env, now);
    assert.equal(latest.recordedAt, Date.parse('2026-10-22T01:20:00Z'), 'a new quota update in the latest rollout must be read');
    assert.equal(latest.value.sevenDay.usedPercentage, 55);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
