import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Store } from '../src/lib/store.js';
import { CoreLogImporter } from '../src/lib/core-log-importer.js';

const hash = text => createHash('sha256').update(text).digest('hex');
const line = (event = 'a', size = 128) => {
  const text = JSON.stringify({ v: 1, ts: 0, event });
  return text + ' '.repeat(Math.max(0, size - Buffer.byteLength(text) - 1)) + '\n';
};
const injectedIdentity = async handle => ({ ...await handle.stat(), dev: 17, ino: 49 });
const sixteen = '{"v":1,"ts":0} \n';
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'core-import-'));
  const file = path.join(root, 'events.jsonl');
  const dbPath = path.join(root, 'dashboard.db');
  const store = new Store(dbPath);
  const importer = new CoreLogImporter({ store, zylosDir: root, batchLines: 2, ...options });
  t.after(async () => { await importer.stop(); store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, file, dbPath, store, importer,
    write: text => fs.writeFileSync(file, text),
    append: text => fs.appendFileSync(file, text),
    read: () => importer.importStream({ stream: 'events:origin', file }),
    rows: () => store.db.prepare('SELECT * FROM core_log_cursors ORDER BY generation').all(),
    events: () => store.queryEvents(),
    diagnostics: () => store.getSourceHealth().map(r => r.extra),
  };
}
function unchanged(old, current) {
  for (const key of ['anchor_len', 'anchor_sha256', 'byte_offset', 'file_name']) assert.equal(current[key], old[key], key);
}
function replacement(f, old, reason, count = 2) {
  const rows = f.rows(); assert.equal(rows.length, 2); assert.equal(rows[0].status, 'gap');
  unchanged(old, rows[0]); assert.equal(rows[1].generation, 2);
  assert.equal(f.events().length, count);
  const gaps = f.diagnostics().filter(d => ['shorter_than_anchor', 'shorter_than_offset', 'anchor_mismatch'].includes(d.reason));
  assert.equal(gaps.length, 1); assert.equal(gaps[0].reason, reason);
}

