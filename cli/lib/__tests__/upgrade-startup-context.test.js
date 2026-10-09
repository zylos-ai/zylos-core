import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {applyUpgradePrompt,shellArgument} from '../runtime/upgrade-context.js';
test('Codex recovery replaces the sole positional startup prompt and shell quoting preserves hostile text',()=>{
 const prompt="recovery $(false) `false` 'quotes'\nnext line";
 const args=applyUpgradePrompt(['--no-daemon','old startup prompt'],prompt,1);
 assert.deepEqual(args,['--no-daemon',prompt]);
 const result=spawnSync('/bin/sh',['-c','printf %s '+shellArgument(prompt)],{encoding:'utf8'});
 assert.equal(result.status,0);assert.equal(result.stdout,prompt);
 assert.throws(()=>applyUpgradePrompt(['--no-daemon'],prompt,1),/prompt index/);
});
test('partial skill deployment does not import diagnostics, formatting, registry, or C4 before file recovery',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'upgrade-startup-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const stable=path.join(root,'.zylos/upgrade'),hook=path.join(root,'hook/c4-session-init.js');fs.mkdirSync(stable,{recursive:true});fs.mkdirSync(path.dirname(hook));
 fs.writeFileSync(path.join(root,'package.json'),'{"type":"module"}');
 fs.copyFileSync(path.resolve('skills/comm-bridge/scripts/c4-session-init.js'),hook);
 for(const [source,target] of [['upgrade-bootstrap.cjs','bootstrap.cjs'],['upgrade-maintenance.cjs','maintenance.cjs'],['upgrade-runtime-args.cjs','runtime-args.cjs']])fs.copyFileSync(path.resolve('cli/lib',source),path.join(stable,target));
 const dir=path.join(root,'.backup/self-upgrade/tx');fs.mkdirSync(dir,{recursive:true,mode:0o700});fs.writeFileSync(path.join(dir,'journal.json'),'{broken',{mode:0o600});
 const result=spawnSync(process.execPath,[hook],{encoding:'utf8',env:{HOME:root,ZYLOS_DIR:root,PATH:process.env.PATH}});
 assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/UPGRADE RECOVERY TASK/);assert.match(result.stdout,/SYSTEM RECOVERY TASK/);assert.match(result.stdout,/diagnostics/);
});
