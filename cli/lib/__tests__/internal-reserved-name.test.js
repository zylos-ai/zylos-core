import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const repository=fileURLToPath(new URL('../../../',import.meta.url));
const add=new URL('../../commands/add.js',import.meta.url).href;
const loader=fileURLToPath(new URL('./fixtures/internal-reserved-loader.js',import.meta.url));
function setup(t,name){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'reserved-component-')),source=path.join(root,'source');
  fs.mkdirSync(source);fs.writeFileSync(path.join(source,'SKILL.md'),`---\nname: ${name}\nversion: 1.0.0\n---\nFixture only.\n`);
  const archive=path.join(root,'fixture.tgz');execFileSync('tar',['czf',archive,'-C',source,'.']);
  const zylos=path.join(root,'zylos');fs.mkdirSync(path.join(zylos,'.zylos'),{recursive:true});
  fs.writeFileSync(path.join(zylos,'.zylos/registry.json'),JSON.stringify({components:{[name]:{repo:`fixture/zylos-${name}`}}}));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return {root,source,archive,zylos};
}
function run(f,args){
  return spawnSync(process.execPath,['--no-warnings','--experimental-loader',loader,'--input-type=module','-e',
    `const {addComponent}=await import(${JSON.stringify(add)});await addComponent(JSON.parse(process.argv[1]));`,JSON.stringify(args)],{
    env:{...process.env,HOME:f.root,ZYLOS_DIR:f.zylos},encoding:'utf8',timeout:15000,
  });
}
function target(f,name,kind){
  if(kind==='registry')return [name];if(kind==='github')return [`fixture/zylos-${name}@1.0.0`];
  if(kind==='local')return [f.source];return [name,'--file',f.archive,'--trust-file'];
}
for(const kind of ['registry','github','local','file'])test(`reserved names reject real ${kind} resolution before installation`,t=>{
  for(const name of ['internal','void']){
    const f=setup(t,name),result=run(f,[...target(f,name,kind),'--json','--yes']);
    assert.equal(result.status,1,result.stderr);const output=JSON.parse(result.stdout);
    assert.equal(output.error,'reserved_name');assert.match(output.message,new RegExp(name));
    assert.equal(fs.existsSync(path.join(f.zylos,'.claude/skills',name)),false);
    assert.equal(fs.existsSync(path.join(f.zylos,'.zylos/components.json')),false);
  }
  const f=setup(t,'ordinary'),result=run(f,[...target(f,'ordinary',kind),'--json','--check']);
  assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).success,true);
});

test('thread recognition stays in both system templates and sending rules remain in skill',()=>{
  for(const name of ['claude','codex']){
    const source=fs.readFileSync(path.join(repository,`templates/${name}-system.md`),'utf8');
    for(const text of ['[internal] <session group> said:','not from a user','never by messaging your own users','not an order',"that person's",'explicitly bridged'])assert.ok(source.includes(text),`${name}: ${text}`);
  }
  const skill=fs.readFileSync(path.join(repository,'skills/comm-bridge/SKILL.md'),'utf8');
  for(const text of ['c4-db.js groups --match','c4-send.js internal','body is stdin only','could not contact the target','no `--session-group`','queued, not read','no broadcast','control queue',"other thread's files"])
    assert.ok(skill.includes(text),text);
});
