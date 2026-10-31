import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {guardDatabase} from '../../../skills/comm-bridge/scripts/sqlite-schema.js';
import * as c4Schema from '../../../skills/comm-bridge/scripts/c4-schema.js';

for(const mode of ['none','runtime','incomplete-audit']) test(`downloaded upgrade entry emits only returned terminal diagnostics (${mode})`,t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'upgrade-entry-warnings-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const target=path.join(root,'target'),prefix=path.join(root,'npm-prefix'),installed=path.join(prefix,'lib/node_modules/zylos'),deployment=path.join(root,'deployment');
  for(const directory of [target,installed,deployment,path.join(prefix,'bin')])fs.mkdirSync(directory,{recursive:true});
  for(const [directory,version] of [[target,'0.9.4'],[installed,'0.9.3']]) {
    fs.writeFileSync(path.join(directory,'package.json'),JSON.stringify({type:'module',name:'zylos',version}));
  }
  fs.cpSync(path.resolve('cli/lib'),path.join(target,'cli/lib'),{recursive:true,
    filter:file=>!file.split(path.sep).includes('__tests__')});
  fs.mkdirSync(path.join(target,'skills/comm-bridge/scripts'),{recursive:true});
  fs.copyFileSync(path.resolve('skills/comm-bridge/scripts/upgrade-admission.js'),
    path.join(target,'skills/comm-bridge/scripts/upgrade-admission.js'));
  fs.mkdirSync(path.join(installed,'cli/lib'),{recursive:true});
  fs.copyFileSync(path.resolve('cli/lib/self-upgrade.js'),path.join(installed,'cli/lib/self-upgrade.js'));
  const url=name=>pathToFileURL(path.join(target,'cli/lib',name)).href;
  const original=name=>pathToFileURL(path.resolve('cli/lib',name)).href;
  const launcher=path.join(root,'launcher.mjs');
  fs.writeFileSync(launcher,`
    import {mock} from 'node:test';
    import fs from 'node:fs';
    const protection=await import(${JSON.stringify(original('upgrade-protection.js'))});
    const databases=await import(${JSON.stringify(original('core-db-backup.js'))});
    const packages=await import(${JSON.stringify(original('upgrade-package.js'))});
    const m={discover:()=>({candidates:[],diagnostics:[],marker:null}),validateSupportedGlobalLayout:protection.maintenance.validateSupportedGlobalLayout,runInstaller(_dir,_journal,options){
      if(options.stage==='pack-target')return JSON.stringify([{filename:'target.tgz'}]);
      fs.writeFileSync(${JSON.stringify(path.join(installed,'package.json'))},JSON.stringify({name:'zylos',version:'0.9.4'}));
    }};
    mock.module(${JSON.stringify(url('upgrade-protection.js'))},{namedExports:{...protection,maintenance:m,
      maintenanceFor:()=>m,beginUpgrade(ctx){ctx.transactionDir=${JSON.stringify(path.join(root,'transaction'))};},
      saveProtectedCode(){},prepareProtectedInstall(){},markInstallationIntent(){}}});
    mock.module(${JSON.stringify(url('core-db-backup.js'))},{namedExports:{...databases,
      assertDashboardUninstalled(){},inspectFirstDashboardTakeover:()=>false,inspectDashboardOwnerManaged:()=>false,
      probeCoreDbVersions:()=>({databases:[{},{},{}],needsMigration:false}),preflightCoreDbUpgrade(){}}});
    mock.module(${JSON.stringify(url('upgrade-package.js'))},{namedExports:{...packages,saveOriginalPackage(){}}});
    mock.module(${JSON.stringify(pathToFileURL(path.join(installed,'cli/lib/self-upgrade.js')).href)},{namedExports:{runSelfUpgradeFinalize:()=>({success:true,
      warnings:${mode === 'runtime' ? "[{runtime:'codex',code:'RUNTIME_CLI_UNAVAILABLE',message:'optional CLI unavailable'}]" : '[]'},
      checkpointAudit:${mode === 'incomplete-audit' ? "{state:'incomplete',error:'DB_BUSY'}" : "{state:'complete',items:[]}"}})}});
    process.argv[1]=${JSON.stringify(path.join(target,'cli/lib/upgrade-entry.js'))};
    await import(${JSON.stringify(url('upgrade-entry.js'))});
  `);
  const input={schemaVersion:1,fromVersion:'0.9.3',tempDir:target,installedRoot:installed,zylosDir:deployment};
  const child=spawnSync(process.execPath,['--experimental-test-module-mocks',launcher],{
    input:JSON.stringify(input),encoding:'utf8',timeout:15000,
  });
  assert.equal(child.status,0,child.stderr+child.stdout);
  assert.equal(JSON.parse(child.stdout).success,true);
  if(mode === 'runtime') assert.match(child.stderr,/^Runtime warning \(codex\): RUNTIME_CLI_UNAVAILABLE: optional CLI unavailable$/m);
  else assert.doesNotMatch(child.stderr,/Runtime warning/);
  if(mode === 'incomplete-audit') assert.match(child.stderr,/^Checkpoint audit warning: audit incomplete; checkpoint consistency could not be verified\.$/m);
  else assert.doesNotMatch(child.stderr,/Checkpoint audit warning/);
});

