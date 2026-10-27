import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

test('finalizer with changed global Codex configuration emits one JSON result',t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'finalizer-json-'));
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const root=path.join(home,'zylos'),download=path.join(home,'download');
  const write=(file,bytes)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);};
  write(path.join(root,'.zylos/config.json'),'{"runtime":"codex"}');
  write(path.join(home,'.codex/config.toml'),'user_setting = "retained"\n');
  fs.mkdirSync(download);
  const moduleUrl=new URL('../self-upgrade.js',import.meta.url).href;
  const script=`
    import {runSelfUpgradeFinalize} from ${JSON.stringify(moduleUrl)};
    const root=process.env.ZYLOS_DIR;
    const result=await runSelfUpgradeFinalize({schemaVersion:1,tempDir:${JSON.stringify(download)},from:'old',to:'new'}, {
      zylosDir:root,budget:{check(){},remaining:()=>60000,deadlineAt:Date.now()+60000},
      syncSkills:()=>({step:5,status:'done'}),installDependencies:()=>({step:6,status:'done'}),
      prepareRuntimeClis:()=>{},migrateDatabases:()=>{},
      prepareRuntime:()=>({runtime:'codex',homeDir:process.env.HOME,replacements:[],warnings:[]}),
      ensureMemoryMigration:()=>{},startServices:()=>({status:'done'}),verifyServices:()=>({status:'done'}),
      readMode:()=>({mode:'single',keyPresent:true}),readTransition:()=>null,audit:()=>[],
      restart:()=>({ok:true,data:{result:'exit_enqueued'}}),
      dashboardOwner:{applyDashboardRegistration:()=>({state:'done'}),applyDashboardRoute:()=>({state:'done'}),verifyDashboard:()=>({state:'ready',errors:[]})}
    });
    console.log(JSON.stringify(result));
  `;
  const child=spawnSync(process.execPath,['--input-type=module','-e',script],{
    env:{...process.env,HOME:home,ZYLOS_DIR:root},encoding:'utf8',timeout:30000,
  });
  assert.equal(child.status,0,child.stderr);
  const result=JSON.parse(child.stdout);
  assert.equal(result.success,true,JSON.stringify(result));
  assert.equal(result.publication.ok,true);
  const global=fs.readFileSync(path.join(home,'.codex/config.toml'),'utf8');
  assert.match(global,/user_setting = "retained"/);
  assert.notEqual(global,'user_setting = "retained"\n');
});
