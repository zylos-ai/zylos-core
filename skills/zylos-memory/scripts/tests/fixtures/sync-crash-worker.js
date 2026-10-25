import fs from 'node:fs';
import path from 'node:path';
import { checkpoint, commit } from '../../sync-files.js';
const [phase, end, token] = process.argv.slice(2);
const deps = { currentRunId: async () => process.env.ZYLOS_RUN_ID };
const stop = stage => {
  fs.writeSync(1, stage + '\n');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
};
await checkpoint({ token, end: Number(end), summary: `summary ${end}` }, deps);
if (phase === 'before-rename') stop('checkpoint-written');
const rename = fs.renameSync;
fs.renameSync = (source, destination) => {
  rename(source, destination);
  if (path.basename(destination) === 'state.md') stop('state-published');
};
await commit({ token, input: { followedUpIds: [] } }, deps);
