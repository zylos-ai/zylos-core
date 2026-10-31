import fs from 'node:fs';
import path from 'node:path';

export function saveOriginalPackage(ctx) {
  const m = ctx.maintenance;
  if (!m) throw Error('protected package preservation requires maintenance');
  const dir = ctx.transactionDir;
  const source = path.resolve(ctx.coreDir);
  const metadata = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
  if (metadata.version !== ctx.from) throw Error('installed source version changed before preservation');
  const snapshot = path.join(dir, 'code', 'original-package');
  if (fs.existsSync(snapshot)) throw Error('original package snapshot already exists');
  const treeHash = m.treeHash(source, {excludeNodeModules:false, includeModes:true});
  m.copyTreePreservingModes(source, snapshot);
  m.fsyncTree(snapshot);
  m.fsyncDir(path.dirname(snapshot));
  if (m.treeHash(snapshot, {excludeNodeModules:false, includeModes:true}) !== treeHash) throw Error('original package snapshot changed during copy');
  const snapshotMetadata = JSON.parse(fs.readFileSync(path.join(snapshot, 'package.json'), 'utf8'));
  if (snapshotMetadata.version !== metadata.version) throw Error('original package snapshot version mismatch');
  const originalPackage = {path:snapshot, treeHash, sourceVersion:metadata.version, sourceRoot:source};
  m.update(dir, ctx.journal, {originalPackage});
  return originalPackage;
}
