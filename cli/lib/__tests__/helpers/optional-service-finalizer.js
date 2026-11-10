import fs from 'node:fs';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {runSelfUpgradeFinalize, step11_startCoreServices, step12_verifyServices} from '../../self-upgrade.js';
const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
// Target-owned finalization also checks data after its second service verify.
// Supply only that unrelated offline DB boundary; service policy stays real.
if (state.targetOwned) {
  const spawn = childProcess.spawnSync;
  childProcess.spawnSync = (executable, args, options) => {
    if (args[0] !== state.packageRoot + '/cli/lib/core-db-backup-worker.js') return spawn(executable, args, options);
    assert.equal(executable, process.execPath);
    assert.equal(args[0], state.packageRoot + '/cli/lib/core-db-backup-worker.js');
    assert.deepEqual(JSON.parse(args[1]), {action:'offline-preflight',zylosDir:state.zylosDir,
      schemaRoot:state.zylosDir + '/.claude/skills',requireCurrent:true});
    return {status:0,stdout:JSON.stringify({success:true,databases:[]}),stderr:''};
  };
  syncBuiltinESMExports();
}
const result = runSelfUpgradeFinalize(state, {steps:[
  ctx => step11_startCoreServices(ctx, {zylosDir:state.zylosDir, ecosystemPath:state.ecosystemPath}),
  ctx => {
    const result = step12_verifyServices(ctx);
    if (state.externalAfterFirstVerify) {
      assert.equal(result.status, 'done');
      const expectedFirst = state.externalAfterFirstVerify === 'online' ? 1 : 0;
      assert.equal(ctx.serviceWarnings.length, expectedFirst, 'first verification observed the initial external state');
      const file = state.zylosDir + '/records.json';
      const records = JSON.parse(fs.readFileSync(file, 'utf8'));
      const external = records.find(record => record.name === 'custom');
      assert.ok(external, 'transition changes the existing external PM2 record');
      external.pid = state.externalAfterFirstVerify === 'online' ? 456 : 0;
      external.pm2_env.status = state.externalAfterFirstVerify;
      fs.writeFileSync(file, JSON.stringify(records));
    }
    return result;
  },
]});
process.stdout.write(JSON.stringify(result));