test('empty and half line stay g1; first16-byte anchor remains fixed across multi-batch growth', async t => {
  const f = fixture(t); f.write(''); await f.read();
  assert.equal(f.rows()[0].anchor_len, 0); assert.equal(f.rows()[0].byte_offset, 0);
  f.write(sixteen.slice(0, -1)); await f.read(); assert.equal(f.rows()[0].anchor_len, 0);
  f.append('\n'); await f.read(); assert.equal(Buffer.byteLength(sixteen), 16);
  assert.equal(f.rows()[0].anchor_len, 16); assert.equal(f.rows()[0].anchor_sha256, hash(sixteen));
  for (let i = 0; i < 4; i++) { f.append(line('append', 2048)); await f.read(); }
  assert.equal(f.rows().length, 1); assert.equal(f.rows()[0].generation, 1);
  assert.equal(f.rows()[0].anchor_len, 16); assert.equal(f.rows()[0].byte_offset, 8208);
  assert.equal(f.events().length, 5); await f.read(); assert.equal(f.events().length, 5);
});
test('long first line anchors exact first4096 bytes, snapshot anchor independent of batch boundary', async t => {
  const f = fixture(t, { batchLines: 1, batchBytes: 4096 }); f.write(line('long', 9000)); await f.read();
  assert.equal(f.rows()[0].anchor_len, 4096); assert.equal(f.rows()[0].anchor_sha256, hash(line('long', 9000).slice(0,4096)));
  assert.equal(f.events().length, 1);
  const g = fixture(t, { batchLines: 1 }); g.write(sixteen + line('later', 8192)); await g.read();
  assert.equal(g.rows()[0].anchor_len,4096); assert.equal(g.rows()[0].anchor_sha256,hash((sixteen + line('later',8192)).slice(0,4096)));
});
test('two rotations between polls consume old tail, every middle and current; rename preserves identity', async t => {
  const f=fixture(t); f.write(line('old')); await f.read(); f.append(line('old-tail'));
  fs.renameSync(f.file,path.join(f.root,'events.100.jsonl')); f.write(line('middle'));
  fs.renameSync(f.file,path.join(f.root,'events.200.jsonl')); f.write(line('current')); await f.read();
  assert.deepEqual(f.events().map(e=>e.event_type),['old','old-tail','middle','current']);
  assert.equal(f.rows().length,3); assert.ok(f.rows().every(r=>r.generation===1));
  assert.equal(f.rows().filter(r=>r.status==='done').length,2);
  fs.renameSync(f.file,path.join(f.root,'events.300.jsonl')); f.write(line('next')); await f.read();
  assert.equal(f.events().length,5); assert.equal(f.rows().length,4);
  assert.equal(f.rows().filter(r=>r.status==='done').length,3);
});
test('same dev/ino different prefix creates g2 atomically, old metadata and events retained, restart no g3', async t => {
  const f=fixture(t, { statFile: injectedIdentity }); f.write(line('A',128)); await f.read(); const old=f.rows()[0];
  f.write(line('B',256)); await f.read(); replacement(f,old,'anchor_mismatch');
  assert.equal(f.rows()[1].byte_offset,256);
  assert.notEqual(f.events()[0].ingest_id,f.events()[1].ingest_id);
  const fresh=new CoreLogImporter({store:f.store,zylosDir:f.root,statFile:injectedIdentity});
  await fresh.importStream({stream:'events:origin',file:f.file}); await fresh.stop();
  assert.equal(f.rows().length,2); assert.equal(f.events().length,2);
});
async function crash(f, phase) {
  const child=spawn(process.execPath,[path.join(import.meta.dirname,'fixtures/core-import-crash.js'),f.dbPath,f.file,phase,f.importer.statFile === injectedIdentity ? 'injected' : 'native'],
    {stdio:['ignore','pipe','pipe'],env:{...process.env,ZYLOS_DIR:f.root}});
  let stderr=''; child.stderr.on('data',d=>stderr+=d);
  const result=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',(code,signal)=>resolve({code,signal}));});
  assert.equal(result.signal,'SIGKILL',stderr); return result;
}
test('actual process death before new-generation COMMIT leaves no partial g2/gap', async t => {
  const f=fixture(t, { statFile: injectedIdentity }); f.write(line('A')); await f.read(); const old=f.rows()[0]; f.write(line('B',256));
  await crash(f,'beforeCommit'); assert.deepEqual(f.rows(),[old]); assert.equal(f.events().length,1);
  await f.read(); replacement(f,old,'anchor_mismatch');
});
test('size below anchor/offset and changed hash reports only shorter_than_anchor', async t => {
  const f=fixture(t, { statFile: injectedIdentity }); f.write(line('A')); await f.read(); const old=f.rows()[0]; f.write(line('B',64));
  await f.read(); replacement(f,old,'shorter_than_anchor');
});
test('size below offset but above16-byte anchor takes shorter_than_offset before hash', async t => {
  const f=fixture(t, { statFile: injectedIdentity }); f.write(sixteen); await f.read(); f.append(line('A',112)); await f.read(); const old=f.rows()[0];
  f.write(line('B',64)); await f.read(); replacement(f,old,'shorter_than_offset',3);
});
test('truncation to own prefix imports prefix again in g2, retaining old history', async t => {
  const f=fixture(t, { statFile: injectedIdentity }); f.write(sixteen); await f.read(); f.append(line('A',112)); await f.read(); const old=f.rows()[0];
  f.write(sixteen); await f.read(); replacement(f,old,'shorter_than_offset',3);
  assert.match(f.events()[2].ingest_id,/:g2:0$/);
});
test('actual process death after INSERT before COMMIT rolls both back; after COMMIT resumes without duplicate', async t => {
  const f=fixture(t); f.write(line('A')); await f.read(); const old=f.rows()[0]; f.append(line('B'));
  await crash(f,'afterInsert'); assert.deepEqual(f.rows(),[old]); assert.equal(f.events().length,1);
  await crash(f,'afterCommit'); assert.equal(f.rows()[0].byte_offset,256); assert.equal(f.events().length,2);
  await f.read(); assert.equal(f.events().length,2); assert.equal(f.rows().length,1);
});
test('removed old cursor produces durable gap and continues earliest retained rotation', async t => {
  const f=fixture(t); f.write(line('old')); await f.read();
  fs.renameSync(f.file,path.join(f.root,'deleted.jsonl'));
  fs.writeFileSync(path.join(f.root,'events.100.jsonl'),line('earliest'));
  fs.writeFileSync(path.join(f.root,'events.200.jsonl'),line('later')); f.write(line('current')); await f.read();
  assert.deepEqual(f.events().map(e=>e.event_type),['old','earliest','later','current']);
  assert.equal(f.rows().filter(r=>r.status==='gap').length,1);
  assert.equal(f.diagnostics().filter(d=>d.reason==='file_missing').length,1);
});
test('directory disappearance retains history and cursors without recreating source; discovery uses Core paths',async t=>{
  const f=fixture(t);const dir=path.join(f.root,'activity-monitor/session-groups/origin');fs.mkdirSync(dir,{recursive:true});
  const file=path.join(dir,'events.jsonl');fs.writeFileSync(file,line('exists'));await f.importer.poll();
  assert.equal(f.events().length,1);fs.renameSync(dir,dir+'.removed');await f.importer.poll();
  assert.equal(fs.existsSync(dir),false);assert.equal(f.rows()[0].status,'source_missing');assert.equal(f.events().length,1);
  assert.ok(f.diagnostics().some(d=>d.reason==='source_missing'));
});
test('half lines, malformed segments, higher versions, unknown fields and identity/redaction are separate',async t=>{
  const f=fixture(t);const row={v:2,ts:1,event:'pre_tool',runtime:'codex',session_group:'telegram:g-1',run_id:'run1',session_id:'session1',
    tool:'Bash',tool_input:{command:'echo sk-abcdefghijklmnopqrstuvwxyz123456'}, extra:'do not store',content:'do not store'};
  f.write(JSON.stringify(row)+'\n{bad}\n'+line('known')+'{"v":1');await f.read();
  assert.equal(f.events().length,2);const e=f.events()[0];assert.equal(e.session_group,row.session_group);assert.equal(e.run_id,'run1');
  assert.equal(e.runtime,'codex');assert.equal(e.session_id,'session1');assert.equal(e.event_type,'pre_tool_use');
  const serialized=JSON.stringify(e);assert.ok(!serialized.includes('abcdefghijklmnopqrstuvwxyz'));assert.ok(!serialized.includes('do not store'));
  assert.equal(f.rows()[0].byte_offset,Buffer.byteLength(JSON.stringify(row)+'\n{bad}\n'+line('known')));
  assert.ok(f.diagnostics().some(d=>d.reason==='unknown_version'));assert.ok(f.diagnostics().some(d=>d.reason==='malformed_line'));
  f.append(',"ts":0}\n');await f.read();assert.equal(f.events().length,3);assert.equal(f.events()[2].runtime,'unknown');
  assert.equal(f.events()[2].session_group,null);assert.equal(f.events()[2].run_id,null);
  const output=await f.importer.sanitizeEvents(f.events());assert.ok(!JSON.stringify(output).includes('abcdefghijklmnopqrstuvwxyz'));
});
test('four diagnostic streams import pool as pool_sample with absent identities unknown',async t=>{
  const f=fixture(t);for(const [dir,name] of [['comm-bridge','router-events'],['comm-bridge','receive-events'],['activity-monitor','supervisor-events'],['activity-monitor','pool-metrics']]){
    fs.mkdirSync(path.join(f.root,dir),{recursive:true});fs.writeFileSync(path.join(f.root,dir,name+'.jsonl'),line('diagnostic'));
  }await f.importer.poll();assert.equal(f.events().length,4);assert.equal(f.events().filter(e=>e.event_type==='pool_sample').length,1);
  assert.ok(f.events().every(e=>e.runtime==='unknown'&&e.session_group===null));
});
test('filtered SQL pagination includes group/runtime/run/session/type before LIMIT; history unassigned is explicit',async t=>{
  const f=fixture(t);for(let i=0;i<12;i++)f.store.insertEvent({id:String(i),ingest_id:String(i),timestamp:'2026-01-01',event_type:i%2?'x':'y',category:'test',
    runtime:i%2?'codex':'claude',session_group:i%2?'origin':null,run_id:i%2?'r':null,session_id:i%2?'s':null});
  const filtered=f.store.queryEvents({types:['x','z'],runtime:'codex',sessionGroup:'origin',runId:'r',sessionId:'s',limit:2,offset:2});
  assert.deepEqual(filtered.map(e=>e.id),['5','7']);assert.equal(f.store.queryEvents({sessionGroup:null}).length,6);
  assert.deepEqual(f.store.queryEvents({afterSeq:10}).map(e=>e.id),['10','11']);
  assert.equal(f.store.queryEvents({limit:NaN}).length,12);assert.equal(f.store.queryEvents({limit:-1}).length,1);
});
test('poll discovery failures persist a diagnostic that successful discovery clears',async t=>{
  const f=fixture(t);await f.importer.poll();
  assert.ok(!f.store.getHistoryDiagnostics().some(row=>row.name==='core-log'));
  const discover=f.importer.discover.bind(f.importer);f.importer.discover=async()=>{throw Object.assign(new Error('fixture'),{code:'EACCES'});};
  await assert.rejects(f.importer.poll(),{code:'EACCES'});
  assert.equal(f.store.getHistoryDiagnostics().find(row=>row.name==='core-log').extra.reason,'import_failed');
  f.importer.discover=discover;await f.importer.poll();
  assert.ok(!f.store.getHistoryDiagnostics().some(row=>row.name==='core-log'));
});

