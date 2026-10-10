'use strict';

const fs = require('node:fs'),
  path = require('node:path');
const m = require('./maintenance.cjs');
function fail(dir, j, error) {
  try {
    m.marker(j.zylosDir, dir, j);
    m.stop(j);
  } catch (e) {
    error += '; isolation: ' + e.message;
  }
  m.update(dir, j, {
    resumePhase: j.phase === 'recovery_required' ? j.resumePhase : j.phase,
    phase: 'recovery_required',
    error
  });
  return {
    attempted: !!j.installationIntent,
    completed: false,
    stage: j.resumePhase,
    error,
    recovery_required: true
  };
}
function originalVerified(dir, j) {
  if (j.installationIntent) throw Error('installation intent exists; cannot abort');
  if (j.initialIdentity.nodePath !== j.nodePath || m.hash(j.initialIdentity.packageJson) !== j.initialIdentity.packageHash) throw Error('original installed package identity changed');
  if (j.initialIdentity.cliRoot || j.initialIdentity.cliHash) {
    if (typeof j.initialIdentity.cliRoot !== 'string' || !path.isAbsolute(j.initialIdentity.cliRoot) || typeof j.initialIdentity.cliHash !== 'string') throw Error('original installed CLI evidence incomplete');
    const cliStat = fs.lstatSync(j.initialIdentity.cliRoot);
    if (!cliStat.isDirectory() || cliStat.isSymbolicLink()) throw Error('original installed CLI directory rejected');
    const inspect = current => {
      for (const name of fs.readdirSync(current)) {
        const file = path.join(current, name),
          stat = fs.lstatSync(file);
        if (stat.isSymbolicLink()) throw Error('original installed CLI symlink rejected');
        if (stat.isDirectory()) inspect(file);
      }
    };
    inspect(j.initialIdentity.cliRoot);
    if (fs.realpathSync(j.initialIdentity.cliRoot) !== j.initialIdentity.cliRoot || m.treeHash(j.initialIdentity.cliRoot) !== j.initialIdentity.cliHash) throw Error('original installed CLI identity changed');
  }
  for (const e of j.coreManifest) {
    const p = m.target(j, e.name);
    if (e.existedBefore ? !fs.existsSync(p) || m.treeHash(p) !== e.originalHash : fs.existsSync(p)) throw Error('original core deployment changed: ' + e.name);
  }
  const ecosystem = path.join(j.zylosDir, 'pm2', 'ecosystem.config.cjs');
  if (j.initialIdentity.ecosystemHash ? !fs.existsSync(ecosystem) || m.hash(ecosystem) !== j.initialIdentity.ecosystemHash : fs.existsSync(ecosystem)) throw Error('original ecosystem changed');
  // Uses original deployed pure schema contracts and readonly worker; never a normal opener.
  const expected = j.initialIdentity.databases.map(d => ({
    source: d.source,
    status: d.exists ? 'complete' : 'missing'
  }));
  let result;
  if (fs.existsSync(path.join(dir, 'descriptor.json'))) result = m.preflight(dir, j, {
    databases: expected
  });else {
    const cp = require('node:child_process');
    if (m.hash(j.initialIdentity.workerPath) !== j.initialIdentity.workerHash) throw Error('original readonly worker identity changed');
    const r = cp.spawnSync(j.nodePath, [j.initialIdentity.workerPath, JSON.stringify({
      action: 'offline-preflight',
      zylosDir: j.zylosDir,
      schemaRoot: j.skillsDir,
      manifest: {
        databases: expected
      }
    })], {
      encoding: 'utf8',
      timeout: 120000
    });
    if (r.error || r.status !== 0) throw Error(r.error?.message || r.stderr || 'original readonly verification failed');
    result = JSON.parse(r.stdout);
  }
  if (result.success === false) throw Error(result.error || 'original readonly preflight failed');
}
function abort(dir, j) {
  if (m.terminalValid(j)) {
    const cleanup = m.finishTerminal(dir, j);
    return {
      attempted: false,
      completed: false,
      stage: j.phase,
      recovery_required: false,
      ...cleanup
    };
  }
  if (!(j.phase === 'aborted_before_install' && j.installationIntent === false && j.terminalEvidence?.verified === true && j.terminalEvidence.kind === 'original_deployment_and_readonly_data')) originalVerified(dir, j);
  m.update(dir, j, {
    phase: 'aborted_before_install',
    terminalEvidence: {
      verified: true,
      kind: 'original_deployment_and_readonly_data'
    },
    cleanup: j.cleanup || {}
  });
  m.start(j);
  m.verifyServices(j);
  j.cleanup.servicesRestored = true;
  j.cleanup.complete = true;
  m.update(dir, j);
  const cleanup = m.finishTerminal(dir, j);
  return {
    attempted: false,
    completed: false,
    stage: 'aborted_before_install',
    recovery_required: false,
    ...cleanup
  };
}
function validateSnapshot(dir, j) {
  const file = path.join(j.dbBackupDir, 'manifest.json');
  const manifest = m.read(file);
  if (m.hash(file) !== j.snapshotManifestHash || manifest.id !== j.transactionId || manifest.status !== 'complete') throw Error('snapshot manifest identity mismatch');
  if (manifest.databases.length !== 3 || manifest.databases.some((d, i) => d.source !== m.DB_PATHS[i])) throw Error('snapshot database manifest incomplete');
  m.worker(dir, j, {
    action: 'verify',
    zylosDir: j.zylosDir,
    dbBackupDir: j.dbBackupDir,
    manifest
  });
  return manifest;
}
function rescue(dir, j) {
  j.rescue ||= {};
  const root = path.join(dir, 'rescue');
  fs.mkdirSync(root, {
    recursive: true,
    mode: 0o700
  });
  // Strict stopped/known-worker-exited gate ran before this physical file capture.
  for (const source of m.DB_PATHS) for (const suffix of ['', '-wal', '-shm']) {
    const key = source + suffix,
      p = path.join(j.zylosDir, key),
      dest = path.join(root, key.replaceAll('/', '_'));
    let state = j.rescue[key];
    if (!state) {
      state = j.rescue[key] = {
        source: p,
        dest,
        exists: fs.existsSync(p),
        sha256: fs.existsSync(p) ? m.hash(p) : null,
        complete: false
      };
      m.update(dir, j);
    }
    if (state.exists) {
      if (fs.existsSync(dest)) {
        if (m.hash(dest) !== state.sha256) throw Error('rescue hash conflict: ' + key);
      } else {
        if (!fs.existsSync(p) || m.hash(p) !== state.sha256) throw Error('rescue source generation changed: ' + key);
        const staging = dest + '.staging';
        if (fs.existsSync(staging) && m.hash(staging) !== state.sha256) throw Error('rescue staging conflict');
        if (!fs.existsSync(staging)) fs.copyFileSync(p, staging);
        const fd = fs.openSync(staging, 'r');
        try {
          m.fsyncFd(fd);
        } finally {
          fs.closeSync(fd);
        }
        m.renameIntent(dir, j, 'rescue_' + key.replaceAll('/', '_'), staging, dest, state.sha256);
      }
    } else if (!state.complete && fs.existsSync(p)) throw Error('rescue missing source appeared: ' + key);
    state.complete = true;
    m.update(dir, j);
  }
}
function restoreCore(dir, j) {
  j.codeRestore ||= {};
  for (const e of j.coreManifest) {
    const p = m.target(j, e.name),
      backup = path.join(dir, 'code', 'skills', e.name),
      state = j.codeRestore[e.name];
    if (e.existedBefore) {
      if (!e.backedUp || !fs.existsSync(backup) || m.treeHash(backup) !== e.originalHash) throw Error('invalid core backup: ' + e.name);
      if (state?.complete) {
        if (!fs.existsSync(p) || m.treeHash(p) !== e.originalHash) throw Error('completed core restore changed: ' + e.name);
        continue;
      }
      m.sync(backup, p);
      if (m.treeHash(p) !== e.originalHash) throw Error('core restore verification failed');
    } else if (fs.existsSync(p)) {
      const ownership = path.join(p, '.zylos', 'upgrade-owner.json');
      if (!fs.existsSync(ownership) || m.read(ownership).transactionId !== j.transactionId) throw Error('new core directory provenance unknown: ' + e.name);
      fs.rmSync(p, {
        recursive: true
      });
      m.fsyncDir(path.dirname(p));
    }
    j.codeRestore[e.name] = {
      complete: true
    };
    m.update(dir, j);
  }
  const dest = path.join(j.zylosDir, 'pm2', 'ecosystem.config.cjs'),
    backup = path.join(dir, 'code', 'pm2', 'ecosystem.config.cjs');
  if (j.initialIdentity.ecosystemHash) {
    if (!fs.existsSync(backup) || m.hash(backup) !== j.initialIdentity.ecosystemHash) throw Error('ecosystem backup invalid');
    if (j.codeRestore.ecosystem?.complete) {
      if (m.hash(dest) !== j.initialIdentity.ecosystemHash) throw Error('completed ecosystem restore changed');
    } else {
      fs.mkdirSync(path.dirname(dest), {
        recursive: true
      });
      fs.copyFileSync(backup, dest);
      const fd = fs.openSync(dest, 'r');
      try {
        m.fsyncFd(fd);
      } finally {
        fs.closeSync(fd);
      }
      m.fsyncDir(path.dirname(dest));
      j.codeRestore.ecosystem = {
        complete: true
      };
      m.update(dir, j);
    }
  } else {
    if (j.codeRestore.ecosystem?.complete) {
      if (fs.existsSync(dest)) throw Error('completed missing ecosystem restore changed');
      return;
    }
    if (fs.existsSync(dest)) {
      const intent = j.ecosystemCreationIntent;
      if (!intent || intent.target !== dest || intent.originalMissing !== true || !/^[a-f0-9]{64}$/.test(intent.intendedHash)) throw Error('new ecosystem provenance unknown');
      m.privatePath(dest);
      if (m.hash(dest) !== intent.intendedHash) throw Error('new ecosystem creation hash changed');
      fs.unlinkSync(dest);
      m.fsyncDir(path.dirname(dest));
    }
    j.codeRestore.ecosystem = {
      complete: true,
      missing: true
    };
    m.update(dir, j);
  }
}
function replaceDatabases(dir, j, manifest) {
  j.dbRestore ||= {};
  for (const d of manifest.databases) {
    const target = path.join(j.zylosDir, d.source),
      state = j.dbRestore[d.source] || (j.dbRestore[d.source] = {
        complete: false
      });
    if (state.complete) {
      if (d.status === 'missing' ? fs.existsSync(target) : !fs.existsSync(target) || m.hash(target) !== d.sha256) throw Error('completed restore target changed');
      if (fs.existsSync(target + '-wal') || fs.existsSync(target + '-shm')) throw Error('unexpected sidecar in offline restore');
      continue;
    }
    for (const suffix of ['', '-wal', '-shm']) {
      const key = d.source + suffix,
        res = j.rescue[key],
        p = target + suffix,
        dest = path.join(dir, 'rescue', 'displaced_' + key.replaceAll('/', '_'));
      if (res.exists) {
        const action = 'displace_' + key.replaceAll('/', '_');
        const intent = j.actions?.[action];
        if (intent?.done && fs.existsSync(dest) && m.hash(dest) === res.sha256) {} else if (intent && fs.existsSync(dest) && m.hash(dest) === res.sha256 && j.actions?.['install_' + d.source.replaceAll('/', '_')]) {
          intent.done = true;
          m.update(dir, j);
        } else m.renameIntent(dir, j, action, p, dest, res.sha256);
      } else if (fs.existsSync(p) && !j.actions?.['install_' + d.source.replaceAll('/', '_')]) throw Error('unexpected original DB generation');
    }
    if (d.status !== 'missing') {
      const staging = target + '.' + j.transactionId + '.restore';
      const action = 'install_' + d.source.replaceAll('/', '_');
      if (!j.actions?.[action]) {
        fs.mkdirSync(path.dirname(target), {
          recursive: true
        });
        if (fs.existsSync(staging) && m.hash(staging) !== d.sha256) throw Error('restore staging hash mismatch');
        if (!fs.existsSync(staging)) fs.copyFileSync(path.join(j.dbBackupDir, d.file), staging);
        const fd = fs.openSync(staging, 'r');
        try {
          m.fsyncFd(fd);
        } finally {
          fs.closeSync(fd);
        }
        m.renameIntent(dir, j, action, staging, target, d.sha256);
      } else m.renameIntent(dir, j, action, staging, target, d.sha256);
      if (m.hash(target) !== d.sha256) throw Error('restored target verification failed');
    }
    if (fs.existsSync(target + '-wal') || fs.existsSync(target + '-shm')) throw Error('restored database has old sidecars');
    state.complete = true;
    m.update(dir, j);
  }
}
function terminalPending(dir, j, error) {
  // A failed final marker removal must never replay database compensation.
  // Recreate the pointer if unlink succeeded but its directory fsync failed.
  try { m.marker(j.zylosDir, dir, j); }
  catch (isolation) { error += '; maintenance marker: ' + isolation.message; }
  return {attempted:false, completed:false, stage:j.phase, error, recovery_required:true};
}
function validateReady(dir, j) {
  const restored = j.phase.startsWith('restored');
  let verified = false;
  try {
    m.update(dir, j, {
      phase: restored ? 'restored_verifying' : 'new_verifying'
    });
    m.start(j);
    m.verifyServices(j);
    // Normal startup may create missing DBs/write data: use current compatibility, never old hashes.
    const checked = m.preflight(dir, j, null);
    if (checked.success === false) throw Error(checked.error || 'started code/data incompatible');
    verified = true;
    m.update(dir, j, {
      phase: restored ? 'restored_complete' : 'upgrade_complete',
      terminalEvidence: {
        verified: true,
        kind: 'code_data_services'
      },
      cleanup: {
        complete: true,
        servicesRestored: true
      }
    });
    const cleanup = m.finishTerminal(dir, j);
    return {
      attempted: restored,
      completed: restored,
      stage: j.phase,
      recovery_required: false,
      ...cleanup
    };
  } catch (e) {
    const saved = m.transaction(j.zylosDir, dir);
    if (m.terminalValid(saved)) return terminalPending(dir, saved, e.message);
    if (verified) return fail(dir, saved, e.message);
    m.marker(j.zylosDir, dir, j);
    m.stop(j);
    if (restored) return fail(dir, j, e.message);
    m.update(dir, j, {
      phase: 'restoring',
      error: e.message
    });
    return null;
  }
}
function finalizerDescriptor(dir, j) {
  const d = m.read(path.join(dir, 'descriptor.json'));
  m.validateDescriptor(dir, j, d);
  return d;
}
function verifyFinalizerExit(dir, j) {
  for (const kind of ['installer', 'finalizer']) {
    const started = kind + 'Started',
      confirmed = kind + 'ExitConfirmed',
      unconfirmed = kind + 'ExitUnconfirmed';
    if (j[unconfirmed] || j[started] && !j[confirmed]) {
      const d = finalizerDescriptor(dir, j);
      for (const name of ['finalizer.cjs', 'maintenance.cjs']) {
        if (!d.hashes?.[name]) throw Error('missing trusted finalizer exit verification material: ' + name);
        m.privatePath(path.join(dir, name));
      }
      const result = require(path.join(dir, 'finalizer.cjs')).quiesce(dir, j, {
        terminate: false,
        kind
      });
      if (!result.confirmed) throw Error(result.error || kind + ' exit requires verification before resume');
      m.update(dir, j, {
        [unconfirmed]: false,
        [confirmed]: true
      });
    }
  }
}
function resume(dir, {
  hooks = {}
} = {}) {
  dir = path.resolve(dir);
  // Only use the first read to locate the deployment. Another controller may
  // complete or change the transaction before we acquire ownership.
  const guessed = m.read(path.join(dir, 'journal.json')),
    root = fs.realpathSync(guessed.zylosDir);
  const suppliedRoot = path.dirname(path.dirname(path.dirname(dir)));
  if (fs.realpathSync(suppliedRoot) !== root) throw Error('invalid transaction deployment root');
  m.privatePath(path.join(suppliedRoot, '.backup'), {
    directory: true,
    sharedParent: true
  });
  m.privatePath(path.dirname(dir), {
    directory: true
  });
  m.privatePath(dir, {
    directory: true
  });
  dir = fs.realpathSync(dir);
  if (path.dirname(dir) !== path.join(root, '.backup', 'self-upgrade')) throw Error('invalid transaction directory');
  const release = m.acquire(dir);
  let j;
  try {
    // Journal identity and phase are authoritative only while holding the
    // controller. Never restore using the pre-lock snapshot.
    j = m.transaction(root, dir);
    verifyFinalizerExit(dir, j);
    if (m.terminalValid(j)) {
      if (j.terminalServicesStopped) {
        m.start(j);
        m.verifyServices(j);
        m.update(dir, j, {terminalServicesStopped:false});
      }
      const cleanup = m.finishTerminal(dir, j);
      return {
        attempted: j.phase === 'restored_complete',
        completed: j.phase === 'restored_complete',
        stage: j.phase,
        recovery_required: false,
        ...cleanup
      };
    }
    if (j.phase === 'recovery_required') {
      if (!j.resumePhase) throw Error('no resumable stage');
      j.phase = j.resumePhase;
      m.update(dir, j);
    }
    if (j.installationIntent === false) {
      if (!['preparing', 'code_saved', 'stopping', 'offline', 'snapshot_saved', 'runner_saved', 'prepared', 'aborted_before_install'].includes(j.phase)) throw Error('unrecognized preinstall recovery phase: ' + j.phase);
      return abort(dir, j);
    }
    if (j.installationIntent !== true || !m.READY.has(j.phase) && !['installing', 'restoring'].includes(j.phase)) throw Error('unrecognized installed recovery phase: ' + j.phase);
    if (m.READY.has(j.phase)) {
      const result = validateReady(dir, j);
      if (result) return result;
    }
    m.marker(root, dir, j);
    m.stop(j);
    const d = m.read(path.join(dir, 'descriptor.json'));
    m.validateDescriptor(dir, j, d);
    const snapshot = validateSnapshot(dir, j);
    rescue(dir, j);
    restoreCore(dir, j);
    replaceDatabases(dir, j, snapshot);
    const checked = m.preflight(dir, j, snapshot);
    if (checked.success === false) throw Error(checked.error || 'restored preflight failed');
    m.update(dir, j, {
      phase: 'restored_data_ready'
    });
    return validateReady(dir, j);
  } catch (e) {
    // Invalid identity under the lock must not write through untrusted paths.
    if (!j || j.zylosDir !== root || j.transactionId !== path.basename(dir)) throw e;
    if (m.terminalValid(j)) return terminalPending(dir, j, e.message);
    return fail(dir, j, e.message);
  } finally {
    release();
  }
}
module.exports = {
  resume,
  abort,
  originalVerified,
  validateSnapshot,
  rescue,
  restoreCore,
  replaceDatabases,
  validateReady
};
if (require.main === module) {
  const args = process.argv.slice(2),
    i = args.indexOf('--transaction-dir');
  try {
    if (i < 0) throw Error('transaction directory required');
    const dir = path.resolve(args[i + 1]);
    const out = args[0] === 'status' ? m.read(path.join(dir, 'journal.json')) : resume(dir);
    process.stdout.write(JSON.stringify(out) + '\n');
    if (out.recovery_required) process.exitCode = 1;
  } catch (e) {
    process.stdout.write(JSON.stringify({
      recovery_required: true,
      error: e.message
    }) + '\n');
    process.exitCode = 1;
  }
}
