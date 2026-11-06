import fs from 'node:fs';
import path from 'node:path';

const channel = path.basename(path.dirname(path.dirname(process.argv[1])));
const mode = process.env.ALERT_TRANSPORT_MODE;
const [endpoint, message] = process.argv.slice(2);
fs.appendFileSync(process.env.ALERT_TRANSPORT_RECORDS, JSON.stringify({ channel, endpoint, message, pid: process.pid }) + '\n');
const hangs = mode === 'destination_hangs' && channel === 'telegram'
  || mode === 'console_hangs' && channel === 'web-console';
if (hangs) {
  const parent = process.ppid;
  setInterval(() => {
    try { process.kill(parent, 0); }
    catch { process.exit(0); }
  }, 20);
} else if (channel === 'telegram' && mode !== 'configured') {
  process.exitCode = 7;
}