test('Supervisor diagnostics preserve explicit producer IDs, never infer missing identity from another record',async t=>{
  const f=fixture(t);f.write(JSON.stringify({v:1,ts:1,event:'rotate_done',session_group:'origin',runId:'run-old',sessionId:'session-new',oldSessionId:'session-old',requestId:'request'})+'\n');
  await f.importer.importFile('supervisor',f.file);const e=f.events()[0];assert.equal(e.run_id,'run-old');assert.equal(e.session_id,'session-new');
  assert.equal(e.metadata.requestId,'request');assert.equal(e.metadata.oldSessionId,'session-old');
  f.append(JSON.stringify({v:1,ts:2,event:'restart_done',requestId:'request2'})+'\n');await f.importer.importFile('supervisor',f.file);
  assert.equal(f.events()[1].run_id,null);assert.equal(f.events()[1].session_group,null);
});

test('health observations retain their type and never inflate activity counts', async t => {
  const f = fixture(t);
  const events = ['stop', 'session_start', 'prompt_submit', 'stop_failure'];
  f.write(events.flatMap(event => [{ v: 1, ts: 1, event }, { v: 1, ts: 1, type: 'runtime_health', event }]).map(JSON.stringify).join('\n') + '\n');
  await f.read();
  for (const event of events) {
    assert.equal(f.store.queryEvents({ types: [event] }).length, 1);
    const health = f.store.queryEvents({ types: [`runtime_health:${event}`] });
    assert.equal(health.length, 1); assert.equal(health[0].category, 'runtime_health');
    assert.equal(health[0].metadata.type, 'runtime_health');
  }
});

