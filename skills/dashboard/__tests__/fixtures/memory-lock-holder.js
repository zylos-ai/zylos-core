import { pathToFileURL } from 'node:url';
const { withMemoryLock } = await import(pathToFileURL(process.argv[2]).href);
await withMemoryLock(process.argv[3], async () => {
  process.stdout.write('held\n');
  await new Promise(resolve => setTimeout(resolve, 12000));
});
