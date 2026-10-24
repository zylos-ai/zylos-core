import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { configLockArgs, detectConfigLockCapability } from '../../config-lock.js';

const READY = 'F1_LOCK_READY\n';
const SELF = fileURLToPath(import.meta.url);
const HELPER = fileURLToPath(new URL('../../config-lock-helper.js', import.meta.url));
const CRASH_WORKER = fileURLToPath(new URL('./f1-crash-store.js', import.meta.url));

function runAction(payload) {
  fs.writeSync(1, READY);
  if (payload.holdMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, payload.holdMs);
  const child = payload.crashAt
    ? spawnSync(process.execPath, [CRASH_WORKER, JSON.stringify(payload)], { encoding: 'utf8' })
    : spawnSync(process.execPath, [HELPER], {
      input: JSON.stringify({ configFile: payload.configFile, update: payload.update }),
      encoding: 'utf8',
    });
  process.stdout.write(child.stdout || '');
  process.stderr.write(child.stderr || '');
  process.exit(child.status ?? 1);
}

async function runHolder(payload, { capability = detectConfigLockCapability(), run = spawn } = {}) {
  fs.mkdirSync(path.dirname(payload.lockFile), { recursive: true });
  const fd = fs.openSync(payload.lockFile, 'a', 0o600);
  const backend = capability?.backend || `unsupported-${process.platform}`;
  if (!capability) {
    fs.closeSync(fd);
    fs.writeSync(2, `CONFIG_TEST_LOCK_UNAVAILABLE: ${backend}\n`);
    process.exit(3);
  }

  let child;
  try {
    const args = configLockArgs(capability, 2000, [process.execPath, SELF, JSON.stringify(payload), '--locked']);
    child = run(capability.executable, args, { stdio: ['ignore', 'inherit', 'inherit', fd] });
  } finally {
    fs.closeSync(fd);
  }
  let spawnError;
  child.once('error', error => { spawnError = error; });
  const { status, signal } = await new Promise(resolve => {
    child.once('close', (status, signal) => resolve({ status, signal }));
  });
  if (spawnError || status !== 0) {
    const detail = spawnError ? `${spawnError.code || spawnError.name}: ${spawnError.message}` : `status=${status} signal=${signal || 'none'}`;
    fs.writeSync(2, `CONFIG_TEST_LOCK_FAILED: ${backend} ${detail}\n`);
  }
  process.exit(status ?? 1);
}

const payload = JSON.parse(process.argv[2]);
if (process.argv[3] === '--locked') runAction(payload);
if (payload.crashAt || Object.hasOwn(payload, 'holdMs')) {
  await runHolder(payload, payload.fixtureLockFailure
    ? { run: (_executable, _args, options) => spawn(process.execPath, ['-e', 'process.exit(73)'], options) }
    : {});
}
try {
  const { updateConfigWithLock } = await import('../../config-lock.js');
  process.stdout.write(JSON.stringify(updateConfigWithLock(payload)));
} catch (error) {
  process.stderr.write(`${error.code || error.name}: ${error.message}\n`);
  process.exit(2);
}
