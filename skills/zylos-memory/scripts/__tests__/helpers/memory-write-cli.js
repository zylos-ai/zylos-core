import { runMemoryWriteCli } from '../../memory-write.js';

// Inject only the live runtime reader; configuration, paths, locks and I/O are real.
const ids = JSON.parse(process.env.MEMORY_WRITE_TEST_RUN_IDS || '{}');
process.exitCode = await runMemoryWriteCli(process.argv.slice(2), {
  currentRunId: async scope => ids[scope.sessionGroup ?? '*'] ?? null,
  waitMs: process.env.MEMORY_WRITE_TEST_WAIT_MS === undefined ? undefined : Number(process.env.MEMORY_WRITE_TEST_WAIT_MS),
});
