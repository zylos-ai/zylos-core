import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runSelfUpgrade} from '../self-upgrade.js';

test('begin failure before publication reports no recovery requirement',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'upgrade-prebegin-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const result=runSelfUpgrade({newVersion:'2.0.0'},{platform:process.platform,protectionSupported:()=>true,zylosDir:root,skillsDir:path.join(root,'missing-skills'),getCurrentVersion:()=>({success:true,version:'1.0.0'})});
 assert.equal(result.success,false);assert.equal(result.preInstallProtection,false);assert.equal(result.recovery_required,false);
 assert.equal(fs.existsSync(path.join(root,'.zylos/upgrade/active.json')),false);
});
