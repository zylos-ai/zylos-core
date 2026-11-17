import { mock } from 'node:test';
import fs from 'node:fs';
import { getDb } from '../../skills/comm-bridge/scripts/c4-db.js';

const mode = process.env.DISPATCHER_FIXTURE_MODE;
let database;
const events = [];
const heldHandle = setInterval(() => {}, 1000);
process.on('SIGUSR2', () => clearInterval(heldHandle));
process.on('exit', code => fs.writeFileSync(process.env.DISPATCHER_FIXTURE_RESULT,
  JSON.stringify({ code, events, databaseOpen: database?.open ?? false })));
const failure = () => {
  const error = new Error('fixture startup failed');
  error.stack += '\n' + 'stack-frame '.repeat(65536) + '\nEND-OF-STACK';
  return error;
};
mock.module(new URL('../../skills/comm-bridge/scripts/router/factory.js', import.meta.url).href, {
  namedExports: { createDispatcher() {
    if (mode === 'create') throw failure();
    database = getDb();
    return {
      async start() { events.push('start'); if (mode === 'start') throw failure(); },
      async stop() {
        events.push('stop');
        if (mode === 'shutdown') throw new Error('fixture shutdown failed');
        if (mode !== 'start') clearInterval(heldHandle);
      },
    };
  } },
});
