import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const maintenance = require('./upgrade-maintenance.cjs');

// The frozen controller carries this implementation with its existing hash.
export const classifyCutoff = maintenance.classifyCutoff;

export function commitCutoff(ctx, { postCutoff, dashboardInstall = null }, overrides = {}) {
  const m = overrides.maintenance ?? maintenance;
  const dir = ctx.transactionDir;
  const journal = m.transaction(ctx.zylosDir, dir);
  if (journal.transactionId !== ctx.transactionId || journal.phase !== 'installing' ||
      journal.installationIntent !== true || classifyCutoff(journal) !== 'none') {
    throw Object.assign(Error('cutoff requires own installing transaction'), { code: 'CUTOFF_UNTRUSTED' });
  }
  if (!postCutoff || postCutoff.formatVersion !== 1 || postCutoff.items?.hooks?.state !== 'pending') {
    throw Error('cutoff requires pending publication inputs');
  }
  if (m.hash(path.join(journal.dbBackupDir, 'manifest.json')) !== journal.snapshotManifestHash) {
    throw Error('snapshot manifest changed before cutoff');
  }
  const compensationCutoff = {
    formatVersion: 1, closed: true, transactionId: journal.transactionId,
    closedAt: new Date().toISOString(), snapshotManifestHash: journal.snapshotManifestHash,
    writer: 'finalizer'
  };
  const expected = { phase: 'compensation_closed', compensationCutoff, postCutoff, dashboardInstall };
  try {
    m.update(dir, journal, expected);
    const saved = m.transaction(ctx.zylosDir, dir);
    if (saved.transactionId !== ctx.transactionId || classifyCutoff(saved) !== 'closed' ||
        Object.entries(expected).some(([key, value]) => !isDeepStrictEqual(saved[key], value))) {
      throw Error('cutoff readback differs from committed facts');
    }
    ctx.journal = saved;
    return saved;
  } catch (cause) {
    throw Object.assign(Error('cannot confirm compensation cutoff: ' + cause.message, { cause }), {
      code: 'CUTOFF_WRITE_UNCERTAIN'
    });
  }
}
