import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

// The installed layout of one Zylos host, built from this checkout:
//   <root>/global/zylos                      the Core package as `npm install -g` leaves it, with its own node_modules
//   <root>/home/zylos/.claude/skills/<name>  Core skills as init/upgrade copy them, each with its own node_modules
// Every place gets its own copy of the SQLite driver (separate files, so separate inodes), as a real install has.
// Other dependencies are linked, not copied: only the driver's file identity matters here.
const DRIVER_FILES = ['better-sqlite3', 'bindings', 'file-uri-to-path'];
const SKIP = new Set(['node_modules', '__tests__', 'test', '.git']);

function copySource(from, to, { skip = SKIP } = {}) {
  fs.cpSync(from, to, { recursive: true, filter: file => !path.relative(from, file).split(path.sep).some(part => skip.has(part)) });
}

// Copies the driver closure found from `owner` and links every other dependency of `sourceModules`.
function installModules(owner, sourceModules, targetModules) {
  fs.mkdirSync(targetModules, { recursive: true });
  if (fs.existsSync(sourceModules)) {
    for (const entry of fs.readdirSync(sourceModules)) {
      if (DRIVER_FILES.includes(entry) || entry === '.bin' || entry.startsWith('.')) continue;
      fs.symlinkSync(fs.realpathSync(path.join(sourceModules, entry)), path.join(targetModules, entry));
    }
  }
  const driverPackage = createRequire(path.join(owner, 'package.json')).resolve('better-sqlite3/package.json');
  const driverRequire = createRequire(driverPackage);
  const sources = {
    'better-sqlite3': path.dirname(driverPackage),
    bindings: path.dirname(driverRequire.resolve('bindings/package.json')),
    'file-uri-to-path': path.dirname(createRequire(driverRequire.resolve('bindings/package.json')).resolve('file-uri-to-path/package.json')),
  };
  for (const [name, from] of Object.entries(sources)) {
    // The SQLite sources (deps, src) are build inputs only; the compiled driver lives in build/Release.
    fs.cpSync(from, path.join(targetModules, name), { recursive: true, dereference: true,
      filter: file => !['deps', 'src'].includes(path.relative(from, file).split(path.sep)[0]) });
  }
  return path.join(targetModules, 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
}

/** Builds the layout under a fresh directory of the runner's TMPDIR; the caller removes `root`. */
export function buildInstalledLayout(packageRoot) {
  const tmp = fs.realpathSync(os.tmpdir());
  assert.ok(path.isAbsolute(process.env.TMPDIR || '') && fs.realpathSync(process.env.TMPDIR) === tmp, 'An explicit runner TMPDIR is required');
  assert.ok(!tmp.startsWith(os.userInfo().homedir + path.sep) || tmp.includes(`${path.sep}zylos-tests-`), 'TMPDIR must be the runner\'s own');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmp, 'one-driver-')));
  const home = path.join(root, 'home'), zylosDir = path.join(home, 'zylos'), corePackage = path.join(root, 'global', 'zylos');
  const skills = path.join(zylosDir, '.claude', 'skills');
  const shims = path.join(root, 'shims'), shimLog = path.join(root, 'shim.log');
  for (const directory of [corePackage, skills, shims, path.join(zylosDir, '.zylos'), path.join(zylosDir, 'comm-bridge'),
    path.join(zylosDir, 'components', 'dashboard'), path.join(home, '.pm2'), path.join(root, 'tmp'), path.join(root, 'tmux')]) {
    fs.mkdirSync(directory, { recursive: true });
  }

  fs.copyFileSync(path.join(packageRoot, 'package.json'), path.join(corePackage, 'package.json'));
  copySource(path.join(packageRoot, 'cli'), path.join(corePackage, 'cli'));
  copySource(path.join(packageRoot, 'skills'), path.join(corePackage, 'skills'), { skip: new Set([...SKIP, 'public']) });
  const drivers = { core: installModules(packageRoot, path.join(packageRoot, 'node_modules'), path.join(corePackage, 'node_modules')) };
  for (const name of ['comm-bridge', 'dashboard']) {
    const source = path.join(packageRoot, 'skills', name);
    copySource(source, path.join(skills, name));
    drivers[name] = installModules(source, path.join(source, 'node_modules'), path.join(skills, name, 'node_modules'));
  }
  const inodes = new Set(Object.values(drivers).map(file => fs.statSync(file).ino));
  assert.equal(inodes.size, 3, 'each install place must hold its own driver file');

  fs.writeFileSync(path.join(zylosDir, '.zylos', 'config.json'), JSON.stringify({ runtime: 'claude', session_mode: 'multi' }));
  // No privileged or system command may run; these stand in for any that a code path might reach.
  for (const command of ['sudo', 'systemctl', 'apt-get']) {
    fs.writeFileSync(path.join(shims, command), `#!/bin/sh\necho "${command} $*" >> '${shimLog}'\nexit 0\n`, { mode: 0o755 });
  }
  const env = {
    HOME: home, ZYLOS_DIR: zylosDir, ZYLOS_PACKAGE_ROOT: corePackage, PM2_HOME: path.join(home, '.pm2'),
    TMPDIR: path.join(root, 'tmp'), TMUX_TMPDIR: path.join(root, 'tmux'), LANG: 'C.UTF-8',
    PATH: [shims, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter),
  };
  for (const name of ['HOME', 'ZYLOS_DIR', 'ZYLOS_PACKAGE_ROOT', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR']) {
    assert.ok(env[name].startsWith(root + path.sep), `${name} must stay inside the fixture`);
  }
  return { root, home, zylosDir, corePackage, skills, drivers, env, shimLog,
    c4Db: path.join(zylosDir, 'comm-bridge', 'c4.db'), dashboardDb: path.join(zylosDir, 'components', 'dashboard', 'dashboard.db') };
}
