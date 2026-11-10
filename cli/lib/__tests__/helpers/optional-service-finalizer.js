import fs from 'node:fs';
import {runSelfUpgradeFinalize, step11_startCoreServices, step12_verifyServices} from '../../self-upgrade.js';
const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const result = runSelfUpgradeFinalize(state, {steps:[
  ctx => step11_startCoreServices(ctx, {zylosDir:state.zylosDir, ecosystemPath:state.ecosystemPath}),
  step12_verifyServices,
]});
process.stdout.write(JSON.stringify(result));
