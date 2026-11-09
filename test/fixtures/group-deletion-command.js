import fs from 'node:fs';
import path from 'node:path';
import { runGroupDeletionCli } from '../../cli/lib/group-delete-cli.js';
import { createGroupDeletion } from '../../cli/lib/group-delete.js';
const barrier = path.join(process.env.ZYLOS_DIR, 'files-removed');
process.exitCode = await runGroupDeletionCli(process.argv.slice(2), {
  create: options => createGroupDeletion({ ...options, onStage(stage) {
    if (stage === 'files_removed' && process.env.GROUP_DELETION_PAUSE === '1') {
      fs.writeFileSync(barrier, String(process.pid));
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
    }
  } }),
});
