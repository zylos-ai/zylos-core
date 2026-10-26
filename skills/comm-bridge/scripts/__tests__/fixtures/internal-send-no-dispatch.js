// Loaded only by isolated CLI tests: internal must never dispatch or probe.
import childProcess from 'node:child_process';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
const forbidden = () => { throw new Error('internal attempted process or IPC dispatch'); };
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync']) childProcess[name] = forbidden;
net.connect = forbidden;
net.createConnection = forbidden;
syncBuiltinESMExports();
