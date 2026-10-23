import { updateConfigWithLock } from '../../config-lock.js';

const { configFile, lockFile, writer, iterations } = JSON.parse(process.argv[2]);

for (let iteration = 0; iteration < iterations; iteration += 1) {
  const value = `${writer}:${iteration}`;
  const result = updateConfigWithLock({
    configFile,
    lockFile,
    update: { set: { shared: value } },
    waitMs: 10_000,
  });
  process.stdout.write(`${JSON.stringify({ value, previous: result.previous.shared })}\n`);
}
