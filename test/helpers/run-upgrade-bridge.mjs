import { runDownloadedUpgrade } from '../../cli/lib/upgrade-bridge.js';

const options = JSON.parse(process.argv[2]);
process.exitCode = runDownloadedUpgrade(options);
