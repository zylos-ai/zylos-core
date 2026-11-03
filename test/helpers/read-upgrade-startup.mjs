import {resumeUpgradeForStartup} from '../../cli/lib/runtime/upgrade-context.js';
process.stdout.write(JSON.stringify(resumeUpgradeForStartup(process.argv[2])) + '\n');