test('diagnostic free text and receive rejection details use Sanitizer before indexing and again at output', async t => {
  const f = fixture(t); const secret = 'sk-' + 'a'.repeat(24);
  f.write(JSON.stringify({ v: 1, ts: 1, event: 'post_tool_failure', error: secret, reason: secret,
    reason_code: 'rejected', channel: 'telegram', endpoint: '123', detail: `failed: ${secret}` }) + '\n');
  await f.read(); const event = f.events()[0];
  assert.equal(event.metadata.error, '[REDACTED]'); assert.equal(event.metadata.reason, '[REDACTED]');
  assert.equal(event.metadata.detail, 'failed: [REDACTED]');
  assert.equal(event.metadata.reason_code, 'rejected'); assert.equal(event.metadata.channel, 'telegram'); assert.equal(event.metadata.endpoint, '123');
  assert.ok(!JSON.stringify(event).includes(secret));
  assert.ok(!JSON.stringify(await f.importer.sanitizeEvents([{ metadata: { error: secret, reason: secret } }])).includes(secret));
});

test('source recovery clears only current failures; historical gaps remain; quiet scans make zero writes', async t => {
  const f = fixture(t);
  const absent = path.join(f.root, 'absent', 'events.jsonl');
  await f.importer.importStream({ stream: 'events:origin', file: absent });
  assert.equal(f.store.getHistoryDiagnostics({ stream: 'events:origin' }).length, 1);
  f.write(line('ok') + '{bad}\n'); await f.read();
  const diagnostics = f.store.getHistoryDiagnostics({ sessionGroup: 'origin' });
  assert.deepEqual(diagnostics.map(row => row.extra.reason), ['malformed_line']);
  const before = f.store.db.prepare('SELECT total_changes() AS n').get().n;
  await f.read(); await f.importer.importStream({ stream: 'missing', file: path.join(f.root, 'missing', 'events.jsonl') });
  const firstMissing = f.store.db.prepare('SELECT total_changes() AS n').get().n;
  assert.equal(firstMissing, before + 1);
  await f.read(); await f.importer.importStream({ stream: 'missing', file: path.join(f.root, 'missing', 'events.jsonl') });
  assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get().n, firstMissing);
});

