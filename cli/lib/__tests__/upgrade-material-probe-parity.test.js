import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('all four file-only recovery material probes have identical classification',()=>{
 const files=['cli/lib/upgrade-maintenance.cjs','cli/lib/runtime/upgrade-context.js','skills/comm-bridge/scripts/sqlite-schema.js','skills/comm-bridge/scripts/c4-session-init.js'];
 const bodies=files.map(file=>{
  const source=fs.readFileSync(path.resolve(file),'utf8'),start=source.indexOf('function hasRecoveryMaterials(root) {');
  assert.notEqual(start,-1,file);
  const end=source.indexOf('\n}',start);assert.notEqual(end,-1,file);
  return source.slice(start,end+2);
 });
 for(let i=1;i<files.length;i++)assert.equal(bodies[i],bodies[0],files[i]);
});
