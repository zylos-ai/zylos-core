import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

// Run the normal isolated runner against a disposable source mirror. No mutant
// is ever written into the worktree whose tests or implementation are in use.
const sourceRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../../..');
const output=path.resolve(process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(),'upgrade-mutation-evidence-')));
fs.mkdirSync(output,{recursive:true});
const mirror=fs.mkdtempSync(path.join(output,'source-'));
const cutoff='cli/lib/__tests__/upgrade-cutoff.test.js';
const retry='cli/lib/__tests__/upgrade-retry.test.js';
const mutations=[
  ['M08','cli/lib/upgrade-maintenance.cjs',"if (cutoff === 'closed') {",'if (false) {',cutoff,'closed cutoff freezes publication bytes'],
  ['M09','cli/lib/upgrade-maintenance.cjs',"if (cutoff === 'untrusted' && (next.phase !== saved.phase || next.resumePhase !== saved.resumePhase))",'if (false)',cutoff,'untrusted cutoff cannot advance phase'],
  ['M10-inputs','cli/lib/upgrade-maintenance.cjs',"next.postCutoff?.items?.hooks?.state !== 'pending' || ",'',cutoff,'cutoff first write requires atomic postCutoff'],
  ['M10-dashboard','cli/lib/upgrade-maintenance.cjs'," || !Object.prototype.hasOwnProperty.call(next, 'dashboardInstall')",'',cutoff,'cutoff first write requires atomic dashboardInstall'],
  ['M12','cli/lib/upgrade-cutoff.js',"journal.phase !== 'installing' ||",'',cutoff,'commit rejects phase before durable write'],
  ['M13','cli/lib/upgrade-cutoff.js',"m.hash(path.join(journal.dbBackupDir, 'manifest.json')) !== journal.snapshotManifestHash",'false',cutoff,'commit rejects manifest before durable write'],
  ['M14','cli/lib/upgrade-recovery.cjs',"if (cutoff === 'closed' && j.phase !== 'upgrade_complete')",'if (false)',cutoff,'recovery retains current data after cutoff'],
  ['M18','cli/lib/upgrade-recovery.cjs',"sources.some((source,i) => j.initialIdentity.databases[i]?.source !== source) || j.initialIdentity.databases.length !== sources.length",'false',cutoff,'snapshot validates original database identities'],
  ['M30','cli/lib/upgrade-retry.js','maintenance.hash(file) !== journal.snapshotManifestHash || ','',retry,'valid replacement manifest with changed bytes'],
  ['M35','cli/lib/self-upgrade.js','Object.assign(ctx, selected);','Object.assign(ctx, {retryOf:selected.retryOf,effectiveFrom:selected.effectiveFrom});',retry,'real retry admission passes inherited format 1'],
  ['M38','cli/lib/upgrade-protection.js',"if (cutoff === 'untrusted')",'if (false)',cutoff,'parent recovery handles untrusted cutoff'],
  ['M39','cli/lib/upgrade-protection.js',"if (cutoff === 'closed' && saved.phase !== 'upgrade_complete')",'if (false)',cutoff,'parent recovery handles closed cutoff'],
];
const results=[];
function run(name,files) {
  const child=spawnSync(process.execPath,['scripts/run-node-tests.js',...files],{
    cwd:mirror,env:{...process.env},encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024,
  });
  const log=(child.stdout || '')+(child.stderr || '');
  fs.writeFileSync(path.join(output,name+'.log'),log);
  assert.equal(child.error,undefined,`${name}: runner failed: ${child.error}`);
  return {status:child.status,log};
}
try {
  for(const relative of ['cli','scripts','package.json']) fs.cpSync(path.join(sourceRoot,relative),path.join(mirror,relative),{recursive:true});
  for(const relative of ['skills','node_modules']) fs.symlinkSync(path.join(sourceRoot,relative),path.join(mirror,relative));
  const baseline=run('baseline',[cutoff,retry]);
  assert.equal(baseline.status,0,'mutation baseline must pass');
  for(const [id,file,find,replacement,testFile,assertion] of mutations) {
    const target=path.join(mirror,file),original=fs.readFileSync(target,'utf8');
    // Match whitespace explicitly for the multiline atomic-publication guard.
    const needle=id==='M10-inputs'?find.replace(/ $/,''):find;
    assert.equal(original.split(needle).length,2,`${id}: mutation target must be unique`);
    fs.writeFileSync(target,original.replace(needle,replacement));
    try {
      const result=run(id,[testFile]);
      const killed=result.status!==0 && result.log.split('\n').some(line=>line.startsWith('not ok ') && line.includes(assertion));
      results.push({id,killed,assertion,status:result.status});
      process.stdout.write(`${id}: ${killed?'killed':'SURVIVED'} (${assertion})\n`);
      assert.equal(killed,true,`${id}: expected behavioral assertion did not fail`);
    } finally {fs.writeFileSync(target,original);}
  }
} finally {
  fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({results},null,2)+'\n');
  fs.rmSync(mirror,{recursive:true,force:true});
}
