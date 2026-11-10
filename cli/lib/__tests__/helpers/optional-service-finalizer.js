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
  step12_verifyServices,
]});
process.stdout.write(JSON.stringify(result));