test('single-stream failures affect health and recover without erasing historical diagnostics', async t => {
  const f = fixture(t); f.write(line('ok'));
  f.importer.discover = async () => [{ stream: 'events:origin', file: f.file }];
  const statFile = f.importer.statFile;
  f.importer.statFile = async () => { throw Object.assign(new Error('fixture'), { code: 'EACCES' }); };
  await f.importer.poll();
  assert.equal(f.store.getHistoryDiagnostics()[0].extra.reason, 'read_failed');
  f.importer.statFile = statFile; await f.importer.poll();
  assert.equal(f.store.getHistoryDiagnostics().length, 0);
});

test('scan descriptors survive rename before consumption; old tail precedes next current', async t => {
  const f = fixture(t); f.write(line('e1')); await f.read(); f.append(line('e2'));
  let renamed = false;
  f.importer.statFile = async handle => {
    const stat = await handle.stat();
    if (!renamed) { renamed = true; fs.renameSync(f.file, path.join(f.root, 'events.100.jsonl')); f.write(line('e3')); }
    return stat;
  };
  await f.read(); await f.read();
  assert.deepEqual(f.events().map(event => event.event_type), ['e1', 'e2', 'e3']);
});

test('rotated partial tail is done without advancing past the complete line boundary', async t => {
  const f = fixture(t); f.write(line('old') + '{partial');
  fs.renameSync(f.file, path.join(f.root, 'events.100.jsonl')); f.write(line('current')); await f.read();
  const old = f.rows().find(row => row.file_name === 'events.100.jsonl');
  assert.equal(old.status, 'done'); assert.equal(old.byte_offset, 128);
  assert.deepEqual(f.events().map(event => event.event_type), ['old', 'current']);
});

test('history notification follows commit and is absent on rollback or stale preparation', async t => {
  const notifications = []; const f = fixture(t, { onImport: event => notifications.push(event) });
  f.write(line('a')); f.importer.transactionObserver = point => { if (point === 'beforeCommit') throw new Error('rollback'); };
  await assert.rejects(f.read(), /rollback/); assert.equal(notifications.length, 0); assert.equal(f.events().length, 0); assert.equal(f.rows().length, 0);
  f.importer.transactionObserver = point => { if (point === 'afterCommit') assert.equal(f.events().length, 1); };
  await f.read(); assert.deepEqual(notifications, [{ stream: 'events:origin', inserted: 1 }]); await f.read(); assert.equal(notifications.length, 1);
  f.append(line('b')); const normalize = f.importer.normalize.bind(f.importer); let advanced = false;
  f.importer.transactionObserver = undefined;
  f.importer.normalize = async (...args) => { const result = await normalize(...args); if (!advanced) { advanced = true; const other = new CoreLogImporter({ store: f.store, zylosDir: f.root }); await other.importFile('events:origin', f.file); await other.stop(); } return result; };
  await f.read(); assert.equal(notifications.length, 1); assert.equal(f.events().length, 2);
});

for (const status of ['done', 'gap', 'source_missing']) test(`new generation preserves terminal ${status} predecessor`, async t => {
  const f = fixture(t, { statFile: injectedIdentity }); f.write(line('A')); await f.read();
  f.store.db.prepare('UPDATE core_log_cursors SET status=?').run(status); const old = f.rows()[0];
  f.write(line('B', 256)); await f.read();
  assert.deepEqual(f.rows()[0], old); assert.equal(f.rows()[1].generation, 2); assert.equal(f.events().length, 2);
});


