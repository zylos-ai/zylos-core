import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

for(const warnings of [false,true]) test(`downloaded upgrade entry emits runtime warning text only when returned (warnings=${warnings})`,t=>{
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
      warnings:${warnings ? "[{runtime:'codex',code:'RUNTIME_CLI_UNAVAILABLE',message:'optional CLI unavailable'}]" : '[]'}})}});
    process.argv[1]=${JSON.stringify(path.join(target,'cli/lib/upgrade-entry.js'))};
    await import(${JSON.stringify(url('upgrade-entry.js'))});
  `);
  const input={schemaVersion:1,fromVersion:'0.9.3',tempDir:target,installedRoot:installed,zylosDir:deployment};
  const child=spawnSync(process.execPath,['--experimental-test-module-mocks',launcher],{
    input:JSON.stringify(input),encoding:'utf8',timeout:15000,
  });
  assert.equal(child.status,0,child.stderr+child.stdout);
  assert.equal(JSON.parse(child.stdout).success,true);
  if(warnings) assert.match(child.stderr,/^Runtime warning \(codex\): RUNTIME_CLI_UNAVAILABLE: optional CLI unavailable$/m);
  else assert.doesNotMatch(child.stderr,/Runtime warning/);
});
