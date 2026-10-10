import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {savePm2ProcessList} from '../pm2-save.js';

function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pm2-save-guard-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  let saves=0;const messages=[];
  return {root,messages,run:()=>savePm2ProcessList({root,save:()=>saves++,log:message=>messages.push(message)}),count:()=>saves};
}

test('ordinary deployment saves despite an unused partial helper and empty shared recovery roots',t=>{
  const f=fixture(t),stable=path.join(f.root,'.zylos/upgrade');
  fs.mkdirSync(stable,{recursive:true,mode:0o775});
  fs.writeFileSync(path.join(stable,'maintenance.cjs'),'throw Error("must not load");');
  fs.mkdirSync(path.join(f.root,'.backup/self-upgrade'),{recursive:true,mode:0o775});
  assert.equal(f.run(),true);assert.equal(f.count(),1);assert.deepEqual(f.messages,[]);
});

test('active marker prevents saving a temporary service list',t=>{
  const f=fixture(t),stable=path.join(f.root,'.zylos/upgrade');
  fs.mkdirSync(stable,{recursive:true,mode:0o700});
  fs.writeFileSync(path.join(stable,'active.json'),JSON.stringify({formatVersion:1,transactionId:'interrupted',transactionDir:path.join(f.root,'.backup/self-upgrade/interrupted')}),{mode:0o600});
  assert.equal(f.run(),false);assert.equal(f.count(),0);
  assert.match(f.messages[0],/Skipped PM2 save.*preserving the saved startup list/);
});

test('lost marker or damaged recovery path also prevents saving',t=>{
  for(const damaged of [false,true]) {
    const f=fixture(t),active=path.join(f.root,'.backup/self-upgrade');
    fs.mkdirSync(path.dirname(active),{recursive:true,mode:0o700});
    if(damaged) fs.symlinkSync(path.join(f.root,'missing'),active);
    else fs.mkdirSync(path.join(active,'interrupted'),{recursive:true,mode:0o700});
    assert.equal(f.run(),false);assert.equal(f.count(),0);assert.equal(f.messages.length,1);
  }
});

test('ordinary PM2 save failures still propagate',t=>{
  const f=fixture(t);
  assert.throws(()=>savePm2ProcessList({root:f.root,save:()=>{throw Error('PM2 unavailable');}}),/PM2 unavailable/);
});
