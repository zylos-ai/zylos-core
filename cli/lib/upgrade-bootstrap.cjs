#!/usr/bin/env node
'use strict';

// Stable startup discovery: no C4, SQLite, npm or skill imports.
const fs = require('node:fs'), path = require('node:path');
const m = require('./maintenance.cjs');
function controllerState(candidate) {
  if (!m.canRecognizeProcesses()) return {alive:null, diagnostic:'controller liveness cannot be recognized; automatic resume is unavailable'};
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
      automaticResume: m.canRecognizeProcesses(),
      status: [process.execPath, path.join(root, '.zylos', 'upgrade', 'bootstrap.cjs'), '--root', root, '--status'],
      ...(!m.canRecognizeProcesses() ? {manualRecovery: 'Preserve transaction and snapshot materials. Confirm all writers stopped and code/schema compatibility before manual restoration; do not delete controller admission to force resume.'} : {resume: m.isClosedRecovery(d) ? ['zylos', 'upgrade', '--resume-finalize'] : ['zylos', 'recovery', 'resume']})
    };
  });
  const availability = d.blocked ? 'Normal C4/database access is unavailable during upgrade maintenance.' : 'Core database access is available. The interrupted upgrade still requires final validation or terminal cleanup; preserve legitimate business writes.';
  if (!m.canRecognizeProcesses()) return 'SYSTEM RECOVERY TASK: ' + availability + ' Run only the fixed file-only status entry. Interrupted live ownership requires manual recovery; do not run automatic resume, delete admission, or replace databases without confirming writer quiescence and code/schema compatibility. Preserve transaction and snapshot materials. Do not query C4.\n' + JSON.stringify({status:[process.execPath, path.join(root, '.zylos', 'upgrade', 'bootstrap.cjs'), '--root', root, '--status'], automaticResume:false, transactions:blocks, diagnostics}, null, 2);
  return 'SYSTEM RECOVERY TASK: ' + availability + ' Run the fixed file-only status entry now. If diagnostics prevent unique attribution, preserve isolation and report recovery_required; do not execute journal command strings or attempt database replacement. If a controller is alive, observe only. Otherwise use the verified resume entry and keep recovery isolated on error. Do not query C4.\n' + JSON.stringify({
    status: [process.execPath, path.join(root, '.zylos', 'upgrade', 'bootstrap.cjs'), '--root', root, '--status'],
    transactions: blocks,
    diagnostics
  }, null, 2);
}
function bootstrap(root, {
  once = false,
  status = false
} = {}) {
  root = path.resolve(root);
  let d, discoveryFailure;
  try {
    d = m.discover(root);
  } catch (error) {
    // Report diagnostics as bounded JSON data, never as executable instructions.
    discoveryFailure = m.recoveryFailureDetails(error);
    d = {
      marker: null,
      candidates: [],
      diagnostics: ['file-only upgrade discovery unavailable', discoveryFailure.error],
      blocked: true
    };
  }
  if (!d.candidates.length && !d.diagnostics.length) return {
    active: false
  };
  const invalid = d.diagnostics.length > 0 || d.candidates.length !== 1;
  const failure = discoveryFailure || (invalid ? m.recoveryFailureDetails(
    new Error(d.diagnostics.join('; ') || 'transaction attribution is not unique'), {next:m.recoveryNext(d)}) : null);
  const prompt = recoveryPrompt(root, d)+(failure ? '\n'+JSON.stringify(failure) : '');
  if (status) return {
    active: true,
    ...d,
    ...failure,
    prompt
  };
  const controller = !invalid ? controllerState(d.candidates[0]) : null;
  const out = {
    active: true,
    automaticResume: m.canRecognizeProcesses(),
    blocked: d.blocked,
    prompt,
    ...failure
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
    try {
      // This is the maintenance deployed beside this bootstrap. A frozen
      // transaction may predate the helper and its hashes must not change.
      const recovered = m.recoverBeforeUpgrade(root);
      return {active:false, resumed:recovered.active, ...recovered.result};
    } catch (error) {
      const details = m.recoveryFailureDetails(error);
      return {...out, ...details, prompt:prompt+'\n'+JSON.stringify(details)};
    }
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
      throw Error('Usage: bootstrap.cjs --root <directory> [--status]; use zylos recovery resume to continue; runtime startup uses the existing boot chain');
    }
    if (args.includes('--status') && args.includes('--once')) throw Error('Do not combine recovery execution with --status; use zylos recovery resume to continue.');
    const out = bootstrap(path.resolve(args[i + 1]), {
      once: args.includes('--once'), status: args.includes('--status')
    });
    process.stdout.write(JSON.stringify(out) + '\n');
    if (out.recovery_required) process.exitCode = 1;
  } catch (error) {
    process.stdout.write(JSON.stringify(m.recoveryFailureDetails(error)) + '\n');
    process.exitCode = 1;
  }
}
