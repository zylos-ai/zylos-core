'use strict';

// Copied to .zylos/upgrade before protection is enabled. Node builtins only;
// Linux uses util-linux flock; macOS retains exclusive admission until release.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const {isDeepStrictEqual} = require('node:util');
const SELF_HASH = crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex');
const READY = new Set(['new_data_ready', 'new_verifying', 'restored_data_ready', 'restored_verifying']);
const TERMINAL = new Set(['upgrade_complete', 'restored_complete', 'aborted_before_install']);
const DB_PATHS = ['comm-bridge/c4.db', 'scheduler/scheduler.db', 'web-console/web-console.db'];
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/;
function hash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function fsyncFd(fd) {
  // Use Node's platform synchronization contract. On macOS libuv attempts
  // F_FULLFSYNC but may fall back; success does not identify the sync level.
  return fs.fsyncSync(fd);
}
function platformSupported(platform = process.platform) {
  try {
    if (platform !== process.platform || !['linux', 'darwin'].includes(platform)) return false;
    if (platform === 'darwin') return true; // Node admission; no crash takeover.
    const owner = identity();
    if (owner.unsupported || owner.absent || !owner.boot || !owner.start) return false;
    controllerFlock();
    return true;
  } catch { return false; }
}
function fsyncDir(dir) {
  const fd = fs.openSync(dir, 'r');
  try {
    fsyncFd(fd);
  } finally {
    fs.closeSync(fd);
  }
}
function durable(file, value) {
  fs.mkdirSync(path.dirname(file), {
    recursive: true,
    mode: 0o700
  });
  const tmp = file + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n');
    fsyncFd(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  fsyncDir(path.dirname(file));
}
function privatePath(file, {directory = false} = {}) {
  const s = fs.lstatSync(file);
  if (s.isSymbolicLink() || (directory ? !s.isDirectory() : !s.isFile())) throw Error('unsafe recovery path: ' + file);
  return s;
}
function read(file) {
  const s = privatePath(file);
  if (s.size > 1024 * 1024) throw Error('recovery JSON exceeds budget: ' + file);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function transaction(root, dir) {
  root = fs.realpathSync(root);
  const active = path.join(root, '.backup', 'self-upgrade');
  privatePath(path.join(root, '.backup'), {directory: true});
  if (path.dirname(path.resolve(dir)) !== path.resolve(active) || !ID.test(path.basename(dir))) throw Error('invalid transaction directory');
  privatePath(active, {
    directory: true
  });
  privatePath(dir, {
    directory: true
  });
  const j = read(path.join(dir, 'journal.json'));
  if (j.formatVersion !== 1 || j.transactionId !== path.basename(dir) || j.zylosDir !== path.resolve(root) || !j.phase || !j.initialIdentity) throw Error('invalid journal identity');
  if (READY.has(j.phase)) validateReadyJournal(j);
  return j;
}
function validateOriginalJournal(j, {
  completeBackups = false
} = {}) {
  const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const absolute = value => typeof value === 'string' && path.isAbsolute(value) && path.resolve(value) === value;
  const i = j.initialIdentity;
  if (!i || typeof i !== 'object' || Array.isArray(i) || !absolute(j.nodePath) || i.nodePath !== j.nodePath || j.skillsDir !== path.join(j.zylosDir, '.claude', 'skills')) throw Error('invalid data-ready original deployment identity');
  if (!absolute(i.packageJson) || !digest(i.packageHash) || !absolute(i.cliRoot) || !digest(i.cliHash) || !absolute(i.workerPath) || !digest(i.workerHash) || i.ecosystemHash !== null && !digest(i.ecosystemHash) || !Array.isArray(i.databases) || i.databases.length !== DB_PATHS.length || i.databases.some((d, index) => !d || d.source !== DB_PATHS[index] || typeof d.exists !== 'boolean')) throw Error('incomplete data-ready original identity');
  if (!Array.isArray(j.coreManifest) || !j.coreManifest.length || j.coreManifest.length > 256) throw Error('incomplete data-ready core manifest');
  const members = new Set();
  for (const e of j.coreManifest) {
    if (!e || !ID.test(e.name) || members.has(e.name) || typeof e.existedBefore !== 'boolean' || typeof e.backedUp !== 'boolean' || (e.existedBefore ? completeBackups && !e.backedUp || !digest(e.originalHash) : e.originalHash !== null)) throw Error('invalid data-ready core manifest');
    members.add(e.name);
  }
  if (!Array.isArray(j.originalServices) || j.originalServices.some(s => !s || typeof s.name !== 'string' || !s.name || typeof s.script !== 'string' || !path.isAbsolute(s.script))) throw Error('invalid data-ready original service set');
}
function validateReadyJournal(j) {
  // data_ready releases normal business writers. Check durable records, never
  // current DB hashes: legitimate writes after data_ready must remain valid.
  if (j.installationIntent !== true) throw Error('invalid data-ready installation identity');
  if (j.dbBackupDir !== path.join(j.zylosDir, '.backup', 'db', j.transactionId) || typeof j.snapshotManifestHash !== 'string' || !/^[a-f0-9]{64}$/.test(j.snapshotManifestHash)) throw Error('invalid data-ready installation/material identity');
  validateOriginalJournal(j, {
    completeBackups: true
  });
}
function terminalValid(j) {
  const cutoff = classifyCutoff(j);
  if (cutoff === 'untrusted' || cutoff === 'closed' && j.phase !== 'upgrade_complete') return false;
  // A verified success awaiting code cleanup must never authorize compensation.
  // Legacy complete terminals remain readable; only this explicit new shape
  // permits incomplete cleanup to retain terminal authority.
  const cleanupPending = j.phase === 'upgrade_complete' && j.cleanup?.complete === false && j.cleanup.codeRemoved === false;
  if (!TERMINAL.has(j.phase) || !cleanupPending && j.cleanup?.complete !== true || j.cleanup?.servicesRestored !== true || j.terminalEvidence?.verified !== true) return false;
  try {
    if (j.phase === 'aborted_before_install') validateOriginalJournal(j);else validateReadyJournal(j);
  } catch {
    return false;
  }
  return j.phase === 'aborted_before_install' ? j.installationIntent === false && j.terminalEvidence.kind === 'original_deployment_and_readonly_data' : j.installationIntent === true && j.terminalEvidence.kind === 'code_data_services';
}
function provisionalAbortValid(j) {
  try {
    validateOriginalJournal(j);
    return j.phase === 'aborted_before_install' && j.installationIntent === false && j.terminalEvidence?.kind === 'original_deployment_and_readonly_data' && j.terminalEvidence?.verified === true;
  } catch {
    return false;
  }
}
// Ordinary entrypoints only consult the explicit active marker. Historical
// transactions are inspected by upgrade admission and explicit recovery tools.
function hasRecoveryMaterials(root) {
  const present = file => {
    try { return fs.lstatSync(file); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  try {
    for (const relative of ['.zylos', '.zylos/upgrade']) {
      const file = path.join(root, relative), stat = present(file);
      if (!stat) continue;
      if (stat.isSymbolicLink()) {
        if (relative !== '.zylos' || !fs.statSync(file).isDirectory()) return true;
      } else if (!stat.isDirectory()) return true;
    }
    return !!present(path.join(root, '.zylos/upgrade/active.json'));
  } catch { return true; }
}

function hasRecoveryHistory(root) {
  const present = file => {
    try { return fs.lstatSync(file); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  // Unmarked clean terminals are history, not authority to execute recovery.
  // Inspect only bounded JSON/structure here, without owner/mode checks or code.
  const cleanTerminal = (j, id) => {
    const cutoff = classifyCutoff(j);
    if (cutoff === 'untrusted' || cutoff === 'closed' && j.phase !== 'upgrade_complete') return false;
    const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
    const absolute = value => typeof value === 'string' && path.isAbsolute(value) && path.resolve(value) === value;
    const dbs = ['comm-bridge/c4.db', 'scheduler/scheduler.db', 'web-console/web-console.db'];
    if (!j || j.formatVersion !== 1 || j.transactionId !== id || j.zylosDir !== fs.realpathSync(root) ||
        !['upgrade_complete', 'restored_complete', 'aborted_before_install'].includes(j.phase) ||
        j.cleanup?.complete !== true || j.cleanup.servicesRestored !== true || j.terminalEvidence?.verified !== true ||
        j.terminalServicesStopped || j.installerExitUnconfirmed || j.finalizerExitUnconfirmed ||
        j.installerStarted && !j.installerExitConfirmed || j.finalizerStarted && !j.finalizerExitConfirmed) return false;
    const aborted = j.phase === 'aborted_before_install', i = j.initialIdentity;
    if (j.installationIntent !== !aborted || j.terminalEvidence.kind !== (aborted ? 'original_deployment_and_readonly_data' : 'code_data_services') ||
        !i || Array.isArray(i) || !absolute(j.nodePath) || i.nodePath !== j.nodePath || j.skillsDir !== path.join(j.zylosDir, '.claude', 'skills') ||
        !absolute(i.packageJson) || !digest(i.packageHash) || !absolute(i.cliRoot) || !digest(i.cliHash) ||
        !absolute(i.workerPath) || !digest(i.workerHash) || i.ecosystemHash !== null && !digest(i.ecosystemHash) ||
        !Array.isArray(i.databases) || i.databases.length !== dbs.length || i.databases.some((d, index) => !d || d.source !== dbs[index] || typeof d.exists !== 'boolean') ||
        !Array.isArray(j.coreManifest) || !j.coreManifest.length || j.coreManifest.length > 256 ||
        !Array.isArray(j.originalServices) || j.originalServices.some(s => !s || typeof s.name !== 'string' || !s.name || !absolute(s.script))) return false;
    const members = new Set();
    for (const e of j.coreManifest) {
      if (!e || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(e.name) || members.has(e.name) || typeof e.existedBefore !== 'boolean' ||
          typeof e.backedUp !== 'boolean' || (e.existedBefore ? !aborted && !e.backedUp || !digest(e.originalHash) : e.originalHash !== null)) return false;
      members.add(e.name);
    }
    return aborted || j.dbBackupDir === path.join(j.zylosDir, '.backup', 'db', id) && digest(j.snapshotManifestHash);
  };
  try {
    if (present(path.join(root, '.zylos/upgrade/active.json'))) return true;
    for (const relative of ['.zylos', '.zylos/upgrade', '.backup', '.backup/self-upgrade']) {
      const file = path.join(root, relative), stat = present(file);
      if (!stat) continue;
      if (stat.isSymbolicLink()) {
        if (relative !== '.zylos' && relative !== '.backup' || !fs.statSync(file).isDirectory()) return true;
      } else if (!stat.isDirectory()) return true;
    }
    const active = path.join(root, '.backup/self-upgrade');
    if (!present(active)) return false;
    const entries = fs.readdirSync(active, {withFileTypes:true});
    if (entries.length > 10000) return true;
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(entry.name)) return true;
      const file = path.join(active, entry.name, 'journal.json'), stat = present(file);
      if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024 ||
          !cleanTerminal(JSON.parse(fs.readFileSync(file, 'utf8')), entry.name)) return true;
    }
    // A marker published during the scan takes precedence over clean history.
    return !!present(path.join(root, '.zylos/upgrade/active.json'));
  } catch {
    return true;
  }
}
function discover(root, {
  budget = 10000
} = {}) {
  root = fs.realpathSync(root);
  if (!hasRecoveryHistory(root)) return {marker:null, candidates:[], diagnostics:[], blocked:false};
  const active = path.join(root, '.backup', 'self-upgrade');
  const markerFile = path.join(root, '.zylos', 'upgrade', 'active.json');
  let marker = null,
    activeCount = 0;
  const candidates = [],
    diagnostics = [];
  const addCandidate = candidate => {
    activeCount++;
    if (candidates.length < 8) candidates.push(candidate);
  };
  // lstat distinguishes genuinely absent materials from dangling links. Check
  // fixed parents too: a dangling parent makes every nested existsSync false.
  const present = file => {
    try {
      fs.lstatSync(file);
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  };
  // These pre-existing parents also hold ordinary runtime data.
  for (const relative of ['.zylos', '.zylos/upgrade', '.backup']) {
    const directory = path.join(root, relative);
    try {
      if (present(directory)) privatePath(directory, {directory: true});
    } catch (error) {
      diagnostics.push(error.message);
    }
  }
  try {
    if (present(markerFile)) {
      marker = read(markerFile);
      if (marker.formatVersion !== 1 || !ID.test(marker.transactionId) || marker.transactionDir !== path.join(active, marker.transactionId)) throw Error('invalid marker');
    }
  } catch (error) {
    marker = null;
    diagnostics.push(error.message);
  }
  let hasActive = false;
  try {
    hasActive = present(active);
  } catch (error) {
    diagnostics.push(error.message);
  }
  if (hasActive) {
    try {
      privatePath(active, {
        directory: true
      });
      const entries = fs.readdirSync(active, {
        withFileTypes: true
      });
      if (entries.length > budget) throw Error('transaction scan budget exhausted');
      for (const ent of entries) {
        if (!ent.isDirectory() || ent.isSymbolicLink() || !ID.test(ent.name)) {
          diagnostics.push('unsafe transaction entry: ' + ent.name);
          continue;
        }
        const dir = path.join(active, ent.name);
        try {
          const j = transaction(root, dir);
          if (!terminalValid(j) || j.cleanup.complete !== true || j.installerExitUnconfirmed || j.finalizerExitUnconfirmed || j.finalizerStarted && !j.finalizerExitConfirmed || j.installerStarted && !j.installerExitConfirmed || j.terminalServicesStopped || marker?.transactionId === j.transactionId) addCandidate({
            dir,
            journal: j
          });
        } catch (e) {
          diagnostics.push(e.message);
        }
      }
    } catch (e) {
      diagnostics.push(e.message);
    }
  }
  if (marker && !candidates.some(c => c.journal.transactionId === marker.transactionId)) diagnostics.push('marker has no valid transaction');
  if (activeCount > 8) diagnostics.push('active transaction limit exceeded');
  return {
    marker,
    candidates,
    diagnostics,
    // Verified terminal data is available even while its final marker remains.
    // Unconfirmed children still isolate it; invalid terminal labels never do.
    blocked: diagnostics.length > 0 || candidates.some(c => c.journal.installerExitUnconfirmed || c.journal.finalizerExitUnconfirmed || TERMINAL.has(c.journal.phase) && (c.journal.finalizerStarted && !c.journal.finalizerExitConfirmed || c.journal.installerStarted && !c.journal.installerExitConfirmed) || !READY.has(c.journal.phase) && !terminalValid(c.journal) && !provisionalAbortValid(c.journal))
  };
}
// The active marker is published before stopping writers and retained until
// terminal cleanup. Daily checks read only its one referenced journal; old
// backups and unrelated transaction damage cannot change availability.
function discoverActive(root) {
  if (!hasRecoveryMaterials(root)) return {marker:null, candidates:[], diagnostics:[], blocked:false};
  const candidates = [], diagnostics = [];
  let marker = null;
  try {
    root = fs.realpathSync(root);
    for (const relative of ['.zylos', '.zylos/upgrade']) privatePath(path.join(root, relative), {directory:true});
    marker = read(path.join(root, '.zylos/upgrade/active.json'));
    const dir = path.join(root, '.backup/self-upgrade', marker.transactionId || '');
    if (marker.formatVersion !== 1 || !ID.test(marker.transactionId) || marker.transactionDir !== dir) throw Error('invalid active marker');
    candidates.push({dir, journal:transaction(root, dir)});
  } catch (error) { diagnostics.push(error.message); }
  return {marker, candidates, diagnostics,
    blocked: diagnostics.length > 0 || candidates.some(({journal:j}) =>
      j.installerExitUnconfirmed || j.finalizerExitUnconfirmed ||
      TERMINAL.has(j.phase) && (j.finalizerStarted && !j.finalizerExitConfirmed || j.installerStarted && !j.installerExitConfirmed) ||
      !READY.has(j.phase) && !terminalValid(j) && !provisionalAbortValid(j))};
}
function assertCoreDatabaseAvailable(root) {
  const d = discoverActive(root);
  if (d.blocked) {
    const e = Error('core database maintenance: ' + (d.diagnostics.join('; ') || d.candidates.map(c => `${c.journal.transactionId}:${c.journal.phase}`).join('; ')));
    e.code = 'ZYLOS_MAINTENANCE';
    throw e;
  }
}
function identity(pid = process.pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return {pid, unsupported:true};
  try {
    if (process.platform === 'darwin') return {pid, unsupported:true};
    let stat;
    try { stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT' && process.platform === 'linux') return {pid, absent:true};
      throw error;
    }
    const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    const boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    if (!/^\d+$/.test(start) || !boot) throw Error('invalid process identity');
    return {pid, boot, start};
  } catch {
    return {pid, unsupported:true};
  }
}
function alive(owner) {
  if (!owner || owner.unsupported || !owner.boot || !owner.start) throw Error('controller process identity unavailable');
  const now = identity(owner.pid);
  if (now.unsupported) throw Error('controller process identity query failed');
  return !now.absent && now.boot === owner.boot && now.start === owner.start;
}
// The guard inode is retained for the lifetime of the transaction. Kernel flock
// serializes the entire read/check/replace operation and releases on process
// death. An unlinkable PID/mkdir guard would repeat the stale-lock TOCTOU.
function controllerOperation(dir, operation, value) {
  const lock = path.join(dir, 'controller.json');
  if (operation === 'acquire') {
    if (!alive(value)) throw Error('transaction controller identity is not alive');
    if (fs.existsSync(lock) && alive(read(lock))) throw Error('transaction controller is still alive');
    durable(lock, value);
  } else if (operation === 'release') {
    if (fs.existsSync(lock)) {
      const current = read(lock);
      if (current.pid === value.pid && current.boot === value.boot && current.start === value.start && current.token === value.token) {
        fs.unlinkSync(lock);
        fsyncDir(dir);
      }
    }
  } else throw Error('invalid controller lock operation');
}
function controllerFlock() {
  for (const candidate of ['/usr/bin/flock', '/bin/flock']) {
    try {
      const executable = fs.realpathSync(candidate),
        s = fs.statSync(executable);
      if (s.isFile() && s.mode & 0o111) return executable;
    } catch {}
  }
  throw Error('trusted Linux flock executable unavailable');
}
function preflightExternalTools(platform = process.platform) {
  const node = fs.realpathSync(process.execPath), stat = fs.statSync(node);
  if (!stat.isFile() || !(stat.mode & 0o111)) throw Error('untrusted recovery Node executable');
  if (platform === 'linux') controllerFlock();
}
function serializedController(dir, operation, value) {
  if (operation === 'release' && !fs.existsSync(dir)) return;
  privatePath(dir, {
    directory: true
  });
  const guard = path.join(dir, 'controller.guard');
  const fd = fs.openSync(guard, fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
  try {
    const s = fs.fstatSync(fd);
    if (!s.isFile()) throw Error('unsafe controller guard');
    fsyncFd(fd);
    fsyncDir(dir);
    // /proc/self/fd/3 refers to the already validated inode, not a path that can
    // be swapped between validation and flock. The child has no runtime deps.
    const savedHelper = path.join(dir, 'maintenance.cjs');
    const helper = fs.existsSync(savedHelper) && hash(savedHelper) === SELF_HASH ? savedHelper : __filename;
    if (!fs.existsSync(helper) || hash(helper) !== SELF_HASH) throw Error('serialized controller helper unavailable or changed');
    const binary = controllerFlock();
    const args = ['--exclusive', '--no-fork', '--timeout', '5', '/proc/self/fd/3', process.execPath, helper];
    const r = cp.spawnSync(binary, [...args, '--controller-lock', operation, path.resolve(dir)], {
      input: JSON.stringify(value),
      encoding: 'utf8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe', fd]
    });
    if (r.error || r.status !== 0) throw Error(r.error?.message || r.stderr?.trim() || 'controller guard unavailable');
  } finally {
    fs.closeSync(fd);
  }
}
// Mac admission is never reclaimed by PID, age, or parseability. The live
// closure is the only ordinary-failure continuation capability; disk/CLI input
// cannot reconstruct it after interruption.
function acquireMac(dir, {publishedDir} = {}) {
  dir = path.resolve(dir);
  privatePath(dir, {directory:true});
  if (publishedDir !== undefined) {
    const j = read(path.join(dir, 'journal.json'));
    if (!ID.test(j.transactionId) || dir !== path.join(j.zylosDir, '.backup', 'self-upgrade-staging', j.transactionId) || publishedDir !== path.join(j.zylosDir, '.backup', 'self-upgrade', j.transactionId)) throw Error('invalid controller publication path');
  }
  const value = {mode:'live-owner', pid:process.pid, token:crypto.randomBytes(16).toString('hex')};
  const file = path.join(dir, 'controller.json');
  let fd;
  try { fd = fs.openSync(file, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw Error('controller admission retained; interrupted macOS upgrade requires manual recovery');
    throw error;
  }
  try { fs.writeFileSync(fd, JSON.stringify(value)); fsyncFd(fd); fsyncDir(dir); }
  finally { fs.closeSync(fd); }
  let held = true, active = false;
  function location() { return fs.existsSync(dir) ? dir : publishedDir || dir; }
  function verify(expectedDir) {
    if (!held) throw Error('controller ownership already released');
    const currentDir = location();
    if (expectedDir !== undefined && fs.realpathSync(expectedDir) !== fs.realpathSync(currentDir)) throw Error('controller ownership belongs to another transaction');
    privatePath(currentDir, {directory:true});
    const current = read(path.join(currentDir, 'controller.json'));
    if (current.token !== value.token || current.pid !== value.pid || current.mode !== value.mode) throw Error('controller ownership changed');
    return currentDir;
  }
  function release() {
    if (!held) return;
    if (active) throw Error('cannot release controller during recovery');
    const currentDir = verify();
    fs.unlinkSync(path.join(currentDir, 'controller.json'));
    held = false;
    fsyncDir(currentDir);
  }
  release.withOwnership = (expectedDir, run) => {
    verify(expectedDir);
    if (active) throw Error('recovery already active');
    active = true;
    try { return run(); } finally { active = false; }
  };
  return release;
}
function acquire(dir, {
  publishedDir
} = {}) {
  if (process.platform === 'darwin') return acquireMac(dir, {publishedDir});
  const value = {
    ...identity(),
    token: crypto.randomBytes(16).toString('hex')
  };
  if (value.unsupported) throw Error('process identity verification unsupported');
  dir = path.resolve(dir);
  let publicationIdentity = null;
  if (fs.existsSync(path.join(dir, 'journal.json'))) {
    const j = read(path.join(dir, 'journal.json'));
    const valid = j.formatVersion === 1 && ID.test(j.transactionId) && j.transactionId === path.basename(dir) && typeof j.zylosDir === 'string' && path.isAbsolute(j.zylosDir) && fs.realpathSync(j.zylosDir) === j.zylosDir;
    if (publishedDir !== undefined) {
      if (!valid || dir !== path.join(j.zylosDir, '.backup', 'self-upgrade-staging', j.transactionId) || publishedDir !== path.join(j.zylosDir, '.backup', 'self-upgrade', j.transactionId)) throw Error('invalid controller publication path');
      privatePath(path.join(j.zylosDir, '.backup'), {directory: true});
      privatePath(path.dirname(dir), {
        directory: true
      });
      privatePath(path.dirname(publishedDir), {
        directory: true
      });
      publicationIdentity = {
        root: j.zylosDir,
        id: j.transactionId
      };
    }
  } else if (publishedDir !== undefined) throw Error('publication requires trusted initial journal');
  serializedController(dir, 'acquire', value);
  return () => {
    let location = dir;
    if (!fs.existsSync(dir) && publishedDir !== undefined) {
      try {
        privatePath(publishedDir, {
          directory: true
        });
        const saved = read(path.join(publishedDir, 'journal.json'));
        if (saved.transactionId !== publicationIdentity.id || saved.zylosDir !== publicationIdentity.root) throw Error('cannot release unverified published controller');
        location = publishedDir;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    serializedController(location, 'release', value);
  };
}
// The cutoff is an immutable fact, not a phase ordering constraint. Manual
// forward repair can move recovery_required -> new_data_ready -> upgrade_complete.
function classifyCutoff(j) {
  if (!j || typeof j !== 'object' || Array.isArray(j)) return 'untrusted';
  const present = Object.prototype.hasOwnProperty.call(j, 'compensationCutoff');
  if (!present) {
    const phase = j.phase === 'recovery_required' ? j.resumePhase : j.phase;
    return phase === 'compensation_closed' || j.targetOwned === true && ['new_data_ready', 'new_verifying', 'upgrade_complete'].includes(phase)
      ? 'untrusted' : 'none';
  }
  const c = j.compensationCutoff;
  const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  if (!c || typeof c !== 'object' || Array.isArray(c) || c.formatVersion !== 1 || c.closed !== true ||
      c.transactionId !== j.transactionId || c.from !== j.from || c.to !== j.to ||
      typeof c.from !== 'string' || !c.from || typeof c.to !== 'string' || !c.to ||
      !digest(c.snapshotManifestHash) || c.snapshotManifestHash !== j.snapshotManifestHash) return 'untrusted';
  return 'closed';
}
function update(dir, j, changes = {}) {
  const file = path.join(dir, 'journal.json');
  const next = {...j, ...changes, updatedAt:new Date().toISOString()};
  if (fs.existsSync(file)) {
    const saved = read(file);
    const cutoff = classifyCutoff(saved);
    if (cutoff !== 'none') {
      if (!isDeepStrictEqual(saved.compensationCutoff, next.compensationCutoff) ||
          classifyCutoff(next) !== cutoff) throw Error('compensation cutoff facts are immutable');
    } else if (Object.prototype.hasOwnProperty.call(next, 'compensationCutoff') && classifyCutoff(next) !== 'closed') {
      throw Error('invalid compensation cutoff facts');
    }
  } else if (Object.prototype.hasOwnProperty.call(next, 'compensationCutoff') && classifyCutoff(next) !== 'closed') {
    throw Error('invalid compensation cutoff facts');
  }
  durable(file, next);
  const saved = read(file);
  if (!isDeepStrictEqual(saved, JSON.parse(JSON.stringify(next)))) throw Error('durable upgrade journal readback mismatch');
  // Preserve nested references used by the existing backup/restore loops.
  Object.assign(j, next);
  return j;
}
function marker(root, dir, j) {
  const active = path.join(root, '.backup', 'self-upgrade', j.transactionId);
  if (!ID.test(j.transactionId) || dir !== active) throw Error('invalid maintenance marker transaction path');
  durable(path.join(root, '.zylos', 'upgrade', 'active.json'), {
    formatVersion: 1,
    transactionId: j.transactionId,
    transactionDir: active
  });
}
function unmark(root, j) {
  const p = path.join(root, '.zylos', 'upgrade', 'active.json');
  if (fs.existsSync(p)) {
    const m = read(p);
    if (m.transactionId !== j.transactionId) throw Error('marker belongs to another transaction');
    fs.unlinkSync(p);
    fsyncDir(path.dirname(p));
  }
}
function command(bin, args, options = {}) {
  const r = cp.spawnSync(bin, args, {
    encoding: 'utf8',
    timeout: 30000,
    ...options
  });
  if (r.error || r.status !== 0) throw Error(r.error?.message || String(r.stderr) || `${bin} exited ${r.status}`);
  return r.stdout;
}
function services(j) {
  const output = command('pm2', ['jlist']);
  // A cold PM2 daemon prints startup banners before the JSON array.
  const arrayStart = output.search(/(?:^|\n)\s*\[(?:\s*\{|\s*\])/);
  if (arrayStart < 0) throw Error('invalid PM2 list');
  const list = JSON.parse(output.slice(arrayStart).trim());
  if (!Array.isArray(list)) throw Error('invalid PM2 list');
  const roots = [j.skillsDir, path.resolve(j.skillsDir)];
  try {
    roots.push(fs.realpathSync(j.skillsDir));
  } catch {}
  return list.filter(p => roots.some(root => String(p.pm2_env?.pm_exec_path || '').startsWith(root + path.sep))).map(p => ({
    name: p.name,
    status: p.pm2_env?.status,
    pid: p.pid,
    script: p.pm2_env.pm_exec_path
  }));
}
function stop(j) {
  if (process.platform === 'darwin') return stopBackupOnly(j);
  for (const p of services(j)) if (!['stopped', 'errored'].includes(p.status)) command('pm2', ['stop', p.name]);
  if (services(j).some(p => !['stopped', 'errored'].includes(p.status) || p.pid > 0)) throw Error('managed services not confirmed stopped');
  const knownNames = /\/(?:c4-(?:send|db|control|enqueue|queue)|scheduler|database|usage-monitor|core-db-backup-worker)\.(?:js|mjs)(?:\s|$)/;
  const processRows = command('ps', ['-eo', 'pid=,args=']).split('\n');
  const found = processRows.map(row => row.trim().match(/^(\d+)\s+(.*)$/)).filter(Boolean).filter(r => knownNames.test(r[2]) && (r[2].includes(j.skillsDir) || r[2].includes(j.zylosDir))).map(r => identity(Number(r[1]))).filter(p => p.pid !== process.pid && p.pid !== process.ppid);
  const known = [...(j.knownProcesses || []), ...found];
  const deadline = Date.now() + 10000;
  while (known.some(p => alive(p) && p.pid !== process.pid)) {
    if (Date.now() >= deadline) throw Error('known CLI/worker exit grace exhausted');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
}
// Backup-only never makes PID ownership decisions or kills processes. PM2
// confirms its managed writers stopped; ps drains known one-shot writers by
// observation, without requiring /proc or the Mac identity capability.
function stopBackupOnly(j) {
  for (const p of services(j)) if (!['stopped', 'errored'].includes(p.status)) command('pm2', ['stop', p.name]);
  if (services(j).some(p => !['stopped', 'errored'].includes(p.status) || p.pid > 0)) throw Error('managed services not confirmed stopped');
  const knownNames = /\/(?:c4-(?:send|db|control|enqueue|queue)|scheduler|database|usage-monitor|core-db-backup-worker)\.(?:js|mjs)(?:\s|$)/;
  const deadline = Date.now() + 10000;
  for (;;) {
    const writers = command('ps', ['-eo', 'pid=,args=']).split('\n')
      .map(row => row.trim().match(/^(\d+)\s+(.*)$/)).filter(Boolean)
      .filter(row => ![process.pid, process.ppid].includes(Number(row[1])) && knownNames.test(row[2]) && (row[2].includes(j.skillsDir) || row[2].includes(j.zylosDir)));
    if (!writers.length) return;
    if (Date.now() >= deadline) throw Error('known CLI/worker exit grace exhausted');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
}
function ecosystemServiceNames(ecosystem) {
  try {
    const output = command(process.execPath, ['-e', `
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = process.stderr.write.bind(process.stderr);
    try {
      const config = require(process.argv[1]);
      if (!Array.isArray(config?.apps)) throw Error('invalid ecosystem apps');
      const names = config.apps.map(app => app?.name).filter(name => typeof name === 'string');
      write(JSON.stringify([...new Set(names)]));
    } catch (error) {
      process.stderr.write(String(error?.message ?? error));
      process.exitCode = 1;
    }
    `, path.resolve(ecosystem)]);
    return JSON.parse(output);
  } catch (error) {
    throw Error('failed to load ecosystem: ' + error.message);
  }
}
function validateSavedServices(j, saved) {
  const current = services(j), names = new Set();
  for (const service of saved) {
    const matching = current.filter(item => item.name === service?.name);
    if (!service?.name || names.has(service.name) || matching.length !== 1 || matching[0].script !== service.script) {
      throw Error('original PM2 service record missing or changed: ' + service?.name);
    }
    names.add(service.name);
  }
}
function restartService(name) {
  command('pm2', ['restart', name, '--update-env']);
}
// Only a verified ecosystem can lower an original service's availability gate.
function serviceRequirements(j) {
  const original = j.originalServices || [];
  const originalHash = j.initialIdentity?.ecosystemHash;
  const ecosystem = path.join(j.zylosDir, 'pm2', 'ecosystem.config.cjs');
  if (originalHash === null) return {required:original, external:[]};
  if (typeof originalHash !== 'string' || !/^[a-f0-9]{64}$/.test(originalHash)) throw Error('original ecosystem evidence missing');
  privatePath(ecosystem);
  if (!['new_data_ready', 'new_verifying', 'upgrade_complete'].includes(j.phase) && hash(ecosystem) !== originalHash) throw Error('original ecosystem identity changed');
  const names = new Set(ecosystemServiceNames(ecosystem));
  return {required:original.filter(service => names.has(service.name)), external:original.filter(service => !names.has(service.name))};
}
function start(j) {
  const original = j.originalServices || [];
  if (!original.length) return;
  const {external} = serviceRequirements(j);
  const externalNames = new Set(external.map(service => service.name));
  if (j.initialIdentity?.ecosystemHash === null) validateSavedServices(j, original);
  else if (external.length) validateSavedServices(j, external);
  const ecosystem = path.join(j.zylosDir, 'pm2', 'ecosystem.config.cjs');
  for (const saved of original) {
    if (externalNames.has(saved.name)) {
      try { restartService(saved.name); } catch { /* Availability is decided by final verification. */ }
    } else if (j.initialIdentity?.ecosystemHash === null) restartService(saved.name);
    else command('pm2', ['startOrRestart', ecosystem, '--only', saved.name, '--update-env']);
  }
}
function verifyServices(j) {
  const {required, external} = serviceRequirements(j);
  if (external.length) validateSavedServices(j, external);
  const deadline = Date.now() + 30000;
  do {
    const all = services(j);
    const online = service => all.some(item => item.name === service.name && item.status === 'online' && item.pid > 0);
    if (required.every(online)) {
      j.serviceWarnings = [...new Set(external.filter(service => !online(service)).map(service => service.name))]
        .map(name => `Service ${name} is not online; restart it manually.`);
      if ((j.originalServices || []).length) command('pm2', ['save']);
      return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  } while (Date.now() < deadline);
  throw Error('original services did not become online');
}
function treeHash(dir, {excludeNodeModules = true, includeModes = false} = {}) {
  const h = crypto.createHash('sha256');
  if (includeModes) h.update('root-mode:' + (fs.statSync(dir).mode & 0o7777) + '\0');
  function walk(current, prefix = '') {
    for (const n of fs.readdirSync(current).sort()) {
      if (excludeNodeModules && !prefix && n === 'node_modules') continue;
      const p = path.join(current, n),
        rel = prefix + n,
        s = fs.lstatSync(p);
      h.update(rel + '\0');
      if (includeModes && !s.isSymbolicLink()) h.update('mode:' + (s.mode & 0o7777) + '\0');
      if (s.isSymbolicLink()) h.update('link:' + fs.readlinkSync(p));else if (s.isDirectory()) {
        h.update('dir');
        walk(p, rel + '/');
      } else if (s.isFile()) h.update(fs.readFileSync(p));else throw Error('unsupported deployment file');
    }
  }
  walk(dir);
  return h.digest('hex');
}
function fsyncTree(dir) {
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name),
      st = fs.lstatSync(file);
    if (st.isDirectory()) fsyncTree(file);else if (st.isFile()) {
      const fd = fs.openSync(file, 'r');
      try {
        fsyncFd(fd);
      } finally {
        fs.closeSync(fd);
      }
    } else if (!st.isSymbolicLink()) throw Error('unsupported durable deployment file');
  }
  fsyncDir(dir);
}
function copyTreePreservingModes(src, dest) {
  fs.cpSync(src, dest, {recursive:true, verbatimSymlinks:true});
  function apply(source, target) {
    const sourceStat = fs.lstatSync(source);
    if (sourceStat.isSymbolicLink()) return;
    if (sourceStat.isDirectory()) {
      for (const name of fs.readdirSync(source)) apply(path.join(source, name), path.join(target, name));
    } else if (!sourceStat.isFile()) throw Error('unsupported deployment file');
    fs.chmodSync(target, sourceStat.mode & 0o7777);
  }
  apply(src, dest);
}
function target(j, name) {
  if (!ID.test(name) || !j.coreManifest.some(e => e.name === name)) throw Error('invalid core member');
  const root = fs.realpathSync(j.skillsDir),
    p = path.join(root, name);
  let st;
  try {
    st = fs.lstatSync(p);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (st?.isSymbolicLink()) throw Error('individual core skill symlink rejected');
  return p;
}
function sync(src, dest, {excludeNodeModules = true} = {}) {
  if (!excludeNodeModules) {
    fs.rmSync(dest, {recursive:true, force:true});
    copyTreePreservingModes(src, dest);
    fsyncTree(dest);
    fsyncDir(path.dirname(dest));
    return;
  }
  fs.mkdirSync(dest, {
    recursive: true
  });
  for (const e of fs.readdirSync(dest)) if (e !== 'node_modules') fs.rmSync(path.join(dest, e), {
    recursive: true,
    force: true
  });
  fs.cpSync(src, dest, {
    recursive: true,
    verbatimSymlinks: true,
    filter: p => path.relative(src, p).split(path.sep)[0] !== 'node_modules'
  });
  fsyncTree(dest);
  fsyncDir(path.dirname(dest));
}
function worker(dir, j, payload) {
  const d = read(path.join(dir, 'descriptor.json'));
  validateDescriptor(dir, j, d);
  return JSON.parse(command(d.nodePath, [d.workerPath, JSON.stringify({
    ...payload,
    driverPath: d.driverPath
  })], {
    timeout: 120000
  }));
}
function validateDescriptor(dir, j, d) {
  dir = path.resolve(dir);
  privatePath(dir, {
    directory: true
  });
  if (d.formatVersion !== 1 || d.transactionId !== j.transactionId || d.nodePath !== j.nodePath || d.nodePath !== j.initialIdentity?.nodePath || typeof d.nodePath !== 'string' || !path.isAbsolute(d.nodePath)) throw Error('invalid recovery descriptor');
  const node = fs.realpathSync(d.nodePath),
    ns = fs.statSync(node);
  if (node !== fs.realpathSync(process.execPath) || !ns.isFile() || !(ns.mode & 0o111)) throw Error('untrusted recovery Node executable');
  const closure = path.join(dir, 'sqlite-runtime');
  const fixed = {
    runnerPath: path.join(dir, 'runner.cjs'),
    workerPath: path.join(closure, 'core-db-backup-worker.js'),
    driverPath: path.join(closure, 'node_modules', 'better-sqlite3', 'lib', 'index.js'),
    driverClosureRoot: closure
  };
  for (const [key, value] of Object.entries(fixed)) if (d[key] !== value) throw Error('recovery material outside fixed layout: ' + key);
  const names = ['finalizer.cjs', 'maintenance.cjs', 'runner.cjs'];
  if (!d.hashes || Array.isArray(d.hashes) || Object.keys(d.hashes).length !== names.length || names.some(name => !Object.hasOwn(d.hashes, name))) throw Error('missing required recovery material hashes');
  for (const name of names) {
    privatePath(path.join(dir, name));
    if (!/^[a-f0-9]{64}$/.test(d.hashes[name]) || hash(path.join(dir, name)) !== d.hashes[name]) throw Error('recovery material hash mismatch: ' + name);
  }
  // The independent closure is copied and probe-loaded before installation.
  // Its fixed entry paths must remain real files; runner hashes above protect
  // the three recovery controllers without re-hashing the native dependency tree.
  for (const file of [fixed.workerPath, fixed.driverPath, path.join(closure, 'package.json')]) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(file) !== file) throw Error('invalid driver closure entry: ' + file);
  }

}
function preflight(dir, j, expected) {
  return worker(dir, j, {
    action: 'offline-preflight',
    zylosDir: j.zylosDir,
    schemaRoot: j.skillsDir,
    manifest: expected,
    standaloneRestored: j.installationIntent === true && ['installing', 'restoring'].includes(j.phase) && expected?.status === 'complete' && expected.databases.every(database => j.dbRestore?.[database.source]?.complete === true)
  });
}
function renameIntent(dir, j, key, source, dest, expectedHash) {
  j.actions ||= {};
  let a = j.actions[key];
  if (!a) {
    a = j.actions[key] = {
      source,
      dest,
      expectedHash,
      done: false
    };
    update(dir, j);
  }
  if (a.source !== source || a.dest !== dest || a.expectedHash !== expectedHash) throw Error('rename intent conflict: ' + key);
  const src = fs.existsSync(source),
    dst = fs.existsSync(dest);
  if (dst && !src) {
    if (hash(dest) !== expectedHash) throw Error('renamed material hash mismatch');
  } else if (src && !dst) {
    if (a.done || hash(source) !== expectedHash) throw Error('rename source changed');
    fs.renameSync(source, dest);
    const fd = fs.openSync(dest, 'r');
    try {
      fsyncFd(fd);
    } finally {
      fs.closeSync(fd);
    }
    fsyncDir(path.dirname(dest));
    if (path.dirname(dest) !== path.dirname(source)) fsyncDir(path.dirname(source));
  } else throw Error('ambiguous rename state: ' + key);
  a.done = true;
  update(dir, j);
}
function packageBins(metadata) {
  const result = new Map();
  const declared = typeof metadata?.bin === 'string'
    ? {[String(metadata.name || '').split('/').pop()]:metadata.bin}
    : metadata?.bin;
  if (declared === undefined) return result;
  if (!declared || typeof declared !== 'object' || Array.isArray(declared)) throw Error('invalid installed package bin mapping');
  for (const [name, target] of Object.entries(declared)) {
    if (!name || name === '.' || name === '..' || path.basename(name) !== name || typeof target !== 'string' || !target) throw Error('invalid installed package bin mapping');
    result.set(name, target);
  }
  return result;
}
function globalPackageLayout(sourceRoot) {
  sourceRoot = path.resolve(sourceRoot);
  const suffix = path.join('lib', 'node_modules', 'zylos');
  const prefix = path.dirname(path.dirname(path.dirname(sourceRoot)));
  if (path.join(prefix, suffix) !== sourceRoot) throw Error('installed package root is outside the supported global npm layout');
  return {sourceRoot, prefix, binDir:path.join(prefix, 'bin')};
}
function validateSupportedGlobalLayout(sourceRoot, metadata, {recovery = false} = {}) {
  const unsupported = message => Object.assign(Error(message), {code:'UNSUPPORTED_INSTALL_LAYOUT'});
  let layout;
  try { layout = globalPackageLayout(sourceRoot); }
  catch { throw unsupported('Installed Core is outside the supported global npm layout.'); }
  sourceRoot = layout.sourceRoot;
  let rootStat;
  try { rootStat = fs.lstatSync(sourceRoot); } catch (error) {
    if (!recovery || error.code !== 'ENOENT') throw unsupported('Installed Core must use the supported global npm layout.');
  }
  if (rootStat && (!rootStat.isDirectory() || rootStat.isSymbolicLink())) {
    throw unsupported('Installed Core must be a real global package directory.');
  }
  const {binDir} = layout;
  let binStat;
  try { binStat = fs.lstatSync(binDir); } catch { throw unsupported('The global npm bin directory is unavailable.'); }
  if (!binStat.isDirectory() || binStat.isSymbolicLink() || fs.realpathSync(binDir) !== binDir) throw unsupported('The global npm bin path must be a real directory.');
  if (rootStat && fs.realpathSync(sourceRoot) !== sourceRoot) throw unsupported('Installed Core must use its canonical global package path.');
  if (fs.realpathSync(path.dirname(sourceRoot)) !== path.dirname(sourceRoot)) throw unsupported('The global npm package parent must be canonical.');
  if (metadata?.name !== 'zylos') throw unsupported('Installed Core package identity does not match the global layout.');
  if (recovery) {
    for (const [name] of packageBins(metadata)) {
      const link = path.join(binDir, name);
      let stat;
      try { stat = fs.lstatSync(link); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (!stat.isSymbolicLink() || !path.resolve(binDir, fs.readlinkSync(link)).startsWith(sourceRoot + path.sep)) throw unsupported('Global bin path is not owned by the Core package.');
    }
    return layout;
  }
  for (const [name, target] of packageBins(metadata)) {
    const expected = path.resolve(sourceRoot, target);
    if (expected === sourceRoot || !expected.startsWith(sourceRoot + path.sep)) throw unsupported('Installed Core declares an unsafe bin target.');
    let targetStat;
    try { targetStat = fs.statSync(expected); } catch { throw unsupported('Installed Core bin targets are unavailable.'); }
    if (!targetStat.isFile()) throw unsupported('Installed Core bin targets must be files.');
    const link = path.join(binDir, name);
    let stat;
    try { stat = fs.lstatSync(link); } catch { throw unsupported('Installed Core bin links do not match package metadata.'); }
    if (!stat.isSymbolicLink()) {
      throw unsupported('Installed Core bin links do not match package metadata.');
    }
    const resolved = path.resolve(binDir, fs.readlinkSync(link));
    if (resolved !== expected) throw unsupported('Installed Core bin links do not match package metadata.');
  }
  return layout;
}
function reconcilePackageBins(sourceRoot, originalMetadata) {
  const desired = packageBins(originalMetadata);
  const {binDir} = validateSupportedGlobalLayout(sourceRoot, originalMetadata, {recovery:true});
  for (const [name, target] of desired) {
    const link = path.join(binDir, name), expected = path.resolve(sourceRoot, target);
    if (expected === sourceRoot || !expected.startsWith(sourceRoot + path.sep)) throw Error('installed package bin target escapes package root');
    if (!fs.statSync(expected).isFile()) throw Error('installed package bin target is not a file: ' + name);
    let stat;
    try { stat = fs.lstatSync(link); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stat?.isSymbolicLink()) {
      const current = path.resolve(binDir, fs.readlinkSync(link));
      if (current === expected) continue;
      if (current === sourceRoot || current.startsWith(sourceRoot + path.sep)) fs.unlinkSync(link);
      else throw Error('global package bin link is not owned by the package: ' + name);
    }
    else if (stat) throw Error('global package bin path is not a symlink: ' + name);
    fs.symlinkSync(path.relative(binDir, expected), link);
  }
  fsyncDir(binDir);
}
function restoreOriginalPackage(dir, j) {
  if (classifyCutoff(j) !== 'none') throw Error('compensation is closed or untrusted; do not restore the original package');
  verifyContainedExit(dir, j);
  if (j.installationIntent !== true) return false;
  const original = j.originalPackage;
  const sourceRoot = original?.sourceRoot;
  const snapshot = path.join(path.resolve(dir), 'code', 'original-package');
  if (!original || original.path !== snapshot || sourceRoot !== path.dirname(j.initialIdentity.packageJson) || original.sourceVersion !== j.from ||
      typeof original.treeHash !== 'string' || !/^[a-f0-9]{64}$/.test(original.treeHash)) throw Error('original package preservation evidence missing');
  privatePath(snapshot, {directory:true});
  if (fs.realpathSync(snapshot) !== snapshot || treeHash(snapshot, {excludeNodeModules:false, includeModes:true}) !== original.treeHash) {
    throw Error('original package snapshot changed');
  }
  const metadata = read(path.join(snapshot, 'package.json'));
  if (metadata.version !== original.sourceVersion) throw Error('original package snapshot version changed');
  let currentHash = null;
  try {
    validateSupportedGlobalLayout(sourceRoot, metadata, {recovery:true});
    currentHash = treeHash(sourceRoot, {excludeNodeModules:false, includeModes:true});
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (j.originalPackageRestored && currentHash !== original.treeHash) {
    throw Error('completed original package restore changed; manual recovery required');
  }
  if (currentHash !== original.treeHash) {
    validateSupportedGlobalLayout(sourceRoot, metadata, {recovery:true});
    fs.rmSync(sourceRoot, {recursive:true, force:true});
    copyTreePreservingModes(snapshot, sourceRoot);
    fsyncTree(sourceRoot);
    fsyncDir(path.dirname(sourceRoot));
    if (treeHash(sourceRoot, {excludeNodeModules:false, includeModes:true}) !== original.treeHash) throw Error('original package restore verification failed');
  }
  if (j.originalPackageRestored) validateSupportedGlobalLayout(sourceRoot, metadata);
  else reconcilePackageBins(sourceRoot, metadata);
  if (!j.originalPackageRestored) update(dir, j, {originalPackageRestored:true});
  if (hash(j.initialIdentity.packageJson) !== j.initialIdentity.packageHash || treeHash(j.initialIdentity.cliRoot) !== j.initialIdentity.cliHash) throw Error('restored installed package identity mismatch');
}
function verifyContainedExit(dir, j) {
  for (const kind of ['installer', 'finalizer']) {
    if (!j[kind + 'ExitUnconfirmed'] && (!j[kind + 'Started'] || j[kind + 'ExitConfirmed'])) continue;
    const descriptor = read(path.join(dir, 'descriptor.json'));
    validateDescriptor(dir, j, descriptor);
    const result = require(path.join(dir, 'finalizer.cjs')).quiesce(dir, j, {terminate:false, kind});
    if (!result.confirmed) throw Error(result.error || kind + ' exit requires verification before package restore');
    update(dir, j, {[kind + 'ExitUnconfirmed']:false, [kind + 'ExitConfirmed']:true});
  }
}
function finishTerminal(dir, j) {
  if (!terminalValid(j)) throw Error('cannot finish unverified terminal');
  // Re-read durable authority: the caller may still hold the child's old state.
  const saved = transaction(j.zylosDir, dir);
  if (!terminalValid(saved)) throw Error('terminal journal is not durable');
  if (saved.terminalServicesStopped || saved.installerExitUnconfirmed || saved.finalizerExitUnconfirmed || saved.installerStarted && !saved.installerExitConfirmed || saved.finalizerStarted && !saved.finalizerExitConfirmed) return {complete:false, warnings:[]};
  if (saved.phase === 'upgrade_complete') {
    // Only the transaction's fixed code copy is disposable. Recovery programs,
    // snapshots, rescue files, logs and journals retain their original paths.
    const code = path.join(dir, 'code');
    try {
      if (fs.realpathSync(dir) !== path.resolve(dir)) throw Error('noncanonical transaction cleanup path');
      if (saved.cleanup.codeRemoved !== false || saved.cleanup.complete !== false) {
        update(dir, saved, {cleanup:{...saved.cleanup, complete:false, codeRemoved:false}});
      }
      let stat;
      try { stat = fs.lstatSync(code); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (stat) {
        privatePath(code, {directory:true});
        // Recursive rm unlinks nested symlinks; it never follows their targets.
        fs.rmSync(code, {recursive:true});
      }
      // Also sync on ENOENT: a prior attempt may have removed code but failed
      // before syncing the directory or recording completion.
      fsyncDir(dir);
      update(dir, saved, {cleanup:{...saved.cleanup, codeRemoved:true, complete:true}});
    } catch (error) {
      return {complete:false, warnings:[`Code cleanup pending at ${code}: ${error.message}`]};
    }
  }
  // Terminal evidence stays durable before removing the final active pointer.
  unmark(j.zylosDir, saved);
  return {complete:true, warnings:[]};
}

module.exports = {
  fsyncFd,
  platformSupported,
  preflightExternalTools,
  transaction,
  DB_PATHS,
  READY,
  TERMINAL,
  hash,
  treeHash,
  copyTreePreservingModes,
  classifyCutoff,
  validateSupportedGlobalLayout,
  restoreOriginalPackage,
  fsyncTree,
  durable,
  fsyncDir,
  read,
  privatePath,
  discover,
  discoverActive,
  hasRecoveryMaterials,
  assertCoreDatabaseAvailable,
  identity,
  alive,
  acquire,
  update,
  marker,
  unmark,
  services,
  stop,
  stopBackupOnly,
  ecosystemServiceNames,
  serviceRequirements,
  validateSavedServices,
  restartService,
  start,
  verifyServices,
  target,
  sync,
  worker,
  preflight,
  validateDescriptor,
  renameIntent,
  terminalValid,
  finishTerminal
};
if (require.main === module && process.argv[2] === '--controller-lock') {
  try {
    controllerOperation(process.argv[4], process.argv[3], JSON.parse(fs.readFileSync(0, 'utf8')));
  } catch (e) {
    process.stderr.write(e.message + '\n');
    process.exitCode = 1;
  }
}
