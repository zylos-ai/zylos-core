#!/usr/bin/env node
'use strict';

// Stable startup discovery: no C4, SQLite, npm or skill imports.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const m = require('./maintenance.cjs');
const manualCompletionCode = 'UPGRADE_MANUAL_COMPLETION_REQUIRED';
const manualCompletionNext = 'docs/self-upgrade-recovery.md#manual-forward-repair-after-the-cutoff';
function needsManualCompletion(j) {
  return m.classifyCutoff(j) === 'closed' && !m.terminalValid(j);
}
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
    const manualCompletion = needsManualCompletion(j);
    return {
      transactionId: j.transactionId,
      phase: String(j.phase).slice(0, 128),
      lastDurableStep: String(j.updatedAt || '').slice(0, 128),
      materials: c.dir,
      controllerAlive,
      automaticResume: automaticResumeAvailable() && !manualCompletion,
      status: [process.execPath, path.join(root, '.zylos', 'upgrade', 'bootstrap.cjs'), '--root', root, '--status'],
      ...(manualCompletion ? {code:manualCompletionCode, next:manualCompletionNext, manualRecovery:'Complete and verify the target deployment manually; automatic resume cannot finish this transaction.'} : !automaticResumeAvailable() ? {manualRecovery: 'Preserve transaction and snapshot materials. Confirm all writers stopped and code/schema compatibility before manual restoration; do not delete controller admission to force resume.'} : {resume: [process.execPath, path.join(root, '.zylos', 'upgrade', 'bootstrap.cjs'), '--root', root, '--once']})
    };
  });
  const availability = d.blocked ? 'Normal C4/database access is unavailable during upgrade maintenance.' : 'Core database access is available. The interrupted upgrade still requires final validation or terminal cleanup; preserve legitimate business writes.';
  if (!automaticResumeAvailable()) return 'SYSTEM RECOVERY TASK: ' + availability + ' Run only the fixed file-only status entry. Interrupted upgrade ownership cannot be established on this platform; do not run automatic resume, delete admission, or replace databases without confirming writer quiescence and code/schema compatibility. Preserve transaction and snapshot materials. Do not query C4.\n' + JSON.stringify({status:[process.execPath, path.join(root, '.zylos', 'upgrade', 'bootstrap.cjs'), '--root', root, '--status'], automaticResume:false, transactions:blocks, diagnostics}, null, 2);
  return 'SYSTEM RECOVERY TASK: ' + availability + ' Run the fixed file-only status entry now. If diagnostics prevent unique attribution, preserve isolation and report recovery_required; do not execute journal command strings or attempt database replacement. If a controller is alive, observe only. Otherwise use a verified resume entry only when one is provided; transactions past the compensation cutoff require the documented manual completion procedure. Keep recovery isolated on error. Do not query C4.\n' + JSON.stringify({
    status: [process.execPath, path.join(root, '.zylos', 'upgrade', 'bootstrap.cjs'), '--root', root, '--status'],
    transactions: blocks,
    diagnostics
  }, null, 2);
}
function validateFrozenRunner(root, candidate) {
  const dir = path.resolve(candidate.dir), j = candidate.journal;
  if (j.installationIntent && !m.terminalValid(j)) {
    const descriptor = m.read(path.join(dir, 'descriptor.json'));
    m.validateDescriptor(dir, j, descriptor);
    return descriptor.runnerPath;
  }
  const runner = path.join(root, '.zylos', 'upgrade', 'recovery.cjs');
  m.privatePath(runner);
  return runner;
}
function runFrozenRunner(root, candidate) {
  const runner = validateFrozenRunner(root, candidate);
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
  const invalid = d.diagnostics.length > 0 || d.candidates.length !== 1;
  const controller = !invalid ? controllerState(d.candidates[0]) : null;
  const out = {
    active: true,
    ...(status ? d : {}),
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
  if (controller?.diagnostic) return {
    ...out,
    recovery_required: true,
    automaticResume: false,
    error: controller.diagnostic + '; manual recovery required',
    ...(!automaticResumeAvailable() ? {code:'MANUAL_RECOVERY_REQUIRED', next:'zylos recovery status'} : {})
  };
  if (!invalid && needsManualCompletion(d.candidates[0].journal)) return {
    ...out,
    recovery_required: true,
    automaticResume: false,
    code: manualCompletionCode,
    error: 'compensation is closed; complete and verify the target deployment manually',
    next: manualCompletionNext
  };
  if (!invalid && m.classifyCutoff(d.candidates[0].journal) === 'untrusted') return {
    ...out,
    recovery_required: true,
    code: 'UPGRADE_RECOVERY_REQUIRED',
    error: 'untrusted compensation cutoff; manual recovery required',
    next: 'zylos recovery status'
  };
  if (status) return out;
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
