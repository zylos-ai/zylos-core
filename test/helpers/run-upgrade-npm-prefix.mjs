import fs from 'node:fs';
import {runUpgradeEntry} from '../../cli/lib/upgrade-entry.js';
import {maintenance} from '../../cli/lib/upgrade-protection.js';

const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const calls = [];
// Database compatibility and all mutation stages are outside this focused
// admission test. npm resolution, npm execution, layout checks and discovery
// use the real product modules in a separate process.
const result = await runUpgradeEntry(input, {
  probe: () => ({databases:[{}, {}], needsMigration:false}),
  preflight() {},
  begin() { calls.push('begin'); },
  savePackage() { calls.push('savePackage'); },
  saveCode() { calls.push('saveCode'); },
  prepare() { calls.push('prepare'); },
  install() { calls.push('install'); },
  finalize() { calls.push('finalize'); return {success:true}; },
  recover() { calls.push('recover'); throw Error('Unexpected recovery'); },
});
const found = maintenance.discover(input.zylosDir);
process.stdout.write(JSON.stringify({result, calls, found}) + '\n');
process.exitCode = result.success ? 0 : 1;
