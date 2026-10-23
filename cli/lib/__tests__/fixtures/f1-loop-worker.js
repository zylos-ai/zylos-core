import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { updateConfigWithLock } from '../../config-lock.js';

const { configFile, lockFile, ledgerFile, arrivalBarrier, writer, iterations } = JSON.parse(process.argv[2]);
const ledgerHelper = fileURLToPath(new URL('./f1-ledger-helper.js', import.meta.url));

function ledgerEntry(value) {
  const entries = fs.readFileSync(ledgerFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  return entries.find(entry => entry.value === value);
}

function waitFor(file, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${file}`);
  }
}

for (let iteration = 0; iteration < iterations; iteration += 1) {
  const value = `${writer}:${iteration}`;
  const result = updateConfigWithLock({
    configFile,
    lockFile,
    update: { set: { shared: value } },
    waitMs: 10_000,
  }, {
    helper: ledgerHelper,
    spawn: (executable, args, options) => spawnSync(executable, args, {
      ...options,
      env: { ...options.env, F1_COMMIT_LEDGER: ledgerFile },
    }),
  });
  const committed = ledgerEntry(value);
  if (!committed) throw new Error(`missing commit ledger entry for ${value}`);
  if (committed.sequence === 1) waitFor(arrivalBarrier);
  fs.writeSync(1, `${JSON.stringify({ value, previous: result.previous.shared, commitSequence: committed.sequence })}\n`);
  if (committed.sequence === 2) fs.writeFileSync(arrivalBarrier, 'second result reported\n');
}
