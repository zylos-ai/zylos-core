import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runUpgradeEntry} from '../upgrade-entry.js';

test('begin failure before publication reports no recovery requirement',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'upgrade-prebegin-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const result=await runUpgradeEntry({schemaVersion:1,fromVersion:'0.9.3',tempDir:root,installedRoot:root,zylosDir:root},{inspect:()=>({zylosDir:root,skillsDir:path.join(root,'missing-skills')}),resolveNpm:()=>'/fixture/npm-cli.js'});
 assert.equal(result.success,false);assert.equal(result.preInstallProtection,false);assert.equal(result.recovery_required,false);
 assert.equal(fs.existsSync(path.join(root,'.zylos/upgrade/active.json')),false);
});
