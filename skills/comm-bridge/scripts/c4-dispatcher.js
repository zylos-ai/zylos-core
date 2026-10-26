#!/usr/bin/env node
import { createDispatcher } from './router/factory.js';
import { close } from './c4-db.js';

/** Production entry: one router owns all group lanes and drains before DB close. */
export async function main({ create = createDispatcher, closeDatabase = close,
  signals = process, log = message => console.log(`[${new Date().toISOString()}] ${message}`),
} = {}) {
  const dispatcher = create();
  let stopping;
  let started;
  const shutdown = () => stopping ??= (async () => {
    try {
      await started.catch(() => {});
      await dispatcher.stop();
    } finally {
      signals.removeListener('SIGINT', onSignal);
      signals.removeListener('SIGTERM', onSignal);
      closeDatabase();
    }
  })();
  const onSignal = () => { shutdown().catch(error => { log(`Dispatcher shutdown error: ${error.message}`); process.exitCode = 1; }); };
  signals.on('SIGINT', onSignal);
  signals.on('SIGTERM', onSignal);
  log('=== C4 Session Router Started ===');
  started = Promise.resolve().then(() => dispatcher.start());
  try { await started; }
  catch (error) {
    // Startup failure must still release owned work and the database.
    await shutdown();
    throw error;
  }
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
