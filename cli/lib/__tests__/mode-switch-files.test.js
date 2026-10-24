import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const p=await import('../mode-switch-files.js');
const record={runId:'12345678-1234-1234-1234-123456789abc',cutoff:42,source:'single',target:'multi'};
test('W4 fixed first line roundtrip; free body retained; all malformed fields fail closed',()=>{
 const line=p.formatModeSwitchHeader(record);
 const reverse={...record,cutoff:0,source:'multi',target:'single'};
 assert.deepEqual(p.parseModeSwitchHeader(p.formatModeSwitchHeader(reverse)),reverse);
 assert.equal(line,'<!-- zylos-mode-switch v1 | run=12345678-1234-1234-1234-123456789abc | cutoff=42 | source=single | target=multi -->');
 assert.deepEqual(p.parseModeSwitchHeader(`${line}\nfree body\n${line}`),record);
 assert.equal(p.formatModeSwitchHandoff(record,'中文\n自由格式'),`${line}\n中文\n自由格式`);
 for(const bad of [null,'free text',`\n${line}`,` ${line}`,line.replace('v1','v2'),line.replace('cutoff=42','cutoff=-1'),line.replace('cutoff=42','cutoff=1.5'),line.replace('cutoff=42','cutoff=9007199254740992'),line.replace('cutoff=42','cutoff=042'),line.replace('run=12345678','run=x'),line.replace('source=single','source=multi'),line.replace('target=multi','target=unknown'),line.replace(' | cutoff=42',''),line.replace(' | cutoff=42',' | cutoff=42 | cutoff=42')]) assert.equal(p.parseModeSwitchHeader(bad),null);
 for(const bad of [{...record,cutoff:-1},{...record,cutoff:1.2},{...record,source:'unknown'},{...record,target:'single'}]) assert.throws(()=>p.formatModeSwitchHeader(bad),{code:'MODE_SWITCH_HEADER_INVALID'});
});
test('atomic replacement: fsync before rename, full overwrite, no business markers or moves',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'p02-atomic-')); const target=path.join(root,'handoff.md'); const calls=[];
 const wrapped={...fs}; for(const method of ['openSync','writeFileSync','fsyncSync','renameSync']) wrapped[method]=(...args)=>{calls.push([method,...args]);return fs[method](...args);};
 try {
  fs.writeFileSync(target,'old'); assert.deepEqual(p.writeModeSwitchFile(target,'new\nwhole',{fsImpl:wrapped}),{committed:true});
  assert.equal(fs.readFileSync(target,'utf8'),'new\nwhole');
  assert.ok(calls.findIndex(x=>x[0]==='fsyncSync')<calls.findIndex(x=>x[0]==='renameSync'));
  const rename=calls.find(x=>x[0]==='renameSync'); assert.equal(path.dirname(rename[1]),root); assert.equal(rename[2],target);
  p.writeModeSwitchFile(target,'replayed'); assert.equal(fs.readFileSync(target,'utf8'),'replayed');
  assert.deepEqual(fs.readdirSync(root),['handoff.md']);
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});
test('write faults preserve old file before rename and report unknown at/after rename',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'p02-fault-')); const target=path.join(root,'handoff.md');
 try {
  for(const phase of ['write','sync','rename-before','rename-after','directory-sync']) {
   fs.writeFileSync(target,'old'); let syncs=0;
   const fsImpl={...fs,
    writeFileSync:(...args)=>{if(phase==='write')throw new Error('injected');return fs.writeFileSync(...args);},
    fsyncSync:(...args)=>{syncs++;if(phase==='sync'||(phase==='directory-sync'&&syncs===2))throw new Error('injected');return fs.fsyncSync(...args);},
    renameSync:(...args)=>{if(phase==='rename-before')throw new Error('injected');fs.renameSync(...args);if(phase==='rename-after')throw new Error('injected');}
   };
   assert.throws(()=>p.writeModeSwitchFile(target,'new',{fsImpl}),e=>{
    assert.equal(e.code,'MODE_SWITCH_FILE_WRITE_FAILED');
    assert.equal(e.phase,['write','sync'].includes(phase)?'before_rename':phase==='directory-sync'?'after_rename':'rename');
    assert.deepEqual(e.persisted,['write','sync'].includes(phase)?[]:null);return true;
   });
   assert.equal(fs.readFileSync(target,'utf8'),['rename-after','directory-sync'].includes(phase)?'new':'old');
   assert.deepEqual(fs.readdirSync(root),['handoff.md']);
  }
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});