test('every committed batch publishes its events and cursor together', async t => {
  const f = fixture(t, { batchLines: 1 });
  f.write(line('a') + line('b'));
  f.importer.transactionObserver = phase => {
    if (phase !== 'afterCommit') return;
    assert.equal(f.store.db.inTransaction, false);
    for (const event of f.events()) {
      if (event.source !== 'core-log') continue;
      const [, stream, dev, ino, generation, offset] = event.ingest_id.match(/^core:(.*):(\d+):(\d+):g(\d+):(\d+)$/);
      const cursor = f.rows().find(row => row.stream === stream && row.file_dev === Number(dev)
        && row.file_ino === Number(ino) && row.generation === Number(generation));
      assert.ok(cursor, 'each committed event has its committed cursor');
      assert.ok(Number(offset) < cursor.byte_offset, 'no committed event starts at or beyond its cursor');
    }
  };
  await f.read();
  assert.equal(f.events().length, 2); assert.equal(f.rows()[0].byte_offset, 256);
});

test('content-only redaction preserves real identities through indexing and output', async t => {
  const f = fixture(t); const group = 'ns:task-00000000-1111-2222-3333-444444444444';
  const row = { v: 1, ts: 1, event: 'stop', runtime: 'claude', session_group: group,
    run_id: 'task-force-coordination-2026', session_id: 'desk-engineering-collaboration', error: 'sk-' + 'x'.repeat(24) };
  f.write(JSON.stringify(row) + '\n');
  await f.importer.importStream({ stream: `events:${group}`, file: f.file });
  const events = f.store.queryEvents({ sessionGroup: group, runId: row.run_id }); assert.equal(events.length, 1);
  for (const event of [...events, ...await f.importer.sanitizeEvents(events)]) {
    assert.equal(event.session_group, group); assert.equal(event.run_id, row.run_id); assert.equal(event.session_id, row.session_id);
    assert.equal(event.metadata.stream, `events:${group}`); assert.equal(event.metadata.error, '[REDACTED]');
  }
  const gap = { name: `core:events:${group}:source_missing`, signal_type: 'history', extra: { stream: `events:${group}`, error: row.error } };
  const output = (await f.importer.sanitizeEvents([gap]))[0];
  assert.equal(output.name, gap.name); assert.equal(output.extra.stream, gap.extra.stream); assert.equal(output.extra.error, '[REDACTED]');
});

test('import-side engine redaction runs after Sanitizer and cannot modify identity fields', async t => {
  const calls = []; const marker = 'engine-only-sensitive-value';
  const redactor = { async redactValue(value) {
    calls.push(...structuredClone(value));
    return { value: JSON.parse(JSON.stringify(value).replaceAll(marker, '[ENGINE]')), failed: false };
  } };
  const f = fixture(t, { redactor });
  f.write(JSON.stringify({ v: 1, ts: 1, event: 'diagnostic', session_group: marker, error: marker }) + '\n');
  await f.read(); assert.equal(f.events()[0].metadata.error, '[ENGINE]'); assert.equal(f.events()[0].session_group, marker);
  assert.ok(calls.some(value => value.metadata?.error === marker));
  assert.ok(calls.every(value => !Object.hasOwn(value, 'session_group') && !Object.hasOwn(value.metadata || {}, 'stream')));
});

test('rotation between directory listing and open is reconciled before declaring a gap', async t => {
  const f = fixture(t); f.write(line('e1')); await f.read(); f.append(line('e2'));
  let rotated = false;
  f.importer.readDirectory = async dir => {
    const names = fs.readdirSync(dir);
    if (!rotated) { rotated = true; fs.renameSync(f.file, path.join(f.root, 'events.100.jsonl')); f.write(line('e3')); }
    return names;
  };
  await f.read();
  assert.deepEqual(f.events().map(event => event.event_type), ['e1', 'e2', 'e3']);
  assert.ok(!f.diagnostics().some(item => item.reason === 'file_missing'));
});