test('downloaded upgrade entry audits a real C4 database and warns for every repair-required checkpoint without changing stdout',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'upgrade-entry-checkpoints-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const target=path.join(root,'target'),prefix=path.join(root,'npm-prefix'),installed=path.join(prefix,'lib/node_modules/zylos'),deployment=path.join(root,'deployment');
  for(const directory of [target,installed,deployment,path.join(prefix,'bin'),path.join(deployment,'comm-bridge')])fs.mkdirSync(directory,{recursive:true});
  for(const [directory,version] of [[target,'0.9.4'],[installed,'0.9.3']])fs.writeFileSync(path.join(directory,'package.json'),JSON.stringify({type:'module',name:'zylos',version}));
  fs.cpSync(path.resolve('cli/lib'),path.join(target,'cli/lib'),{recursive:true,filter:file=>!file.split(path.sep).includes('__tests__')});
  fs.mkdirSync(path.join(target,'skills/comm-bridge/scripts'),{recursive:true});
  fs.copyFileSync(path.resolve('skills/comm-bridge/scripts/upgrade-admission.js'),path.join(target,'skills/comm-bridge/scripts/upgrade-admission.js'));
  fs.mkdirSync(path.join(installed,'cli/lib'),{recursive:true});
  fs.copyFileSync(path.resolve('cli/lib/self-upgrade.js'),path.join(installed,'cli/lib/self-upgrade.js'));
  const require=createRequire(path.resolve('skills/comm-bridge/package.json'));
  const Database=require('better-sqlite3'),database=path.join(deployment,'comm-bridge/c4.db'),db=new Database(database);
  guardDatabase(db,c4Schema);
  db.prepare("INSERT INTO conversations(id,direction,channel,content,status) VALUES(7,'out','fixture','message','delivered')").run();
  db.prepare("INSERT INTO checkpoints(id,summary,end_conversation_id,session_group,no_content) VALUES(100,'over-bound',2000,'*',0)").run();
  db.close();
  const url=name=>pathToFileURL(path.join(target,'cli/lib',name)).href;
  const original=name=>pathToFileURL(path.resolve('cli/lib',name)).href;
  const launcher=path.join(root,'launcher.mjs');
  fs.writeFileSync(launcher,`
    import {mock} from 'node:test';
    import fs from 'node:fs';
    import {createRequire} from 'node:module';
    const protection=await import(${JSON.stringify(original('upgrade-protection.js'))});
    const databases=await import(${JSON.stringify(original('core-db-backup.js'))});
    const packages=await import(${JSON.stringify(original('upgrade-package.js'))});
    const {createStore}=await import(${JSON.stringify(pathToFileURL(path.resolve('skills/comm-bridge/scripts/c4-v2-store.js')).href)});
    const Database=createRequire(${JSON.stringify(path.resolve('skills/comm-bridge/package.json'))})('better-sqlite3');
    const m={discover:()=>({candidates:[],diagnostics:[],marker:null}),validateSupportedGlobalLayout:protection.maintenance.validateSupportedGlobalLayout,runInstaller(_dir,_journal,options){
      if(options.stage==='pack-target')return JSON.stringify([{filename:'target.tgz'}]);
      fs.writeFileSync(${JSON.stringify(path.join(installed,'package.json'))},JSON.stringify({name:'zylos',version:'0.9.4'}));
    }};
    mock.module(${JSON.stringify(url('upgrade-protection.js'))},{namedExports:{...protection,maintenance:m,
      maintenanceFor:()=>m,beginUpgrade(ctx){ctx.transactionDir=${JSON.stringify(path.join(root,'transaction'))};},
      saveProtectedCode(){},prepareProtectedInstall(){},markInstallationIntent(){}}});
    mock.module(${JSON.stringify(url('core-db-backup.js'))},{namedExports:{...databases,
      assertDashboardUninstalled(){},inspectFirstDashboardTakeover:()=>false,inspectDashboardOwnerManaged:()=>false,
      probeCoreDbVersions:()=>({databases:[{},{},{}],needsMigration:false}),preflightCoreDbUpgrade(){}}});
    mock.module(${JSON.stringify(url('upgrade-package.js'))},{namedExports:{...packages,saveOriginalPackage(){}}});
    mock.module(${JSON.stringify(pathToFileURL(path.join(installed,'cli/lib/self-upgrade.js')).href)},{namedExports:{runSelfUpgradeFinalize:()=>{
      const connection=new Database(${JSON.stringify(database)},{readonly:true});
      try{return {success:true,warnings:[],checkpointAudit:{state:'complete',items:createStore(connection).auditCheckpoints()},unchanged:{value:true}};}
      finally{connection.close();}
    }}});
    process.argv[1]=${JSON.stringify(path.join(target,'cli/lib/upgrade-entry.js'))};
    await import(${JSON.stringify(url('upgrade-entry.js'))});
  `);
  const input={schemaVersion:1,fromVersion:'0.9.3',tempDir:target,installedRoot:installed,zylosDir:deployment};
  const child=spawnSync(process.execPath,['--experimental-test-module-mocks',launcher],{input:JSON.stringify(input),encoding:'utf8',timeout:15000});
  assert.equal(child.status,0,child.stderr+child.stdout);
  assert.deepEqual(JSON.parse(child.stdout),{success:true,warnings:[],checkpointAudit:{state:'complete',items:[{
    checkpointId:100,end:2000,maxConversationId:7,affected:{B:2000,coverageAll:2000},repairRequired:true,
  }]},unchanged:{value:true}});
  assert.match(child.stderr,/^Checkpoint warning: checkpoint 100 exceeds the available conversation range and requires repair\.$/m);
});
