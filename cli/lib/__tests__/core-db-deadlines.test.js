import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {superviseDatabases} from '../core-db-backup-worker.js';

function children() {
  const calls=[];
  const spawnWorker=(node,args,options)=>{
    const child=new EventEmitter();
    child.stdout=new PassThrough();
    child.killed=false;
    child.kill=signal=>{child.killed=signal;queueMicrotask(()=>child.emit('close',null));};
    child.finish=(value,status=0)=>{child.stdout.write(JSON.stringify(value));child.emit('close',status);};
    calls.push({child,node,input:JSON.parse(args[1]),options});
    return child;
  };
  return {calls,spawnWorker};
}

for(const step of ['check','copy','rehearsal']) test(`database ${step} deadline kills the active child and names its database and step`,async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const {calls,spawnWorker}=children();
  const pending=superviseDatabases({action:'snapshot'},{spawnWorker});
  const rejected=assert.rejects(pending,new RegExp(`comm-bridge/c4\\.db: ${step} deadline exceeded \\(600s\\)`));
  calls[0].child.emit('message',{step});
  t.mock.timers.tick(600000);
  await rejected;
  assert.equal(calls[0].child.killed,'SIGKILL');
  assert.equal(calls.length,1);
});
