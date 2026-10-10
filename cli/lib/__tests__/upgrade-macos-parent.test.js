import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';

const require=createRequire(import.meta.url);
async function fixture(t) {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'upgrade-macos-parent-')));
  let ctx;
  t.after(()=>{try{ctx?.releaseControl?.();}finally{fs.rmSync(root,{recursive:true,force:true});}});
  const pkg=path.join(root,'installed-package'),tempDir=path.join(root,'new-package'),skillsDir=path.join(root,'.claude/skills');
  fs.mkdirSync(pkg);fs.writeFileSync(path.join(pkg,'package.json'),'{"type":"module"}');
  fs.cpSync(path.resolve('cli'),path.join(pkg,'cli'),{recursive:true});
  fs.symlinkSync(path.resolve('node_modules'),path.join(pkg,'node_modules'));
  fs.symlinkSync(path.resolve('skills'),path.join(pkg,'skills'));
  for(const dir of [path.join(tempDir,'skills/core'),path.join(skillsDir,'core')]) fs.mkdirSync(dir,{recursive:true});
  const bin=path.join(root,'bin');fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin,'pm2'),`#!${process.execPath}\nif(process.argv[2]!=='jlist')process.exit(9);console.log('[]');\n`,{mode:0o700});
  const prior=process.env.PATH;process.env.PATH=bin+path.delimiter+prior;t.after(()=>{process.env.PATH=prior;});
  const protection=await import(pathToFileURL(path.join(pkg,'cli/lib/upgrade-protection.js')));
  const {runProtectedInstaller}=await import(pathToFileURL(path.join(pkg,'cli/lib/self-upgrade.js')));
  ctx={coreDir:pkg,tempDir,from:'old',to:'new'};
  protection.beginUpgrade(ctx,{zylosDir:root,skillsDir});
  // This closure must originate in beginUpgrade, not a fixture-installed binding.
  const dir=ctx.transactionDir,m=protection.maintenance;
  const names=['maintenance.cjs','finalizer.cjs','runner.cjs'];
  for(const [source,target] of [['upgrade-maintenance.cjs','maintenance.cjs'],['upgrade-finalizer.cjs','finalizer.cjs']]) {
    fs.copyFileSync(path.join(pkg,'cli/lib',source),path.join(dir,target));fs.chmodSync(path.join(dir,target),0o600);
  }
  fs.writeFileSync(path.join(dir,'runner.cjs'),'// synthetic descriptor; recovery not invoked',{mode:0o600});
  const closure=path.join(dir,'sqlite-runtime');
  for(const name of ['package.json','core-db-backup-worker.js','node_modules/better-sqlite3/lib/index.js']) {
    const file=path.join(closure,name);fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});fs.writeFileSync(file,'fixture',{mode:0o600});
  }
  const descriptor={formatVersion:1,transactionId:ctx.transactionId,nodePath:process.execPath,runnerPath:path.join(dir,'runner.cjs'),workerPath:path.join(closure,'core-db-backup-worker.js'),driverPath:path.join(closure,'node_modules/better-sqlite3/lib/index.js'),driverClosureRoot:closure,hashes:Object.fromEntries(names.map(name=>[name,m.hash(path.join(dir,name))]))};
  m.durable(path.join(dir,'descriptor.json'),descriptor);
  m.update(dir,ctx.journal,{phase:'installing',installationIntent:true});
  const npmCli=path.join(root,'npm-cli.js'),installed=path.join(pkg,'cli/lib/upgrade-maintenance.cjs');
  const read=()=>JSON.parse(fs.readFileSync(path.join(dir,'journal.json'),'utf8'));
  return {root,ctx,dir,m,npmCli,installed,read,run:()=>runProtectedInstaller(ctx,{stage:'install',npmCli,args:[],cwd:root})};
}

test('macOS parent records npm failure and releases controller after installed maintenance replacement',{skip:process.platform!=='darwin'},async t=>{
  const f=await fixture(t),removed=f.installed+'.removed';
  fs.writeFileSync(f.npmCli,`require('node:fs').renameSync(${JSON.stringify(f.installed)},${JSON.stringify(removed)});process.exit(2);`);
  assert.throws(f.run,/npm install exited 2/);
  assert.equal(fs.existsSync(f.installed),false);
  const saved=f.read();assert.ok(saved.installerPid>0);assert.equal(saved.installerExitConfirmed,true);assert.equal(saved.installerExitUnconfirmed,false);
  assert.doesNotThrow(()=>f.ctx.releaseControl());f.ctx.releaseControl=null;
  assert.equal(fs.existsSync(path.join(f.dir,'controller.json')),false);
  assert.equal(f.ctx.maintenance,require(path.join(f.root,'.zylos/upgrade/maintenance.cjs')));
  assert.equal(fs.existsSync(path.join(f.dir,'macos-recovery-helper')),false);
});

for(const name of ['maintenance.cjs','finalizer.cjs','runner.cjs']) for(const fault of ['missing','tampered']) test(`macOS frozen ${name} ${fault} prevents installer execution`,{skip:process.platform!=='darwin'},async t=>{
  const f=await fixture(t),sentinel=path.join(f.root,'installer-ran');
  fs.writeFileSync(f.npmCli,`require('node:fs').writeFileSync(${JSON.stringify(sentinel)},'unexpected');`);
  const material=path.join(f.dir,name),original=fs.readFileSync(material);
  try {
    if(fault==='missing')fs.renameSync(material,material+'.held');
    else fs.appendFileSync(material,'tampered');
    assert.equal(fs.existsSync(f.installed),true,'installed source remains available');
    assert.throws(f.run,fault==='missing'?/ENOENT/:/hash mismatch/);
    assert.equal(fs.existsSync(sentinel),false);
    assert.notEqual(f.read().installerStarted,true);
  } finally {
    if(fault==='missing')fs.renameSync(material+'.held',material);
    else fs.writeFileSync(material,original);
  }
});
