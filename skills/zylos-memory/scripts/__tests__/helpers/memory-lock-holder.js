import { withMemoryLock } from '../../sync-lock.js';

await withMemoryLock(process.argv[2], async () => {
  process.send('locked');
  await new Promise(resolve => process.once('message', resolve));
});
process.disconnect();