for (const absentDirectory of [false, true]) test(`read failure recovers when source becomes ${absentDirectory ? 'absent directory' : 'empty directory'}, then recurs`, async t => {
  const f = fixture(t); const directory = path.join(f.root, 'source'); fs.mkdirSync(directory);
  const file = path.join(directory, 'events.jsonl'); fs.writeFileSync(file, line('a'));
  f.importer.discover = async () => [{ stream: 'events:origin', file }];
  const stat = f.importer.statFile; f.importer.statFile = async () => { throw Object.assign(new Error('fixture'), { code: 'EACCES' }); };
  await f.importer.poll(); assert.ok(f.store.getHistoryDiagnostics().some(row => row.extra.reason === 'read_failed'));
  f.importer.statFile = stat; fs.unlinkSync(file); if (absentDirectory) fs.rmdirSync(directory);
  await f.importer.poll();
  assert.ok(!f.store.getHistoryDiagnostics().some(row => row.extra.reason === 'read_failed'));
  fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(file, line('b'));
  f.importer.statFile = async () => { throw Object.assign(new Error('fixture'), { code: 'EACCES' }); };
  await f.importer.poll(); assert.ok(f.store.getHistoryDiagnostics().some(row => row.extra.reason === 'read_failed'));
});

test('successful discovery clears global error even while one stream still fails', async t => {
  const f = fixture(t); f.write(line('a'));
  f.importer.discover = async () => { throw new Error('discovery'); };
  await assert.rejects(f.importer.poll());
  f.importer.discover = async () => [{ stream: 'events:origin', file: f.file }];
  f.importer.statFile = async () => { throw Object.assign(new Error('read'), { code: 'EACCES' }); };
  await f.importer.poll(); const diagnostics = f.store.getHistoryDiagnostics();
  assert.ok(!diagnostics.some(row => row.name === 'core-log'));
  assert.ok(diagnostics.some(row => row.extra.reason === 'read_failed'));
});

test('cursor recheck prevents a stale batch from moving a farther competing cursor backward', async t => {
  const f = fixture(t, { batchLines: 1 }); f.write(line('a')); await f.read();
  f.append(line('b') + line('c') + line('d'));
  const normalize = f.importer.normalize.bind(f.importer); let advanced = false;
  let lastCommittedOffset = f.rows()[0].byte_offset;
  let commits = 0;
  f.importer.transactionObserver = point => {
    if (point !== 'afterCommit') return;
    const offset = f.rows()[0].byte_offset;
    assert.ok(offset >= lastCommittedOffset, 'a committed cursor never moves backward');
    lastCommittedOffset = offset; commits++;
  };
  f.importer.normalize = async (...args) => {
    const result = await normalize(...args);
    if (!advanced) {
      advanced = true;
      const other = new CoreLogImporter({ store: f.store, zylosDir: f.root, transactionObserver: f.importer.transactionObserver });
      await other.importFile('events:origin', f.file); await other.stop();
      assert.equal(f.rows()[0].byte_offset, 512);
    }
    return result;
  };
  await f.read(); assert.equal(f.rows()[0].byte_offset, 512); assert.equal(f.events().length, 4);
  assert.equal(commits, 1); assert.equal(lastCommittedOffset, 512);
});

test('rotation expiring after a partial batch marks the consumed prefix as a gap', async t => {
  const f = fixture(t, { batchLines: 1 }); const rotated = path.join(f.root, 'events.100.jsonl');
  fs.writeFileSync(rotated, line('a') + line('b') + line('c')); f.write(line('current'));
  let removed = false;
  f.importer.transactionObserver = point => { if (point === 'afterCommit' && !removed) { removed = true; fs.unlinkSync(rotated); } };
  await f.read();
  const cursor = f.rows().find(row => row.file_name === 'events.100.jsonl');
  assert.equal(cursor.status, 'gap'); assert.equal(cursor.byte_offset, 128);
  assert.deepEqual(f.events().map(event => event.event_type), ['a', 'current']);
  assert.equal(f.diagnostics().filter(row => row.reason === 'file_missing').length, 1);
});


