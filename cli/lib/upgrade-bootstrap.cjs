#!/usr/bin/env node
'use strict';

// Stable startup discovery: no C4, SQLite, npm or skill imports.
const fs = require('node:fs'), path = require('node:path');
const m = require('./maintenance.cjs');
function controllerState(candidate) {
  if (process.platform === 'darwin') return {alive:null, diagnostic:'macOS controller liveness is not inferred; automatic resume is unavailable'};
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
      automaticResume: process.platform !== 'darwin',
      status: [process.execPath, path.join(root, '.zylos', 'upgrade', 'bootstrap.cjs'), '--root', root, '--status'],
      ...(process.platform === 'darwin' ? {manualRecovery: 'Preserve transaction and snapshot materials. Confirm all writers stopped and code/schema compatibility before manual restoration; do not delete controller admission to force resume.'} : {resume: [process.execPath, path.join(root, '.zylos', 'upgrade', 'bootstrap.cjs'), '--root', root, '--once']})
    };
  });
  const availability = d.blocked ? 'Normal C4/database access is unavailable during upgrade maintenance.' : 'Core database access is available. The interrupted upgrade still requires final validation or terminal cleanup; preserve legitimate business writes.';
  if (process.platform === 'darwin') return 'SYSTEM RECOVERY TASK: ' + availability + ' Run only the fixed file-only status entry. Interrupted macOS ownership requires manual recovery; do not run automatic resume, delete admission, or replace databases without confirming writer quiescence and code/schema compatibility. Preserve transaction and snapshot materials. Do not query C4.\n' + JSON.stringify({status:[process.execPath, path.join(root, '.zylos', 'upgrade', 'bootstrap.cjs'), '--root', root, '--status'], automaticResume:false, transactions:blocks, diagnostics}, null, 2);
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
  let d;
  try {
    d = m.discover(root);
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
    automaticResume: process.platform !== 'darwin',
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
    if (process.platform === 'darwin') return {...out, recovery_required:true, error:'interrupted macOS upgrade requires manual recovery; automatic resume is unavailable'};
    const r = require('./recovery.cjs');
    return {
      active: true,
      ...r.resume(d.candidates[0].dir)
    };
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
