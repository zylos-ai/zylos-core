#!/usr/bin/env node
import { loadStartupTimezone } from './startup-timezone.js';
import { createDispatcher } from './router/factory.js';
import { close } from './c4-db.js';
import { acquireDispatcherOwnership } from './dispatcher-ownership.js';

/** Production entry: one router owns all group lanes and drains before DB close. */
export async function main({ create = createDispatcher, closeDatabase = close,
  acquireOwnership = acquireDispatcherOwnership,
  signals = process, log = message => console.log(`[${new Date().toISOString()}] ${message}`),
} = {}) {
  loadStartupTimezone();
  let dispatcher;
  let ownership;
  const admission = new AbortController();
  let stopping;
  let started;
  const shutdown = () => stopping ??= (async () => {
    admission.abort();
    try {
      await started.catch(() => {});
      await dispatcher?.stop();
    } finally {
      signals.removeListener('SIGINT', onSignal);
      signals.removeListener('SIGTERM', onSignal);
      try { closeDatabase(); }
      finally { ownership?.release(); }
      // Untracked PM2 children retain an IPC channel unless explicitly detached.
      if (process.env.pm_id !== undefined && process.connected) process.disconnect();
    }
  })();
  const onSignal = () => { shutdown().catch(error => { log(`Dispatcher shutdown error: ${error.message}`); process.exitCode = 1; }); };
  signals.on('SIGINT', onSignal);
  signals.on('SIGTERM', onSignal);
  started = Promise.resolve().then(async () => {
    ownership = await acquireOwnership({ signal: admission.signal, onSuperseded: onSignal, log });
    if (!ownership || admission.signal.aborted) return;
    dispatcher = create();
    log('=== C4 Session Router Started ===');
    await dispatcher.start();
  });
  try { await started; }
  catch (error) {
    // Startup failure must still release owned work and the database.
    await shutdown();
    throw error;
  }
  if (!dispatcher) await shutdown();
  return { dispatcher, shutdown };
}

// PM2 uses ProcessContainerFork.js as argv[1]. Do not use an is-main path test.
// Tests disable only this entry; production always uses the same factory.
if (process.env.C4_DISPATCHER_DISABLE_MAIN !== '1') {
  main().catch(error => {
    console.error(`Dispatcher startup error: ${error.stack ?? error.message}`);
    process.exitCode = 1;
  });
}