test('malformed engine results fail closed and produce redaction_failed diagnostics', async t => {
  for (const value of ['wrong-shape', ['wrong-item']]) {
    const f = fixture(t, { redactor: { async redactValue() { return { value }; } } });
    f.write(JSON.stringify({ v: 1, ts: 1, event: 'stop', error: 'private-text' }) + '\n'); await f.read();
    assert.ok(!JSON.stringify(f.events()).includes('private-text'));
    assert.ok(f.diagnostics().some(item => item.reason === 'redaction_failed'));
  }
});


test('session filter distinguishes sessions sharing one run and descending pagination keeps newest first', async t => {
  const f = fixture(t);
  for (const [id, session] of [['a', 's1'], ['b', 's2'], ['c', 's1']]) {
    assert.equal(f.store.insertEvent({ id, ingest_id: id, timestamp: '2026-01-01', event_type: 'stop', category: 'turn',
      runtime: 'claude', run_id: 'shared-run', session_id: session }).inserted, true);
  }
  assert.deepEqual(f.store.queryEvents({ runId: 'shared-run', sessionId: 's1' }).map(row => row.id), ['a', 'c']);
  assert.deepEqual(f.store.queryEvents({ order: 'desc', limit: 2 }).map(row => row.id), ['c', 'b']);
});

test('receive group rejection keeps an explicitly empty group unassigned', async t => {
  const f = fixture(t);
  f.write(JSON.stringify({ v: 1, ts: 1, event: 'group_rejected', session_group: '', reason_code: 'invalid_group' }) + '\n');
  await f.importer.importStream({ stream: 'receive', file: f.file });
  assert.equal(f.events().length, 1); assert.equal(f.events()[0].session_group, null);
  assert.equal(f.store.queryEvents({ sessionGroup: null }).length, 1);
});

test('byte budget commits complete lines in bounded batches independently of the line count', async t => {
  const offsets = [], counts = [];
  const f = fixture(t, { batchLines: 200, batchBytes: 4096 });
  f.write(line('a', 2048) + line('b', 2048) + line('c', 2048));
  f.importer.transactionObserver = point => {
    if (point === 'afterCommit') { offsets.push(f.rows()[0].byte_offset); counts.push(f.events().length); }
  };
  await f.read();
  assert.deepEqual(offsets, [4096, 6144]); assert.deepEqual(counts, [2, 3]);
  assert.deepEqual(f.events().map(event => event.event_type), ['a', 'b', 'c']);
});
test('invalid enum text is retained in metadata while indexed fields become unknown', async t => {
  const f = fixture(t);
  for (const value of ['bad type!', 'x'.repeat(65)]) {
    f.append(JSON.stringify({ v: 1, ts: 1, event: value, runtime: value }) + '\n');
  }
  await f.importer.importStream({ stream: 'receive', file: f.file });
  assert.deepEqual(f.events().map(event => [event.event_type, event.runtime]), [['unknown', 'unknown'], ['unknown', 'unknown']]);
  assert.deepEqual(f.events().map(event => [event.metadata.event_type, event.metadata.runtime]), [['bad type!', 'bad type!'], ['x'.repeat(65), 'x'.repeat(65)]]);
});

test('diagnostic identities with invalid characters are not restored as trusted identity', async t => {
  const f = fixture(t);
  f.write(JSON.stringify({ v: 1, ts: 1, event: 'decision', requestId: 'bad identity!', sessionGroup: 'bad group!' }) + '\n');
  await f.importer.importStream({ stream: 'receive', file: f.file });
  for (const event of [...f.events(), ...await f.importer.sanitizeEvents(f.events())]) {
    assert.equal(Object.hasOwn(event.metadata, 'requestId'), false);
    assert.equal(Object.hasOwn(event.metadata, 'sessionGroup'), false);
  }
});

test('a newly created empty source directory clears its earlier missing warning without a cursor', async t => {
  const f = fixture(t), directory = path.join(f.root, 'new-source');
  const source = { stream: 'receive', file: path.join(directory, 'receive.jsonl') };
  await f.importer.importStream(source);
  assert.equal(f.rows().length, 0);
  assert.ok(f.store.getHistoryDiagnostics({ stream: 'receive' }).some(row => row.extra.reason === 'source_missing'));
  fs.mkdirSync(directory);
  await f.importer.importStream(source);
  assert.deepEqual(f.store.getHistoryDiagnostics({ stream: 'receive' }), []);
  assert.equal(f.rows().length, 0);
});
