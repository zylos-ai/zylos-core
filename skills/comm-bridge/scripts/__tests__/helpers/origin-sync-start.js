import { startRun, closeRun } from '../../../../zylos-memory/scripts/sync-run.js';

let run;
try {
  run = await startRun({}, { currentRunId: async () => process.env.ZYLOS_RUN_ID });
  console.log(JSON.stringify({ end: run.end }));
} finally {
  if (run?.token) await closeRun({ token: run.token });
}
