import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'upgrade-output-'));
process.env.ZYLOS_DIR=fixture;
const {formatC4Reply,formatSelfUpgradeCompletion,formatFinalizeResult}=await import('../../commands/component.js');

test('component upgrade preflight failure uses the same label in the C4 reply',()=>{
 const preflight=formatC4Reply('upgrade',{component:'example',success:false,failedStep:0,error:'Unpaired Caddy route markers'});
 assert.equal(preflight,'example upgrade preflight failed: Unpaired Caddy route markers');
 const later=formatC4Reply('upgrade',{component:'example',success:false,failedStep:6,error:'route error'});
 assert.equal(later,'example upgrade failed (step 6): route error');
});
test.after(()=>fs.rmSync(fixture,{recursive:true,force:true}));

test('self-upgrade and forward repair readable output retain Web Console repair instructions',()=>{
 const webConsoleMigration={status:'manual_required',reason:'Custom route needs inspection.',instructions:[
  'Inspect /private/http/Caddyfile:8.',
  'Add header_up X-Forwarded-Prefix /console to the Web Console reverse_proxy block.',
  'Validate the candidate and reload Caddy, then verify the login cookie Path.',
 ]};
 const outputs=[formatSelfUpgradeCompletion({webConsoleMigration}),formatFinalizeResult({ok:true,data:{
  transactionId:'private',core:{state:'done'},dashboard:{state:'ready'},webConsoleMigration,
 }})];
 for(const output of outputs){
  assert.match(output,/Web Console: Custom route needs inspection\./);
  for(const instruction of webConsoleMigration.instructions) assert.ok(output.includes(instruction));
  assert.doesNotMatch(output,/Runtime warning/);
 }
 assert.equal(formatSelfUpgradeCompletion({webConsoleMigration:{status:'unchanged'}}),'');
 assert.equal(formatSelfUpgradeCompletion({webConsoleMigration:{status:'skipped'}}),'');
});
