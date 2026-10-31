import path from 'node:path';
import { validateSnapshotManifest } from './core-db-backup.js';

export function loadSnapshotManifest(journal, maintenance) {
  maintenance.privatePath(journal.dbBackupDir, {directory:true});
  const file=path.join(journal.dbBackupDir, 'manifest.json');
  if(maintenance.hash(file)!==journal.snapshotManifestHash) throw Error('Snapshot manifest hash does not match cutoff facts.');
  const manifest=maintenance.read(file);
  validateSnapshotManifest(manifest);
  if(manifest.id!==journal.transactionId) throw Error('Snapshot manifest belongs to another transaction.');
  return manifest;
}
