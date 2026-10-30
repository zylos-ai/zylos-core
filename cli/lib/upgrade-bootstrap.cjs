#!/usr/bin/env node
'use strict';

// Stable startup discovery: no C4, SQLite, npm or skill imports.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process'), crypto = require('node:crypto');
const m = require('./maintenance.cjs');
function automaticResumeAvailable() {
  return process.platform === 'linux' && m.platformSupported();
}
function controllerState(candidate) {
  if (!automaticResumeAvailable()) return {alive:null, diagnostic:'controller liveness cannot be established; automatic resume is unavailable'};
  try {
    const file = path.join(candidate.dir, 'controller.json');
    return {
      alive: fs.existsSync(file) && m.alive(m.read(file))
    };
  } catch (error) {
    return {
      alive: false,
      diagnostic: 'controller identity unavailable: ' + error.message
    };
  }
}
function recoveryPrompt(root, d) {
  const diagnostics = d.diagnostics.slice(0, 16).map(value => String(value).slice(0, 1024));
  if (d.diagnostics.length > 16) diagnostics.push('additional diagnostics omitted; run fixed status entry for full results');
  const blocks = d.candidates.slice(0, 8).map(c => {
    const j = c.journal;
    const controller = controllerState(c);
    if (controller.diagnostic) diagnostics.push(controller.diagnostic);
    const controllerAlive = controller.alive;
    return {
      transactionId: j.transactionId,
      phase: String(j.phase).slice(0, 128),
      lastDurableStep: String(j.updatedAt || '').slice(0, 128),
      materials: c.dir,
      controllerAlive,
      automaticResume: automaticResumeAvailable(),
      status: [process.execPath, path.join(root, '.zylos', 'upgrade', 'bootstrap.cjs'), '--root', root, '--status'],
      ...(!automaticResumeAvailable() ? {manualRecovery: 'Preserve transaction and snapshot materials. Confirm all writers stopped and code/schema compatibility before manual restoration; do not delete controller admission to force resume.'} : {resume: [process.execPath, path.join(root, '.zylos', 'upgrade', 'bootstrap.cjs'), '--root', root, '--once']})
    };
  });
  const availability = d.blocked ? 'Normal C4/database access is unavailable during upgrade maintenance.' : 'Core database access is available. The interrupted upgrade still requires final validation or terminal cleanup; preserve legitimate business writes.';
  if (!automaticResumeAvailable()) return 'SYSTEM RECOVERY TASK: ' + availability + ' Run only the fixed file-only status entry. Interrupted upgrade ownership cannot be established on this platform; do not run automatic resume, delete admission, or replace databases without confirming writer quiescence and code/schema compatibility. Preserve transaction and snapshot materials. Do not query C4.\n' + JSON.stringify({status:[process.execPath, path.join(root, '.zylos', 'upgrade', 'bootstrap.cjs'), '--root', root, '--status'], automaticResume:false, transactions:blocks, diagnostics}, null, 2);
  return 'SYSTEM RECOVERY TASK: ' + availability + ' Run the fixed file-only status entry now. If diagnostics prevent unique attribution, preserve isolation and report recovery_required; do not execute journal command strings or attempt database replacement. If a controller is alive, observe only. Otherwise use the verified resume entry and keep recovery isolated on error. Do not query C4.\n' + JSON.stringify({
    status: [process.execPath, path.join(root, '.zylos', 'upgrade', 'bootstrap.cjs'), '--root', root, '--status'],
    transactions: blocks,
    diagnostics
  }, null, 2);
}
function validateFrozenRunner(candidate) {
  const dir = path.resolve(candidate.dir), j = candidate.journal;
  const names = ['runner.cjs', 'maintenance.cjs', 'installer.cjs'];
  const hashes = j.recoveryHashes;
  if (!hashes || Array.isArray(hashes) || Object.keys(hashes).length !== names.length ||
      names.some(name => !Object.hasOwn(hashes, name) || !/^[a-f0-9]{64}$/.test(hashes[name]))) {
    throw Error('missing required frozen recovery hashes');
  }
  m.privatePath(dir, {directory: true});
  for (const name of names) {
    const file = path.join(dir, name);
    m.privatePath(file);
    const actual = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    if (actual !== hashes[name]) throw Error('frozen recovery material hash mismatch: ' + name);
  }

  const descriptorFile = path.join(dir, 'descriptor.json');
  if (fs.existsSync(descriptorFile)) {
    const descriptor = m.read(descriptorFile);
    const closure = path.join(dir, 'sqlite-runtime');
    const fixed = {
      runnerPath: path.join(dir, 'runner.cjs'),
      driverClosureRoot: closure,
      workerPath: path.join(closure, 'core-db-backup-worker.js'),
      driverPath: path.join(closure, 'node_modules', 'better-sqlite3', 'lib', 'index.js')
    };
    if (descriptor.formatVersion !== 1 || descriptor.transactionId !== j.transactionId ||
        descriptor.nodePath !== j.nodePath || typeof descriptor.nodePath !== 'string' || !path.isAbsolute(descriptor.nodePath)) {
      throw Error('invalid frozen recovery descriptor');
    }
    for (const [key, value] of Object.entries(fixed)) {
      if (descriptor[key] !== value) throw Error('frozen recovery material outside fixed layout: ' + key);
    }
    if (!descriptor.hashes || Array.isArray(descriptor.hashes) ||
        Object.keys(descriptor.hashes).length !== names.length ||
        names.some(name => descriptor.hashes[name] !== hashes[name])) {
      throw Error('frozen recovery descriptor hash mismatch');
    }
  }
  return path.join(dir, 'runner.cjs');
}
function runFrozenRunner(root, candidate) {
  const runner = validateFrozenRunner(candidate);
  const child = cp.spawnSync(process.execPath, [runner, 'resume', '--transaction-dir', candidate.dir], {
    stdio: 'inherit'
  });
  if (child.error || child.status !== 0) {
    return {
      active: true,
      recovery_required: true,
      code: 'UPGRADE_RECOVERY_REQUIRED',
      error: child.error?.message || `frozen upgrade runner exited ${child.status ?? 'after a signal'}`,
      next: 'zylos recovery status'
    };
  }
  const after = m.discover(root);
  if (after.candidates.length || after.diagnostics.length || after.marker) {
    return {
      active: true,
      recovery_required: true,
      code: 'UPGRADE_RECOVERY_REQUIRED',
      error: after.diagnostics.join('; ') || 'upgrade recovery did not reach a clean terminal state',
      next: 'zylos recovery status'
    };
  }
  return {active:false, resumed:true};
}
function bootstrap(root, {
  once = false,
  status = false
} = {}) {
  root = path.resolve(root);
  let d;
  try {
    d = once || status ? m.discover(root) : m.discoverActive(root);
  } catch {
    // File discovery failures preserve isolation and still reach an agent.
    // Do not interpolate exception text from untrusted material into a cue.
    d = {
      marker: null,
      candidates: [],
      diagnostics: ['file-only upgrade discovery unavailable'],
      blocked: true
    };
  }
  if (!d.candidates.length && !d.diagnostics.length) return {
    active: false
  };
  const prompt = recoveryPrompt(root, d);
  if (status) return {
    active: true,
    ...d,
    prompt
  };
  const invalid = d.diagnostics.length > 0 || d.candidates.length !== 1;
  const controller = !invalid ? controllerState(d.candidates[0]) : null;
  const out = {
    active: true,
    automaticResume: automaticResumeAvailable(),
    blocked: d.blocked,
    prompt,
    ...(invalid ? {
      recovery_required: true,
      error: d.diagnostics.join('; ').slice(0, 8192) || 'transaction attribution is not unique'
    } : {})
  };
  // A verified live controller already owns progress. Discovery remains
  // visible to status/startup callers, but never enters resume concurrently, including at READY and terminal cleanup.
  if (controller?.alive) return {
    ...out,
    observing: true,
    controllerAlive: true
  };
  // Invalid material remains visible to the runtime startup adapter. --once is denied:
  // neither diagnostics nor ambiguity authorize automatic recovery execution.
  if (once) {
    if (invalid) return out;
    if (!automaticResumeAvailable()) return {...out, recovery_required:true, code:'MANUAL_RECOVERY_REQUIRED', error:'interrupted upgrade requires manual recovery; automatic resume is unavailable', next:'zylos recovery status'};
    try { return runFrozenRunner(root, d.candidates[0]); }
    catch (error) { return {...out, recovery_required:true, code:'UPGRADE_RECOVERY_REQUIRED', error:error.message, next:'zylos recovery status'}; }
  }
  return out;
}
module.exports = { bootstrap, recoveryPrompt };
if (require.main === module) {
  const args = process.argv.slice(2), i = args.indexOf('--root');
  try {
    if (i < 0 || !args[i + 1]) throw Error('--root is required');
    const allowed = new Set(['--status', '--once']);
    if (args.some((arg, index) => index !== i && index !== i + 1 && !allowed.has(arg))) {
      throw Error('Usage: bootstrap.cjs --root <directory> [--status | --once]; runtime startup uses the existing boot chain');
    }
    if (args.includes('--status') && args.includes('--once')) throw Error('select either --status or --once');
    const out = bootstrap(path.resolve(args[i + 1]), {
      once: args.includes('--once'), status: args.includes('--status')
    });
    process.stdout.write(JSON.stringify(out) + '\n');
    if (out.recovery_required) process.exitCode = 1;
  } catch (error) {
    process.stdout.write(JSON.stringify({ recovery_required: true, error: error.message }) + '\n');
    process.exitCode = 1;
  }
}
