import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { systemSendEnvironment } from './c4-system-send-env.js';

const sendScript = fileURLToPath(new URL('./c4-send.js', import.meta.url));

export function sendOwnerAlert(target, message, { env = process.env, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [sendScript, target.channel, target.endpoint], {
      env: systemSendEnvironment(env, { notice: true }), signal, timeout: 30000, maxBuffer: 1024 * 1024,
    }, error => error ? reject(error) : resolve(true));
    child.stdin.on('error', reject);
    child.stdin.end(message + '\n');
  });
}

export async function notifyOwner(message, { readConfig, sendAlert = sendOwnerAlert, log } = {}) {
  const [{ SupervisorServerHealth }, { parseServerAlertTarget }] = await Promise.all([
    import('../../activity-monitor/scripts/supervisor-server-health.js'),
    import('../../activity-monitor/scripts/supervisor-server-observation.js'),
  ]);
  const guard = new SupervisorServerHealth({
    readAlertTarget: () => parseServerAlertTarget(readConfig()?.alert_target),
    sendAlert,
    log,
  });
  await guard.notify(message);
}
