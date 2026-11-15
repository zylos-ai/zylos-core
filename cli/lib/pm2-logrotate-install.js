// Manual recovery uses exactly the same defaults, npm environment and deadlines
// as init and self-upgrade. An existing module keeps its settings.
import { ensurePm2LogRotate } from './pm2-logrotate.js';

const result = await ensurePm2LogRotate();
if (result.state === 'failed') {
  console.error(result.warning);
  process.exitCode = 1;
} else {
  console.log(`PM2 log rotation is ${result.state}.`);
}
