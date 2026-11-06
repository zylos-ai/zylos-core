import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatState, messageState, receiptState } from '../public/js/wb/chat-state.js';

const pending = () => { let resolve, reject; const promise = new Promise((a,b) => {resolve=a;reject=b;}); return {promise,resolve,reject}; };
function fixture(extra = () => undefined) {
  const calls = [];
  const state = createChatState({ request: async (path, options) => {
    calls.push({path,options}); const result = extra(path,options); if (result !== undefined) return result;
    if (path === '/api/session-mode') return { data: { sessionMode: 'multi' } };
    if (path.includes('/messages?')) return {items:[],nextCursor:null,afterCursor:'after'};
    if (path.includes('?')) return {items:[],nextCursor:null};
    const id = decodeURIComponent(path.split('/').at(-1)); return {conversation:{id,state:'active'},conversationId:id,stored:false};
  }});
  return {state,calls};
}
for (const [status, action, expected] of [ ['pending',null,'pending'],['running',null,'running'],['delivered',null,'delivered'],['failed','delivered','failed'],['failed','auth_rejected','auth_rejected'],['failed','suppressed','suppressed'],['switch_absorbed',null,'switch_absorbed'],['unknown',null,'pending_reconciliation'] ]) {
  test(`authoritative ${status} with ${action}`, () => assert.equal(messageState({direction:'in',status,delivery_action:action}),expected));
}
test('missing and outbound states do not assert delivery', () => {
  assert.equal(messageState(null),'pending_reconciliation');
  assert.equal(messageState({direction:'out',status:'delivered'}),'stored');
  assert.equal(receiptState({stored:null,action:'delivered'}),'pending_reconciliation');
  assert.equal(receiptState({stored:true,deliveryState:'failed',action:'delivered'}),'failed');
});
test('list cursors reset on refresh and deduplicate pages', async () => {
  let count=0;
  const {state,calls}=fixture(path => path.startsWith('/api/chat/conversations?') ? (++count===1 ? {items:[{id:'g:A'}],nextCursor:'next'} : {items:[{id:'g:A'},{id:'g:B'}],nextCursor:null}) : undefined);
  await state.open(); await state.loadMore(); assert.equal(state.snapshot().items.length,2);
  assert.match(calls.at(-1).path,/cursor=next/); await state.refresh();
  assert.equal(calls.filter(x=>x.path.startsWith('/api/chat/conversations?')).at(-1).path.includes('cursor='),false);
  state.destroy();
});
test('slow group response cannot replace selected group', async () => {
  const wait=pending(); const {state}=fixture(path=>path.includes('g%3AA/messages')?wait.promise:undefined);
  await state.open(); const first=state.select('g:A'); await state.select('g:B');
  wait.resolve({items:[{id:1,content:'A'}]}); await first;
  assert.equal(state.snapshot().selectedId,'g:B'); assert.equal(state.snapshot().messages.length,0); state.destroy();
});
test('remote disable clears all data and invalidates earlier responses', async () => {
  const wait=pending(); let more=false;
  const {state}=fixture(path=>path.includes('/messages?') ? (more ? Promise.reject({code:'remote_chat_disabled'}) : wait.promise) : undefined);
  await state.open(); const first=state.select('g:A'); more=true; await state.select('g:B');
  assert.equal(state.snapshot().blocked,true); assert.equal(state.snapshot().items.length,0); assert.equal(state.snapshot().selectedId,null);
  wait.resolve({items:[{id:1,content:'secret'}]}); await first; assert.equal(state.snapshot().messages.length,0); state.destroy();
});
test('unknown send preserves edited input and needs deliberate retry', async () => {
  const {state,calls}=fixture((path,options)=>options?.method==='POST'?{stored:null,needsReconciliation:true,preserveInput:true,retryAllowed:true}:undefined);
  await state.open(); await state.select('g:A'); state.setInput('first'); await state.send(); state.setInput('edited'); await state.send();
  assert.equal(calls.filter(x=>x.options?.method==='POST').length,1); assert.equal(state.snapshot().input,'edited');
  await state.send({retry:true}); assert.equal(calls.filter(x=>x.options?.method==='POST').at(-1).options.body.retry,true); state.destroy();
});
test('single and external selection have no write eligibility', async () => {
  const {state}=fixture(path=>path==='/api/session-mode'?{data:{sessionMode:'single'}}:undefined);
  await state.open(); await state.select('g:A'); assert.equal(state.snapshot().canWrite,false); assert.equal(state.snapshot().canCreate,false);
  await state.setTab('external'); await state.select('g:A'); assert.equal(state.snapshot().canWrite,false); state.destroy();
});
test('closing suppresses in flight data and errors', async () => {
  const wait=pending(); const {state}=fixture(path=>path.includes('conversations?')?wait.promise:undefined);
  const open=state.open(); state.close(); wait.resolve({items:[{id:'g:secret'}]}); await open; assert.equal(state.snapshot().items.length,0); state.destroy();
});
test('changing instance clears saved inputs synchronously and rejects old responses', async () => {
  let identity = 'local', delayed = false;
  const wait = pending();
  const state = createChatState({identity:()=>identity,request:async path=>{
    if(path==='/api/session-mode')return {data:{sessionMode:'multi'}};
    if(path.includes('conversations?'))return delayed?wait.promise:{items:[{id:'g:A'}],nextCursor:null};
    if(path.includes('/messages?'))return {items:[],afterCursor:'after'};
    return {conversation:{id:'g:A'},conversationId:'g:A',stored:false};
  }});
  await state.open(); await state.select('g:A'); state.setInput('private local input');
  delayed=true; const old=state.refresh(); state.close(); identity='remote'; const next=state.open();
  assert.equal(state.snapshot().items.length,0); assert.equal(state.snapshot().input,''); assert.equal(state.snapshot().selectedId,null);
  wait.resolve({items:[{id:'g:B'}],nextCursor:null}); await Promise.all([old,next]);
  assert.equal(state.snapshot().selectedId,null); assert.equal(state.snapshot().input,''); state.destroy();
});
test('canonical draft conflict keeps text for a deliberate later send', async () => {
  const {state}=fixture((path,options)=>options?.method==='POST'?Promise.reject({status:409,payload:{error:'chat_conversation_started',conversationId:'g:B',preserveInput:true}}):undefined);
  await state.open(); await state.select('d:A'); state.setInput('different text'); await state.send();
  assert.equal(state.snapshot().selectedId,'g:B'); assert.equal(state.snapshot().retryRequired,false); assert.equal(state.snapshot().input,'different text'); state.destroy();
});
test('inflight send can settle while closed without being resent on reopen', async () => {
  const wait=pending(); const {state,calls}=fixture((path,options)=>options?.method==='POST'?wait.promise:undefined);
  await state.open(); await state.select('g:A'); state.setInput('text'); const send=state.send(); state.close();
  wait.resolve({stored:true,conversationId:'g:A',deliveryState:'pending'}); await send;
  assert.equal(state.snapshot().sending,false); assert.equal(state.snapshot().input,'');
  assert.equal(calls.filter(x=>x.options?.method==='POST').length,1); state.destroy();
});
test('status refresh updates rows while retaining all history', async () => {
  const {state,calls}=fixture(path=>path.includes('/messages?')?{items:[{id:1,status:'pending',direction:'in',content:'retained',timestamp:'2026-01-01'}],afterCursor:'after'}:path.includes('/status?')?{items:[{id:1,status:'failed',direction:'in',delivery_action:'delivered'}]}:undefined);
  await state.open(); await state.select('g:A'); await state.refreshStatus();
  assert.match(calls.at(-1).path,/\/status\?/); assert.equal(state.snapshot().messages.length,1); assert.equal(state.snapshot().messages[0].content,'retained'); assert.equal(state.snapshot().messages[0].timestamp,'2026-01-01'); assert.equal(messageState(state.snapshot().messages[0]),'failed'); state.destroy();
});
for (const status of [200, 502]) test(`invalid JSON response ${status} leaves send pending reconciliation`, async () => {
  const {state,calls}=fixture((path,options)=>options?.method==='POST'?Promise.reject({status,code:'chat_invalid_response'}):undefined);
  await state.open(); await state.select('g:A'); state.setInput('text'); await state.send();
  assert.equal(state.snapshot().retryRequired,true); assert.equal(state.snapshot().canRetry,false); assert.equal(state.snapshot().input,'text');
  await state.send(); await state.send({retry:true}); assert.equal(calls.filter(x=>x.options?.method==='POST').length,1); state.destroy();
});
test('authoritative retry disallow prevents sending while reconciliation is pending', async () => {
  const {state,calls}=fixture((path,options)=>options?.method==='POST'?{stored:null,needsReconciliation:true,retryAllowed:false,preserveInput:true}:undefined);
  await state.open(); await state.select('g:A'); state.setInput('text'); await state.send();
  assert.equal(state.snapshot().canRetry,false); await state.send({retry:true}); assert.equal(calls.filter(x=>x.options?.method==='POST').length,1); state.destroy();
});
test('successful HTTP response without receipt is an unknown send', async () => {
  const {state}=fixture((path,options)=>options?.method==='POST'?{}:undefined);
  await state.open(); await state.select('g:A'); state.setInput('text'); await state.send();
  assert.equal(state.snapshot().retryRequired,true); assert.equal(state.snapshot().receipt.stored,null); state.destroy();
});
test('stored receipt with uncertain delivery never restores text or permits retry', async () => {
  const {state}=fixture(path=>!path.includes('?')&&path.includes('/conversations/')?{conversation:{id:'g:A',state:'active',pendingContent:'already stored'},conversationId:'g:A',stored:true,needsReconciliation:true,retryAllowed:false}:undefined);
  await state.open(); await state.select('g:A'); assert.equal(state.snapshot().retryRequired,false); assert.equal(state.snapshot().input,''); assert.equal(state.snapshot().canRetry,false); state.destroy();
});
test('missing mode envelope remains unknown with readable failure', async () => {
  const {state}=fixture(path=>path==='/api/session-mode'?{}:undefined);
  await state.open(); assert.equal(state.snapshot().mode,null); assert.equal(state.snapshot().error,'chat_mode_unavailable'); assert.equal(state.snapshot().canCreate,false); state.destroy();
});
test('hidden state cannot write or initiate history queries', async () => {
  const {state,calls}=fixture(); await state.open(); await state.select('g:A'); state.setInput('text'); state.close();
  const count=calls.length; assert.equal(state.snapshot().canWrite,false); assert.equal(state.snapshot().canCreate,false);
  await state.send(); await state.refreshMessages(); await state.refreshStatus(); assert.equal(calls.length,count); state.destroy();
});
test('pending draft creation does not hijack a later navigation', async () => {
  const wait=pending(); const {state}=fixture((path,options)=>path==='/api/chat/drafts'?wait.promise:undefined);
  await state.open(); const created=state.createDraft('name'); await state.setTab('external'); await state.select('g:B');
  wait.resolve({conversation:{id:'d:new'}}); await created;
  assert.equal(state.snapshot().tab,'external'); assert.equal(state.snapshot().selectedId,'g:B'); state.destroy();
});
test('send postprocessing cannot request old conversation on another instance', async () => {
  const wait=pending(); let identity='local', sent=false; const calls=[];
  const state=createChatState({identity:()=>identity,request:async(path,options)=>{
    calls.push({path,identity});
    if(path==='/api/session-mode')return {data:{sessionMode:'multi'}};
    if(path.includes('conversations?'))return {items:[],nextCursor:null};
    if(options?.method==='POST'){sent=true;return {stored:true,conversationId:'g:A'};}
    if(path.includes('/messages?'))return {items:[],afterCursor:'after'};
    if(sent&&identity==='local')return wait.promise;
    return {stored:false,conversationId:'g:A',conversation:{id:'g:A'}};
  }});
  await state.open(); await state.select('g:A'); state.setInput('text'); const send=state.send();
  await Promise.resolve(); state.close(); identity='remote'; await state.open(); const count=calls.length;
  wait.resolve({stored:true,conversation:{id:'g:A'}}); await send;
  assert.equal(calls.length,count); state.destroy();
});
test('unregistered mine history remains readable without write eligibility', async () => {
  const {state}=fixture(path=>!path.includes('?')&&path.includes('/conversations/')?Promise.reject({status:404,code:'chat_conversation_not_found'}):path.includes('/messages?')?{items:[{id:1,content:'history'}]}:undefined);
  await state.open(); await state.select('g:A'); assert.equal(state.snapshot().messages[0].content,'history'); assert.equal(state.snapshot().canWrite,false); state.destroy();
});
test('mine write eligibility waits for registered conversation resolution', async () => {
  const wait=pending(); const {state}=fixture(path=>!path.includes('?')&&path.includes('/conversations/')?wait.promise:undefined);
  await state.open(); const selected=state.select('g:A'); assert.equal(state.snapshot().canWrite,false);
  wait.resolve({conversation:{id:'g:A',state:'active'},conversationId:'g:A',stored:false}); await selected;
  assert.equal(state.snapshot().canWrite,true); state.destroy();
});

