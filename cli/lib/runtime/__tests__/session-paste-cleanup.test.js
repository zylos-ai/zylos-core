import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fixture, actualDependencies, until} from './stop-tmux-fixture.js';

async function targetFixture(t) {
  const f=await fixture(t);
  f.command('new-session','-d','-s','target','-e','ZYLOS_RUN_ID=paste-cleanup','cat');
  const connection=await actualDependencies.openTmuxConnection(f.adapter.options.tmux);
  f.cleanup.push(()=>connection.close());
  const target=await actualDependencies.observeSessionTarget({tmuxName:'target',connection,readReady:async()=>null,readProcessTree:async()=>[]});
  return {...f,connection,target};
}

for(const mode of ['pane-disappears','executor-times-out'])test(`real paste ${mode}: unique message buffer is removed`,async t=>{
  const f=await targetFixture(t),batch=f.connection.commandBatch.bind(f.connection);
  let buffer,privateFile,cleanupChecked=false;
  const cleanup=f.connection.cleanupBuffer.bind(f.connection);
  f.connection.cleanupBuffer=async name=>{
    assert.equal(name,buffer);
    assert.equal(f.command('show-buffer','-b',name),'private-message-body');
    cleanupChecked=true;
    return cleanup(name);
  };
  f.connection.commandBatch=async(commands,options)=>{
    if(commands[0][0]!=='load-buffer')return batch(commands,options);
    buffer=commands[0][2];privateFile=commands[0][3];
    // Keep load and the injected failure in the same guarded server command list.
    if(mode==='pane-disappears')return batch([commands[0],['kill-pane','-t',f.target.paneId],commands[1]],options);
    return batch([commands[0],['wait-for','p02-never-signalled']],{timeoutMs:100});
  };
  await assert.rejects(f.adapter.sendText({target:f.target,connection:f.connection,text:'private-message-body'}),{code:'PASTE_FAILED',...(mode==='executor-times-out'?{cause:'timeout'}:{})});
  assert.match(buffer,/^zylos-/);
  assert.equal(cleanupChecked,true,'Failure left a real buffer that cleanup removed');
  if(mode==='executor-times-out')assert.equal(f.connection.closed,false);
  assert.equal(f.command('list-buffers','-F','#{buffer_name}').split('\n').includes(buffer),false);
  await assert.rejects(fs.stat(privateFile),{code:'ENOENT'});
  assert.equal(f.snapshot('origin'),f.origin);
});

for (const folder of ['literal-#{pid}', 'literal-$HOME', "literal-a$b-quote'-#{pid}"]) test(`real paste loads literal TMPDIR ${folder}`,async t=>{
  const f=await targetFixture(t),previous=process.env.TMPDIR;
  // A harmless format expression would expand to the server PID without escaping.
  const temp=path.join(f.dir,folder);await fs.mkdir(temp);
  process.env.TMPDIR=temp;
  try {
    assert.equal(os.tmpdir(),temp);
    await f.adapter.sendText({target:f.target,connection:f.connection,text:'literal-hash-path'});
    await until(()=>f.command('capture-pane','-p','-t',f.target.paneId),value=>value.includes('literal-hash-path'));
    assert.deepEqual(await fs.readdir(temp),[]);
    assert.equal(f.command('list-buffers','-F','#{buffer_name}'),'');
  } finally {
    if(previous===undefined)delete process.env.TMPDIR;else process.env.TMPDIR=previous;
  }
});
