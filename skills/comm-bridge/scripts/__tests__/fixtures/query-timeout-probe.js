import { queryComponentSessionGroup } from '../../c4-component-session-group.js';

const start = Date.now();
let failure = null;
try {
  queryComponentSessionGroup({ component: 'demo', endpoint: 'address' }, { skillsDir: process.argv[2] });
} catch (error) {
  failure = { code: error.code, message: error.message, reason: error.reason, stderr: error.stderr };
}
process.stdout.write(JSON.stringify({ elapsed: Date.now() - start, error: failure }));
