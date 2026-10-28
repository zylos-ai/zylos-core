import fs from 'node:fs';
import path from 'node:path';

// Pack a dependency-free staging copy: npm's bundledDependencies must never
// pull the live installation's node_modules into the recovery archive.
export function saveOriginalPackage(ctx, {runInstaller} = {}) {
  const m = ctx.maintenance;
  if (!m) throw Error('protected package preservation requires maintenance');
  runInstaller ||= (context, options) => m.runInstaller(context.transactionDir, context.journal, options);
  const dir = ctx.transactionDir;
  const source = fs.realpathSync(ctx.coreDir);
  const metadata = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
  if (metadata.version !== ctx.from) throw Error('installed source version changed before preservation');
  const staging = path.join(dir, 'original-package-source');
  fs.mkdirSync(staging, {mode:0o700});
  fs.cpSync(source, staging, {recursive:true, verbatimSymlinks:true, filter: file => {
    const relative = path.relative(source, file);
    return !relative.split(path.sep).some(part => part === 'node_modules' || part === '.git');
  }});
  const output = runInstaller(ctx, {stage:'save-original-package', npmCli:ctx.protectedNpmCli,
    args:['pack', '--ignore-scripts', '--json', '--pack-destination', dir], cwd:staging});
  let packed;
  try { packed = JSON.parse(output); } catch { throw Error('invalid original npm pack result'); }
  const name = packed?.length === 1 && packed[0]?.filename;
  if (typeof name !== 'string' || path.basename(name) !== name || !name.endsWith('.tgz')) throw Error('invalid original package archive name');
  const archive = path.join(dir, name);
  m.privatePath(archive);
  const fd = fs.openSync(archive, 'r');
  try { m.fsyncFd(fd); } finally { fs.closeSync(fd); }
  m.fsyncDir(dir);
  const originalPackage = {path:archive, sha256:m.hash(archive), sourceVersion:metadata.version,
    sourceRoot:source, npmCli:fs.realpathSync(ctx.protectedNpmCli)};
  m.update(dir, ctx.journal, {originalPackage});
  return originalPackage;
}
