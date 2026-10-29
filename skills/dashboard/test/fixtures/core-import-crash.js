import { Store } from '../../src/lib/store.js';
import { CoreLogImporter } from '../../src/lib/core-log-importer.js';
const [dbPath, file, phase, identityMode] = process.argv.slice(2);
const store = new Store(dbPath);
const importer = new CoreLogImporter({ store, zylosDir: process.env.ZYLOS_DIR,
  ...(identityMode === 'injected' ? { statFile: async handle => ({ ...await handle.stat(), dev: 17, ino: 49 }) } : {}),
  transactionObserver(point) { if (point === phase) process.kill(process.pid, 'SIGKILL'); },
});
await importer.importFile('events:origin', file);
await importer.stop();
store.close();
throw new Error('Crash boundary was not reached');
