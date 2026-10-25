#!/usr/bin/env node
/** Scheduler process entry. Import daemon-dispatch.js to exercise the loop. */
import { getDb } from './database.js';
import { loadTimezone } from './tz.js';
import { mainLoop } from './daemon-dispatch.js';

export async function startScheduler() {
  process.env.TZ = loadTimezone();
  const db = getDb();
  let running = true;
  const stop = () => { running = false; };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  console.log(`[${new Date().toISOString()}] Scheduler started (TZ: ${process.env.TZ})`);
  try { await mainLoop(db, { shouldRun: () => running }); }
  finally {
    db.close();
  }
}

startScheduler().catch(error => {
  console.error(`Scheduler failed [${error.code || 'INTERNAL_ERROR'}]: ${error.message}`);
  process.exitCode = 1;
});
