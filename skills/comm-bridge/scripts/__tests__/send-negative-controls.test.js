import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import { fixture } from './c4-v2-test-helpers.js';
import { sendExternal, readAbsorbedReply } from '../c4-send-external.js';

async function variant(t, before, after) {
  const url = new URL('../c4-send-external.js', import.meta.url);
  const source = fs.readFileSync(url, 'utf8');
  assert.ok(source.includes(before), 'mutation anchor must exist');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'send-mutant-'));
  t.after(() => fs.rmSync(dir, { recursive:true, force:true }));
  const filename = path.join(dir, 'sender.mjs');
  fs.writeFileSync(filename, source.replace(before, after).replace(/from '(\.\/[^']+)'/g,
    (_, name) => `from '${new URL(name, url).href}'`));
  return (await import(pathToFileURL(filename).href)).sendExternal;
}

function setup(t, endpoint, absorbed) {
  const {db,store} = fixture(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'send-control-'));
  t.after(() => fs.rmSync(dir,{recursive:true,force:true}));
  fs.mkdirSync(path.join(dir,'demo/scripts'),{recursive:true});
  fs.writeFileSync(path.join(dir,'demo/scripts/send.js'),'process.exit(0)');
  const api = {...store,getDb:()=>db,validateChannel:()=>{},
    getConversationsByRange:(a,b)=>db.prepare('SELECT * FROM conversations WHERE id>=? AND id<=?').all(a,b)};
  let request = {channel:'demo',endpoint};
  if (absorbed) {
    const row = store.insertConversation('in','demo',endpoint,'original',{groupName:'room'});
    const {runId} = store.beginModeTransition('single','multi');
    store.setDrainFence('*'); store.absorbForTransition(runId);
    request = readAbsorbedReply(runId,String(row.id),api);
  }
  return {db,dir,api,request};
}

async function overlimitCheck(t, sender, absorbed) {
  const {db,dir,api,request} = setup(t,'x'.repeat(131072),absorbed);
  let starts = 0;
  await assert.rejects(sender(request,'body',{api,skillsDir:dir,
    spawnComponent:()=>{
      starts++;
      const child = new EventEmitter();
      queueMicrotask(()=>child.emit('close',0,null));
      return child;
    }}),{code:'ENDPOINT_NOT_PASSABLE'});
  assert.equal(starts,0);
  assert.equal(db.prepare("SELECT count(*) n FROM conversations WHERE direction='out'").get().n,0);
}

async function spawnFailureCheck(t, sender, absorbed) {
  const {db,dir,api,request} = setup(t,'endpoint',absorbed);
  let starts = 0;
  await assert.rejects(sender(request,'body',{api,skillsDir:dir,
    spawnComponent:()=>{
      starts++;
      const child = new EventEmitter();
      queueMicrotask(()=>child.emit('error',Object.assign(new Error('not executable'),{code:'EACCES'})));
      // The second call returns a handled error emitter so the resend mutant
      // cannot create an unrelated unhandled-error failure.
      child.on('error',()=>{});
      return child;
    }}),{code:'COMPONENT_SPAWN_FAILED'});
  assert.equal(starts,1,'send failures must not automatically resend');
  assert.equal(db.prepare("SELECT count(*) n FROM conversations WHERE status='delivered'").get().n,1,'committed audit must survive send failure');
}

test('IF-68 endpoint and spawn-failure acceptance checks pass on current sender',async t=>{
  for (const absorbed of [false,true]) {
    await overlimitCheck(t,sendExternal,absorbed);
    await spawnFailureCheck(t,sendExternal,absorbed);
  }
});

test('IF-68 overlimit-allowed and endpoint-truncation controls fail the same endpoint acceptance check',async t=>{
  const variants = [
    ['export const ARG_PAYLOAD_MAX = 131071;', 'export const ARG_PAYLOAD_MAX = 131072;'],
    ['const { channel, endpoint, groupName } = request;',
      'const { channel, groupName } = request; const endpoint = request.endpoint?.slice(0, ARG_PAYLOAD_MAX) ?? null;'],
  ];
  for (const [before,after] of variants) {
    const sender = await variant(t,before,after);
    for (const absorbed of [false,true]) await assert.rejects(overlimitCheck(t,sender,absorbed),{code:'ERR_ASSERTION'});
  }
});

test('IF-68 audit-removal, spawn-misclassification and automatic-resend controls fail the same retained-audit check',async t=>{
  const declaration = "const spawnFailed = error => reject(sendError('COMPONENT_SPAWN_FAILED',\n      `Component did not start (${error.code || 'UNKNOWN'}); audit retained; not sent`));";
  const inject = action => declaration.replace('error => reject', `error => { ${action}; return reject`).replace('not sent`));','not sent`)); };');
  const variants = [
    [declaration, inject("api.getDb().prepare('DELETE FROM conversations WHERE id=?').run(record.id)")],
    ["sendError('COMPONENT_SPAWN_FAILED',", "sendError('SEND_FAILED',"],
    [declaration, inject("spawnComponent('node', [script, endpoint, message], {stdio:'inherit'})")],
  ];
  for (const [before,after] of variants) {
    const sender = await variant(t,before,after);
    for (const absorbed of [false,true]) await assert.rejects(spawnFailureCheck(t,sender,absorbed),{code:'ERR_ASSERTION'});
  }
});
