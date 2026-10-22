import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const payload = JSON.parse(process.argv[2]);
if (payload.crashAt) {
  fs.mkdirSync(new URL('.', `file://${payload.lockFile}`).pathname, { recursive: true });
  const fd = fs.openSync(payload.lockFile, 'a', 0o600);
  const crashWorker = new URL('./f1-crash-store.js', import.meta.url).pathname;
  const script = `flock -x 3; exec ${JSON.stringify(process.execPath)} ${JSON.stringify(crashWorker)} ${JSON.stringify(JSON.stringify(payload))}`;
  const child = spawnSync('bash', ['-c', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe', fd] });
  fs.closeSync(fd);
  process.exit(child.status ?? 1);
}
if (payload.holdMs) {
  fs.mkdirSync(new URL('.', `file://${payload.lockFile}`).pathname, { recursive: true });
  const fd = fs.openSync(payload.lockFile, 'a', 0o600);
  const script = `flock -x 3; sleep ${payload.holdMs / 1000}; exec ${JSON.stringify(process.execPath)} ${JSON.stringify(new URL('../../config-lock-helper.js', import.meta.url).pathname)}`;
  const child = spawnSync('bash', ['-c', script], {
    input: JSON.stringify({ configFile: payload.configFile, update: payload.update }),
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe', fd],
  });
  fs.closeSync(fd);
  process.stdout.write(child.stdout || '');
  process.stderr.write(child.stderr || '');
  process.exit(child.status ?? 1);
}
try {
  const { updateConfigWithLock } = await import('../../config-lock.js');
  process.stdout.write(JSON.stringify(updateConfigWithLock(payload)));
} catch (error) {
  process.stderr.write(`${error.code || error.name}: ${error.message}\n`);
  process.exit(2);
}
