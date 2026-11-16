import assert from 'node:assert/strict';
import path from 'node:path';
import { CoreState } from '../../src/lib/core-state.js';
import { EventLoopMonitor } from '../../src/lib/event-loop-monitor.js';
import { Store } from '../../src/lib/store.js';
import { C4Reader } from '../../src/lib/c4-reader.js';

// HTTP timezone and remote-access tests own only their route/config boundary.
// Runtime/C4 observations are inert; no CLI, tmux, PM2 or live database is read.
export function isolateInstanceObservations(t, root) {
  assert.ok(root.startsWith(process.env.TMPDIR + path.sep));
  console.log('Object HTTP isolation:', JSON.stringify({HOME:process.env.HOME,ZYLOS_DIR:root,
    PM2_HOME:process.env.PM2_HOME,TMPDIR:process.env.TMPDIR,db:path.join(root,'components/dashboard/dashboard.db'),tmux:'not used',CLI:'inert observations'}));
  t.mock.method(CoreState.prototype,'refresh',async function(){return this.getState();});
  t.mock.method(EventLoopMonitor.prototype,'start',function(){return this;});
  const intervals=[],stores=new Set(),readers=new Set();
  const interval=globalThis.setInterval,check=Store.prototype.checkSchema,open=C4Reader.prototype.open;
  t.mock.method(globalThis,'setInterval',(...args)=>{const timer=interval(...args);intervals.push(timer);return timer;});
  t.mock.method(Store.prototype,'checkSchema',function(...args){stores.add(this);return check.apply(this,args);});
  if(open)t.mock.method(C4Reader.prototype,'open',function(...args){readers.add(this);return open.apply(this,args);});
  const snapshot={rows:[],mode:'single',view:'single',readAt:Date.now(),listKnown:true,instance:{},sources:{}};
  t.mock.module('../../src/lib/workbench/group-snapshot.js',{namedExports:{
    createGroupSnapshot:()=>({getSnapshot:async()=>snapshot,getCachedSnapshot:()=>snapshot,
      channelRestartCounter:{update(){}},hotTtlMs:()=>1800000}),
  }});
  t.after(()=>{for(const timer of intervals)clearInterval(timer);for(const reader of readers)reader.close();for(const store of stores)if(store.db.open)store.close();});
}
