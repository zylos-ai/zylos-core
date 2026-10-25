// Both CLI processes open their own connection before either begins sending.
import { getDb } from '../../c4-db.js';

getDb();
await new Promise(resolve => {
  process.once('message', message => {
    if (message !== 'send') throw new Error('Unexpected barrier release');
    process.disconnect();
    resolve();
  });
  process.send('database-open');
});
