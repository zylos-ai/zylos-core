import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import * as schema from '../c4-schema.js';
import { guardDatabase } from '../sqlite-schema.js';
import { createStore } from '../c4-v2-store.js';
const scripts = fileURLToPath(new URL('../', import.meta.url));
function fixture(t, config, suffix = '') {
  const parent = mkdtempSync(join(tmpdir(), 'c4-cutover-'));
  const root = join(parent, 'instance' + suffix);
  mkdirSync(root);
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  mkdirSync(join(root, 'comm-bridge')); mkdirSync(join(root, '.claude/skills/chat'), { recursive: true });
  mkdirSync(join(root, '.zylos'));
  if (config !== undefined) writeFileSync(join(root, '.zylos/config.json'), JSON.stringify(config));
  const database = new Database(join(root, 'comm-bridge/c4.db'));
  guardDatabase(database, schema); database.pragma('journal_mode=WAL');
  t.after(() => database.close());
  const store = createStore(database, { validateComponent: () => true });
  const env = { HOME: root, ZYLOS_DIR: root, PATH: process.env.PATH, LANG: 'en_US.UTF-8' };
  function cli(file, args, expected = 0) {
    const result = spawnSync(process.execPath, [join(scripts, file), ...args], { env, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, expected, `${file} ${args.join(' ')}\n${result.stdout}\n${result.stderr}\n${result.error ?? ''}`);
    return result;
  }
  function data(file, args) { return JSON.parse(cli(file, [...args, '--json']).stdout).data; }
  return { database, store, cli, data, root };
}
for (const config of [undefined, { session_mode: 'single', runtime: 'claude' }]) test(`seven production call sites on real v2 DB, config=${JSON.stringify(config)}`, t => {
  const { database, cli, data } = fixture(t, config);
  const a = data('c4-db.js', ['insert', 'out', 'chat', 'endpoint', 'first']);
  assert.equal(a.session_group, 'chat');
  assert.equal(database.prepare('SELECT head_id FROM group_heads').get().head_id, a.id);
  const cp = data('c4-db.js', ['checkpoint', String(a.id), 'global summary']);
  assert.equal(cp.session_group, '*'); assert.equal(cp.summary, 'global summary');
  const b = data('c4-db.js', ['insert','out','chat','endpoint','second']);
  const range = data('c4-db.js', ['unsummarized']);
  assert.equal(range.firstConversationId, b.id); assert.equal(range.safeEnd, b.id);
  const fetch = data('c4-fetch.js', ['--unsummarized']);
  assert.deepEqual(fetch.rows.map(x => x.id), [b.id]); assert.equal(fetch.checkpointEnd, a.id);
  const text = cli('c4-fetch.js', ['--begin',String(b.id),'--end',String(b.id)]).stdout;
  assert.match(text, /global summary/); assert.match(text,/second/); assert.ok(!text.includes('first\n'));
  const end = data('c4-checkpoint.js', ['create',String(b.id),'--no-content']);
  assert.equal(end.no_content, 1); assert.equal(end.summary, null);
  const latest = data('c4-checkpoint.js', ['latest']);
  assert.equal(latest.id, cp.id); // no-content advances coverage but does not hide the content checkpoint
  assert.equal(data('c4-db.js', ['unsummarized']).count, 0);
  assert.equal(data('c4-fetch.js', ['--unsummarized']).checkpointEnd, a.id);
});
test('CLI refuses missing/conflicting summaries, bad numbers/options and wrong scopes without writes', t => {
  const { data, cli, database } = fixture(t);
  const a = data('c4-db.js', ['insert','out','chat','e','first']);
  const cases = [
    ['c4-checkpoint.js',['create',String(a.id)],'SUMMARY_INVALID'],
    ['c4-db.js',['checkpoint',String(a.id)],'SUMMARY_INVALID'],
    ['c4-checkpoint.js',['create',String(a.id),'--summary','x','--no-content'],'SUMMARY_INVALID'],
    ['c4-checkpoint.js',['create',String(a.id),'--summary',''],'SUMMARY_INVALID'],
    ['c4-checkpoint.js',['create','1x','--summary','x'],'INVALID_ARGS'],
    ['c4-db.js',['insert','out','chat','e','x','--group','chat'],'INVALID_ARGS'],
    ['c4-db.js',['unsummarized','--group','*'],'SESSION_GROUP_INVALID'],
    ['c4-fetch.js',['--unsummarized','--group','*'],'SESSION_GROUP_INVALID'],
    ['c4-fetch.js',['--unsummarized','--up-to','999'],'UPTO_BEYOND_FRONTIER'],
    ['c4-fetch.js',['--unsummarized','--limit','1','--limit','2'],'INVALID_ARGS'],
    ['c4-fetch.js',['--unsummarized','--begin','1'],'INVALID_ARGS'],
    ['c4-fetch.js',['--begin','2','--end','1'],'INVALID_ARGS'],
  ];
  for (const [file,args,code] of cases) {
    const r=cli(file,[...args,'--json'],1); assert.equal(r.stderr,''); assert.equal(JSON.parse(r.stdout).error.code,code);
  }
  assert.equal(database.prepare('SELECT count(*) AS n FROM checkpoints WHERE id>1').get().n,0);
  assert.equal(database.prepare('SELECT count(*) AS n FROM conversations').get().n,1);
});
test('scope/frontier/limit and Origin summaries use actual rows and fixed boundaries', t => {
  const { store, data, cli }=fixture(t);
  const a=store.insertConversation('in','chat','e','a',{groupName:'A'});
  store.claimConversation(a.id); store.markDelivered(a.id);
  store.createCheckpoint('chat:A',a.id,'A summary');
  const b=store.insertConversation('out','chat','e','b',{groupName:'A'});
  const c=store.insertConversation('out','chat','e','c',{groupName:'A'});
  store.insertConversation('in','chat','e','pending',{groupName:'A'});
  const other=store.insertConversation('in','chat','e','other',{groupName:'B'});
  store.claimConversation(other.id); store.markDelivered(other.id);
  const result=data('c4-fetch.js',['--unsummarized','--group','chat:A','--limit','1']);
  assert.deepEqual(result.rows.map(r=>r.id),[b.id]); assert.equal(result.upTo,b.id); assert.equal(result.safeEnd,c.id);
  assert.match(cli('c4-fetch.js',['--unsummarized','--group','chat:A','--limit','1']).stdout,new RegExp(`checkpointEnd=${a.id}.*\\n[\\s\\S]*upTo=${b.id}`));
  assert.equal(data('c4-fetch.js',['--checkpoints','--group','chat:A','--after','0'])[0].summary,'A summary');
  const summary=data('c4-fetch.js',['--origin-sync','--group','chat:A','--summaries-only']);
  assert.equal(summary.coverageEnd,a.id); assert.equal(summary.rows.length,1);
  assert.deepEqual(data('c4-fetch.js',['--origin-sync','--group','chat:A','--raw-only','--after',String(summary.coverageEnd)]).map(r=>r.id),[b.id,c.id]);
  const combined=data('c4-fetch.js',['--origin-sync','--group','chat:A','--limit','1']);
  assert.equal(combined.coverageEnd,a.id); assert.equal(combined.summaries.length,1); assert.deepEqual(combined.rows.map(r=>r.id),[b.id]); assert.equal(combined.upTo,b.id); assert.equal(combined.safeEnd,c.id);
  assert.equal(data('c4-db.js',['origin-sync','backlog']).groups.length,2);
});
test('namespace, group discovery and ordinary fetch preserve safe literal reply routing', t => {
  const { store, data, cli }=fixture(t);
  assert.equal(data('c4-db.js',['namespace','ensure','chat']).namespace,'chat');
  assert.equal(cli('c4-db.js',['session-group','chat','--session-group','A:b']).stdout,'chat:A:b\n');
  const endpoint='$(printf INJECTED); "quote"';
  const row=store.insertConversation('in','chat',endpoint,'incoming',{groupName:'A:b'});
  assert.equal(data('c4-db.js',['groups','--match','incoming'])[0].sessionGroup,'chat:A:b');
  const result=cli('c4-fetch.js',['--begin',String(row.id),'--end',String(row.id)]).stdout;
  assert.ok(result.includes("'"+endpoint+"' --session-group A:b"));
  const command=result.split('\n').find(x=>x.startsWith('---- reply via: ')).slice(16);
  // Substitute just the executable/script with a local argv printer; no real channel is invoked.
  const argv=command.slice(command.indexOf(" 'chat'"));
  const parsed=spawnSync('/bin/sh',['-c',`printf '%s\\n'${argv}`],{encoding:'utf8'});
  assert.equal(parsed.stdout,`chat\n${endpoint}\n--session-group\nA:b\n`);
});
test('absorbed real CLI pages/parts are bounded and fail without partial output', t => {
  const { store, data, cli, database }=fixture(t);
  const row=store.insertConversation('in','chat','secret endpoint','中\n\0'.repeat(2000));
  const {runId}=store.beginModeTransition('single','multi'); store.setDrainFence('*'); store.absorbForTransition(runId);
  assert.equal(data('c4-db.js',['mode-transition','show']).run_id,runId);
  for(const args of [[],['--summary'],['--id',String(row.id),'--offset','0']]) for(const json of [false,true]) {
    const out=cli('c4-fetch.js',['--absorbed','--run-id',runId,...args,'--max-bytes','2048',...(json?['--json']:[])]).stdout;
    assert.ok(Buffer.byteLength(out)<=2048); assert.ok(!out.includes('secret endpoint'));
    if(json) assert.equal(JSON.parse(out).ok,true); else assert.ok(out.endsWith('\n'));
  }
  database.prepare("UPDATE conversations SET status='failed' WHERE id=?").run(row.id);
  const result=cli('c4-fetch.js',['--absorbed','--run-id',runId,'--max-bytes','2048','--json'],1);
  assert.equal(JSON.parse(result.stdout).error.code,'ABSORBED_MISMATCH'); assert.ok(Buffer.byteLength(result.stdout)<=2048);
});

test('manual control expiration is independent of the unconnected live resolver', t => {
  const { database, cli } = fixture(t);
  const id = database.prepare("INSERT INTO control_queue(raw_content,content,status,created_at,updated_at) VALUES('fixture','fixture','pending',1,1)").run().lastInsertRowid;
  cli('c4-control.js', ['expire','--id',String(id)]);
  const row = database.prepare('SELECT status,last_error FROM control_queue WHERE id=?').get(id);
  assert.deepEqual(row, {status:'timeout',last_error:'MANUAL_EXPIRED'});
  assert.match(cli('c4-control.js', ['expire','--id',String(id)],1).stderr,/CONTROL_NOT_ACTIVE/);
  assert.match(cli('c4-control.js', ['expire','--id','1x'],1).stderr,/INVALID_ARGS/);
});

for (const suffix of ['', " space'quote", '\nline']) test(`reply route uses instance installation path ${JSON.stringify(suffix)}`, t => {
  const { store, cli, root } = fixture(t, undefined, suffix);
  const row = store.insertConversation('in', 'chat', 'endpoint', 'route probe');
  store.claimConversation(row.id); store.markDelivered(row.id);
  const installed = join(root, '.claude/skills/comm-bridge/scripts/c4-send.js');
  const quoted = "'" + installed.replaceAll("'", "'\\''") + "'";
  const expected = suffix.includes('\n')
    ? `---- reply via: 不可用（Core 路径含控制字符，见 C4 #${row.id}）`
    : `---- reply via: node ${quoted} 'chat' 'endpoint'`;
  for (const args of [['--unsummarized'], ['--begin', String(row.id), '--end', String(row.id)]]) {
    const text = cli('c4-fetch.js', args).stdout;
    assert.ok(text.includes('route probe'));
    assert.deepEqual(text.split('\n').filter(line => line.startsWith('---- reply via:')), [expected]);
    assert.ok(!text.includes(join(scripts, 'c4-send.js')));
  }
});
