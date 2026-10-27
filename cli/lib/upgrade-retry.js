import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { loadSnapshotManifest } from './upgrade-snapshot-manifest.js';

const maintenance = createRequire(import.meta.url)('./upgrade-maintenance.cjs');
const ID = /^upgrade-(\d+)-[a-f0-9]{12}$/;

function invalid(transactionId, field, message) {
  return Object.assign(new Error(message), {
    code: 'RETRY_BASE_INVALID', transactionId, field,
    next: 'Inspect the latest upgrade transaction and its retained snapshot before retrying.',
  });
}

// Settled transactions are deliberately absent from maintenance.discover().
// Select the newest identity before reading it, so damaged newer evidence can
// never cause a fallback to an older restored transaction.
export function selectSameVersionRetry(zylosDir, currentVersion, { excludeTransactionId } = {}) {
  const root = fs.realpathSync(zylosDir);
  const history = path.join(root, '.backup', 'self-upgrade');
  try {
    maintenance.privatePath(path.join(root, '.backup'), { directory: true });
    maintenance.privatePath(history, { directory: true });
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw invalid(null, 'history', error.message);
  }
  const ids = fs.readdirSync(history).filter(id => ID.test(id) && id !== excludeTransactionId);
  ids.sort((a, b) => {
    const at = BigInt(ID.exec(a)[1]), bt = BigInt(ID.exec(b)[1]);
    return at === bt ? (a < b ? 1 : a > b ? -1 : 0) : at < bt ? 1 : -1;
  });
  const id = ids[0];
  if (!id) return null;
  let journal;
  try { journal = maintenance.transaction(root, path.join(history, id)); }
  catch (error) { throw invalid(id, 'journal', error.message); }
  if (journal.phase !== 'restored_complete') return null;
  if (journal.to !== currentVersion) {
    throw Object.assign(invalid(id, 'to', 'Latest restored transaction target does not match the current CLI version'), {
      expected: currentVersion, actual: journal.to,
    });
  }
  const effectiveFrom = journal.effectiveFrom ?? journal.from;
  if (typeof effectiveFrom !== 'string' || !effectiveFrom) throw invalid(id, 'effectiveFrom', 'Latest restored transaction has no effective source version');
  const backupDir = path.join(root, '.backup', 'db', id);
  try {
    if (journal.dbBackupDir !== backupDir) throw Error('Invalid snapshot directory identity');
    maintenance.privatePath(path.dirname(backupDir), { directory: true });
    maintenance.privatePath(backupDir, { directory: true });
    const manifest = loadSnapshotManifest(journal, maintenance);
    return { retryOf: id, effectiveFrom, snapshotFormatVersion: manifest.formatVersion };
  } catch (error) { throw invalid(id, 'snapshotManifest', error.message); }
}
