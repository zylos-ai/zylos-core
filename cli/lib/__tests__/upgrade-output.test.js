import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'upgrade-output-'));
process.env.ZYLOS_DIR=fixture;
const {formatC4Reply}=await import('../../commands/component.js');

test('component upgrade preflight failure uses the same label in the C4 reply',()=>{
 const preflight=formatC4Reply('upgrade',{component:'example',success:false,failedStep:0,error:'Unpaired Caddy route markers'});
 assert.equal(preflight,'example upgrade preflight failed: Unpaired Caddy route markers');
 const later=formatC4Reply('upgrade',{component:'example',success:false,failedStep:6,error:'route error'});
 assert.equal(later,'example upgrade failed (step 6): route error');
});
test.after(()=>fs.rmSync(fixture,{recursive:true,force:true}));
