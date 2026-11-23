import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routerFixture } from './helpers/router-fixture.js';

// Integration boundary: real Router and C4 store, injected scene/runtime I/O and
// clock. Run for occupancy admission/release/order changes; skip unrelated UI.
// Official runner supplies private HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR; fixture
// uses a private SQLite file and no tmux, PM2, network or real runtime. The router
// is stopped by t.after and SQLite/temp files belong to the fixture lifecycle.
const launches = f => f.calls.filter(row => row[0] === 'launch');
async function start(f) { f.put('origin', { runtime: 'codex' }); await f.create().initialize(); await f.rounds(3); }

test('running occupancy blocks both its absent owner and a new inbound group until reconciliation',async t=>{
 const f=routerFixture(t,{poolSize:1});f.db.takeSlot('b',{runId:'old-b',k:1});f.add('b');f.add('c');
 await start(f);await f.rounds(4);assert.equal(launches(f).length,0);
 await f.router.stop();await f.create().initialize();await f.rounds(3);assert.equal(launches(f).length,0);
 f.db.recordRunEnd('b',{runId:'old-b',reason:'unexpected'});await f.rounds(6);
 assert.deepEqual(launches(f).map(row=>row[1].sessionGroup),['b']);assert.equal(f.db.listSlotOccupancy().length,1);
});

test('unconfirmed adapter stop retains startup occupancy until stop succeeds',async t=>{
 const f=routerFixture(t,{poolSize:1,readyTimeoutMs:1000});const message=f.add('b');
 f.deps.session = {launch:async input=>{f.put(input.sessionGroup,{runId:input.runId,ready:false});},stop:async()=>{if(f.scene.has('b'))throw Object.assign(new Error('stop unconfirmed'),{code:'STOP_UNCONFIRMED'});}};
 await start(f);f.advance(1000);await f.rounds(2);assert.equal(f.db.listSlotOccupancy()[0].state,'running');
 assert.equal(f.row(message.id).status,'running');assert.equal(f.row(message.id).retry_count,0);
 assert.ok(f.events.some(row=>row.event==='stop_unconfirmed'&&row.reason==='STOP_UNCONFIRMED'));
 assert.ok(f.calls.some(row=>row[0]==='alert'&&row[1]==='stop_unconfirmed'));
 f.scene.delete('b');f.db.claimConversation=()=>false;await f.rounds(3);assert.equal(f.db.listSlotOccupancy().length,0);
});
