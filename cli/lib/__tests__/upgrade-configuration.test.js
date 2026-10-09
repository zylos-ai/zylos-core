import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {recoveryConfiguration} from '../../commands/recovery.js';
import {deployUpgradeBootstrap,maintenance} from '../upgrade-protection.js';
import {verifyUpgradeBootCapability} from '../upgrade-boot-capability.js';
test('generated user unit and capability satisfy boot gate with persisted native auth and no transient keys',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'upgrade-config-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const command=path.join(root,'codex');fs.writeFileSync(command,"#!/bin/sh\n[ -z \"$OPENAI_API_KEY\" ] || exit 2\nprintf 'Logged in using fixture-native-auth\\n'\n",{mode:0o700});
 const config=recoveryConfiguration({root,home:root,runtime:'codex',command});
 assert.equal(fs.existsSync(config.unitPath),false);assert.equal(fs.existsSync(config.capabilityPath),false);
 const bootstrapPath=deployUpgradeBootstrap(root);maintenance.durable(config.capabilityPath,config.capability);
 fs.mkdirSync(path.dirname(config.unitPath),{recursive:true});fs.writeFileSync(config.unitPath,config.unit,{mode:0o600});
 const result=verifyUpgradeBootCapability({zylosDir:root,nodePath:process.execPath,bootstrapPath},{home:root,unitDirectories:[path.dirname(config.unitPath)],spawnSync:(program,args,options)=>{
  if(program==='systemctl')return {status:0,stdout:args.includes('is-enabled')?'enabled\n':`LoadState=loaded\nFragmentPath=${config.unitPath}\nDropInPaths=\n`};
  if(program==='loginctl')return {status:0,stdout:'yes\n'};
  return spawnSync(program,args,options);
 }});
 assert.equal(result.authenticated,true);assert.equal(result.verified,true);
 const dir=path.join(root,'.backup/self-upgrade/tx');fs.mkdirSync(dir,{recursive:true,mode:0o700});fs.writeFileSync(path.join(dir,'journal.json'),'bad',{mode:0o600});
 assert.throws(()=>deployUpgradeBootstrap(root),/unresolved upgrade/);
});