test('history pages have independent older and incremental cursors and stable message ids', async () => {
  const paths = [];
  const { state } = fixture(path => {
    if (!path.includes('/messages?')) return;
    paths.push(path);
    const q = new URL(path, 'http://fixture').searchParams;
    if (q.get('direction') === 'after') return { items: [{ id: 3, content: 'new' }], nextCursor: null, afterCursor: 'newest' };
    if (q.get('cursor') === 'older') return { items: [{ id: 1, content: 'old' }, { id: 2, content: 'latest' }], nextCursor: null, afterCursor: 'ignored-before' };
    return { items: [{ id: 2, content: 'latest' }], nextCursor: 'older', afterCursor: 'latest' };
  });
  await state.open(); await state.select('g:A'); await state.loadOlder();
  assert.equal(state.snapshot().messageCursor, null); assert.equal(state.snapshot().afterCursor, 'latest');
  const count = paths.length; await state.loadOlder(); assert.equal(paths.length, count);
  await state.refreshMessages(); assert.match(paths.at(-1), /direction=after&cursor=latest/);
  assert.equal(state.snapshot().messages.length, 3); assert.equal(state.snapshot().messages[0].id, 1);
  assert.equal(state.snapshot().afterCursor, 'newest'); state.destroy();
});
test('empty list ends pagination and network failure remains visible', async () => {
  let fail = false;
  const {state,calls} = fixture(path => path.includes('conversations?') ? fail ? Promise.reject(Error('offline')) : {items:[],nextCursor:null} : undefined);
  await state.open(); assert.equal(state.snapshot().items.length,0); const count=calls.length;
  await state.loadMore(); assert.equal(calls.length,count); fail=true; await state.refresh();
  assert.equal(state.snapshot().error,'offline'); assert.equal(state.snapshot().loading,false); state.destroy();
});
test('unnamed draft creation and rename use only explicit user names', async () => {
  const {state,calls}=fixture((path,options)=>path==='/api/chat/drafts'?{conversation:{id:'d:new',displayName:null,state:'draft'}}:options?.method==='PATCH'?{conversation:{id:'d:new',displayName:options.body.displayName,state:'draft'}}:undefined);
  await state.open(); await state.createDraft();
  assert.equal(state.snapshot().selectedId,'d:new');
  const create=calls.find(row=>row.path==='/api/chat/drafts'); assert.equal(Object.keys(create.options.body).length,0);
  await state.rename('Human name'); assert.equal(state.snapshot().conversation.displayName,'Human name');
  assert.equal(calls.filter(row=>row.options?.method==='POST').length,1); state.destroy();
});
test('definite storage refusal retains text and never triggers automatic resend', async () => {
  const {state,calls}=fixture((path,options)=>options?.method==='POST'?{stored:false,deliveryState:null,preserveInput:true,retryAllowed:true,error:'DB_BUSY'}:undefined);
  await state.open(); await state.select('g:A'); state.setInput('retain this'); await state.send();
  assert.equal(state.snapshot().input,'retain this'); assert.equal(receiptState(state.snapshot().receipt),'not_stored');
  assert.equal(state.snapshot().error,'DB_BUSY'); assert.equal(calls.filter(row=>row.options?.method==='POST').length,1); state.destroy();
});
test('reopened same instance receives completion of its pending send', async () => {
  const wait=pending(); const {state}=fixture((path,options)=>options?.method==='POST'?wait.promise:undefined);
  const snapshots=[]; state.subscribe(value=>snapshots.push(value));
  await state.open(); await state.select('g:A'); state.setInput('text'); const send=state.send(); state.close(); await state.open();
  wait.resolve({stored:true,conversationId:'g:A',deliveryState:'pending'}); await send;
  assert.equal(snapshots.at(-1).sending,false); assert.equal(snapshots.at(-1).receipt.stored,true); state.destroy();
});
test('untouched draft has no send status and stored delivery uncertainty differs from unknown storage', () => {
  assert.equal(receiptState({stored:false,deliveryState:null,retryAllowed:true,preserveInput:false}),null);
  assert.equal(receiptState({stored:true,deliveryState:'pending_reconciliation',retryAllowed:false}),'stored_pending_reconciliation');
  assert.equal(receiptState({stored:null,deliveryState:'pending_reconciliation',retryAllowed:true}),'pending_reconciliation');
});
for (const stored of [false,null]) test(`reopening ${stored === false ? 'not stored' : 'unknown subsequent send'} restores persisted input and error`,async()=>{
  const {state}=fixture(path=>!path.includes('?')&&path.includes('/conversations/')?{stored,deliveryState:stored===null?'pending_reconciliation':null,preserveInput:true,retryAllowed:true,error:'DB_BUSY',conversationId:'g:A',conversation:{id:'g:A',state:'active',pendingContent:'persisted text'}}:undefined);
  await state.open(); await state.select('g:A'); assert.equal(state.snapshot().input,'persisted text'); assert.equal(state.snapshot().error,'DB_BUSY');
  assert.equal(state.snapshot().retryRequired,stored===null); state.destroy();
});
test('unset session mode uses effective single with no write entry',async()=>{
  const {state}=fixture(path=>path==='/api/session-mode'?{data:{sessionMode:null}}:undefined);
  await state.open(); await state.select('g:A'); assert.equal(state.snapshot().mode,'single'); assert.equal(state.snapshot().canWrite,false); assert.equal(state.snapshot().canCreate,false); state.destroy();
});
test('remote disable discards saved cells even after access is restored',async()=>{
  let disabled=false; const {state}=fixture(path=>path.includes('conversations?')?(disabled?Promise.reject({code:'remote_chat_disabled'}):{items:[{id:'g:A',display_name:'Private A'},{id:'g:B',display_name:'Private B'}],nextCursor:null}):undefined);
  await state.open(); await state.select('g:A'); state.setInput('private saved text'); assert.equal(state.snapshot().items.length,2); disabled=true; await state.refresh();
  assert.equal(state.snapshot().items.length,0); assert.equal(state.snapshot().conversation,null); assert.equal(state.snapshot().receipt,null); assert.equal(state.snapshot().input,'');
  disabled=false; await state.refresh(); await state.select('g:A'); assert.equal(state.snapshot().input,''); state.destroy();
});
test('canonical conflict clears old draft receipt and loads canonical history without sending again',async()=>{
  const {state,calls}=fixture((path,options)=>options?.method==='POST'?Promise.reject({status:409,payload:{error:'chat_conversation_started',conversationId:'g:B',preserveInput:true}}):path.includes('/messages?')?{items:[{id:9,content:'canonical history'}]}:undefined);
  await state.open(); await state.select('d:A'); state.setInput('next text'); await state.send();
  assert.equal(state.snapshot().selectedId,'g:B'); assert.equal(state.snapshot().receipt,null); assert.equal(state.snapshot().input,'next text'); assert.equal(state.snapshot().messages[0].content,'canonical history');
  assert.equal(calls.filter(row=>row.options?.method==='POST').length,1); state.destroy();
});
