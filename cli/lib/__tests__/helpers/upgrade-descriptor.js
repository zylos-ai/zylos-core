import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function writeRecoveryDescriptor(dir, transactionId = 'tx') {
  const closure = path.join(dir, 'sqlite-runtime');
  const descriptor = {
    formatVersion:1, transactionId, nodePath:process.execPath,
    runnerPath:path.join(dir, 'runner.cjs'), driverClosureRoot:closure,
    workerPath:path.join(closure, 'core-db-backup-worker.js'),
    driverPath:path.join(closure, 'node_modules/better-sqlite3/lib/index.js'),
    hashes:{},
  };
  for (const file of [descriptor.workerPath, descriptor.driverPath, path.join(closure, 'package.json')]) {
    fs.mkdirSync(path.dirname(file), {recursive:true, mode:0o700});
    fs.writeFileSync(file, '', {mode:0o600});
  }
  for (const name of ['runner.cjs', 'maintenance.cjs', 'finalizer.cjs']) {
    descriptor.hashes[name] = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, name))).digest('hex');
  }
  fs.writeFileSync(path.join(dir, 'descriptor.json'), JSON.stringify(descriptor), {mode:0o600});
  return descriptor;
}
