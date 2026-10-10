#!/usr/bin/env node
'use strict';

// Stable startup discovery: no C4, SQLite, npm or skill imports.
const fs = require('node:fs'),
  path = require('node:path'),
  cp = require('node:child_process'),
  os = require('node:os'),
  crypto = require('node:crypto');
const m = require('./maintenance.cjs');
function controllerState(candidate) {
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
const {
  validateRuntimeArgs,
  validateRuntimeNetworkEnv,
  validateRuntimePath
} = require('./runtime-args.cjs');
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
      status: [process.execPath, path.join(root, '.zylos', 'upgrade', 'bootstrap.cjs'), '--root', root, '--status'],
      resume: [process.execPath, path.join(root, '.zylos', 'upgrade', 'bootstrap.cjs'), '--root', root, '--once']
    };
  });
  const availability = d.blocked ? 'Normal C4/database access is unavailable during upgrade maintenance.' : 'Core database access is available. The interrupted upgrade still requires final validation or terminal cleanup; preserve legitimate business writes.';
  return 'SYSTEM RECOVERY TASK: ' + availability + ' Run the fixed file-only status entry now. If diagnostics prevent unique attribution, preserve isolation and report recovery_required; do not execute journal command strings or attempt database replacement. If a controller is alive, observe only. Otherwise use the verified resume entry and keep recovery isolated on error. Do not query C4.\n' + JSON.stringify({
    status: [process.execPath, path.join(root, '.zylos', 'upgrade', 'bootstrap.cjs'), '--root', root, '--status'],
    transactions: blocks,
    diagnostics
  }, null, 2);
}
function runtimeCapability(root) {
  const directory = path.join(root, '.zylos', 'upgrade');
  m.privatePath(directory, {
    directory: true
  });
  const file = path.join(directory, 'capability.json');
  const st = m.privatePath(file);
  if (st.mode & 0o077 || st.size > 16384) throw Error('runtime capability must be private and bounded');
  const cfg = m.read(file),
    r = cfg.runtime;
  if (cfg.formatVersion !== 1 || !['claude', 'codex'].includes(r?.kind) || typeof r.command !== 'string' || !path.isAbsolute(r.command) || path.basename(r.command) !== r.kind || r.cwd !== root || !Array.isArray(r.args) || r.args.length > 64 || r.args.some(a => typeof a !== 'string' || a.length > 4096 || /[\0\r\n]/.test(a))) throw Error('invalid saved runtime capability');
  validateRuntimeArgs(r.kind, r.args);
  validateRuntimeNetworkEnv(r.networkEnv);
  validateRuntimePath(r.path);
  const executable = fs.realpathSync(r.command),
    s = fs.statSync(executable);
  if (!s.isFile() || !(s.mode & 0o111) || s.mode & 0o022 || process.getuid && ![0, process.getuid()].includes(s.uid)) throw Error('unsafe runtime executable');
  return r;
}
function trustedTransport(file = '/usr/bin/tmux') {
  const real = fs.realpathSync(file),
    s = fs.statSync(real);
  if (!s.isFile() || !(s.mode & 0o111) || s.mode & 0o022 || process.getuid && ![0, process.getuid()].includes(s.uid)) throw Error('trusted PTY transport is unavailable');
  return file;
}
function shellWord(value) {
  return "'" + String(value).replaceAll("'", "'\\''") + "'";
}
function promptSignature(d) {
  const candidates = d.candidates.map(c => [c.journal.transactionId, controllerState(c).alive]).sort();
  return crypto.createHash('sha256').update(JSON.stringify({
    marker: d.marker?.transactionId,
    candidates,
    diagnostics: d.diagnostics.slice(0, 16).map(value => String(value).slice(0, 1024))
  })).digest('hex');
}
function bootstrap(root, {
  once = false,
  status = false,
  launchRuntime = false,
  onChild
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
    blocked: d.blocked,
    prompt,
    ...(invalid ? {
      recovery_required: true,
      error: d.diagnostics.join('; ').slice(0, 8192) || 'transaction attribution is not unique'
    } : {})
  };
  // A verified live controller already owns progress. Discovery remains
  // visible to status/startup callers, but never creates another runtime or
  // enters resume concurrently, including at READY and terminal cleanup.
  if (controller?.alive) return {
    ...out,
    observing: true,
    controllerAlive: true
  };
  // Invalid material must still reach an active agent. Only --once is denied:
  // neither diagnostics nor ambiguity authorize automatic recovery execution.
  if (once) {
    if (invalid) return out;
    const r = require('./recovery.cjs');
    return {
      active: true,
      ...r.resume(d.candidates[0].dir)
    };
  }
  if (launchRuntime) {
    // READY and verified terminal cleanup allow normal business writes. Their
    // cue belongs in ordinary startup context, not an extra boot-time runtime.
    if (!d.blocked && d.candidates[0]?.journal.installationIntent !== false) return {
      ...out,
      observing: true
    };
    const r = runtimeCapability(root);
    // Match the preinstall authentication probe: use persisted owner login,
    // excluding transient API credentials and alternate runtime config homes.
    const owner = os.userInfo();
    const env = {
      HOME: owner.homedir,
      USER: owner.username,
      LOGNAME: owner.username,
      PATH: validateRuntimePath(r.path),
      LANG: process.env.LANG || 'C.UTF-8',
      TERM: 'xterm-256color',
      ZYLOS_UPGRADE_PROMPT_DELIVERED: '1',
      ...validateRuntimeNetworkEnv(r.networkEnv)
    };
    // tmux provides both the PTY and terminal-query emulation that native TUIs
    // require. Its private fixed socket/session deduplicates live runtimes even
    // when a bootstrap process restarts. Control mode keeps a lifetime observer
    // attached without requiring a human terminal or login.
    const transport = trustedTransport(),
      socket = path.join(root, '.zylos', 'upgrade', 'runtime.sock');
    if (fs.existsSync(socket)) {
      const st = fs.lstatSync(socket);
      if (!st.isSocket() || st.isSymbolicLink() || process.getuid && st.uid !== process.getuid()) throw Error('unsafe recovery runtime socket');
    }
    const prefix = ['-S', socket, '-f', '/dev/null'];
    const observed = cp.spawnSync(transport, [...prefix, 'has-session', '-t', 'upgrade-recovery'], {
      cwd: root,
      env,
      stdio: 'ignore',
      timeout: 5000
    });
    if (observed.error) throw observed.error;
    const signature = promptSignature(d);
    if (observed.status === 0) {
      const query = cp.spawnSync(transport, [...prefix, 'show-option', '-qv', '-t', 'upgrade-recovery', '@core803-signature'], {
        cwd: root,
        env,
        encoding: 'utf8',
        timeout: 5000
      });
      if (query.error || query.status !== 0) throw Error('cannot inspect recovery runtime prompt identity');
      if (query.stdout.trim() === signature) return {
        ...out,
        observing: true
      };
      const send = (args, input) => {
        const result = cp.spawnSync(transport, [...prefix, ...args], {
          cwd: root,
          env,
          input,
          encoding: 'utf8',
          timeout: 5000
        });
        if (result.error || result.status !== 0) throw Error('cannot deliver updated recovery prompt');
      };
      // A buffer carries literal prompt bytes; send-keys receives only Enter.
      // Attribution/liveness changes trigger one cue, never each phase update.
      send(['load-buffer', '-b', 'core803-recovery', '-'], prompt);
      send(['paste-buffer', '-b', 'core803-recovery', '-d', '-t', 'upgrade-recovery']);
      send(['send-keys', '-t', 'upgrade-recovery', 'Enter']);
      send(['set-option', '-t', 'upgrade-recovery', '@core803-signature', signature]);
      return {
        ...out,
        observing: true,
        reprompted: true
      };
    }
    const command = 'exec ' + [r.command, ...r.args, prompt].map(shellWord).join(' ');
    const child = cp.spawn(transport, ['-C', ...prefix, 'new-session', '-s', 'upgrade-recovery', '-x', '120', '-y', '40', '-c', root, command, ';', 'set-option', '-t', 'upgrade-recovery', '@core803-signature', signature], {
      cwd: root,
      env,
      stdio: ['pipe', 'inherit', 'inherit'],
      detached: true
    });
    child.recoverySocket = socket;
    child.on('error', e => {
      process.stderr.write(e.message + '\n');
    });
    if (onChild) onChild(child);
    return {
      ...out,
      launched: true
    };
  }
  return out;
}
// Stay available after an initially idle boot and after runtime exit. One live
// child is observed at a time; a new session may receive the unfinished task.
function stopRecoveryRuntime(root, child) {
  const socket = path.join(path.resolve(root), '.zylos', 'upgrade', 'runtime.sock');
  if (fs.existsSync(socket)) {
    const stat = fs.lstatSync(socket);
    if (!stat.isSocket() || stat.isSymbolicLink() || process.getuid && stat.uid !== process.getuid()) {
      throw Error('unsafe recovery runtime socket');
    }
    cp.spawnSync(trustedTransport(), ['-S', socket, 'kill-session', '-t', 'upgrade-recovery'], {
      stdio: 'ignore',
      timeout: 5000
    });
  }
  if (!child) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
  const deadline = setTimeout(() => {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') process.stderr.write(error.message + '\n');
    }
  }, 5000);
  child.once('exit', () => clearTimeout(deadline));
}
function supervise(root, {
  intervalMs = 2000,
  write = out => process.stdout.write(JSON.stringify(out) + '\n')
} = {}) {
  let child = null;
  let stopped = false;
  let last = '';
  function tick() {
    if (stopped) return;
    try {
      const out = bootstrap(root, {
        launchRuntime: true,
        onChild: current => {
          child = current;
          current.once('exit', () => {
            if (child === current) child = null;
          });
          current.once('error', () => {
            if (child === current) child = null;
          });
        }
      });
      if (!out.active) {
        stopRecoveryRuntime(root, child);
        child = null;
      }
      const key = JSON.stringify(out);
      if (key !== last || out.launched) {
        write(out);
        last = key;
      }
    } catch (error) {
      const out = {
        recovery_required: true,
        error: error.message
      };
      const key = JSON.stringify(out);
      if (key !== last) {
        write(out);
        last = key;
      }
    }
  }
  const timer = setInterval(tick, intervalMs);
  tick();
  return () => {
    stopped = true;
    clearInterval(timer);
    stopRecoveryRuntime(root, child);
    child = null;
  };
}
module.exports = {
  bootstrap,
  recoveryPrompt,
  runtimeCapability,
  trustedTransport,
  supervise
};
if (require.main === module) {
  const args = process.argv.slice(2),
    i = args.indexOf('--root');
  try {
    if (i < 0 || !args[i + 1]) throw Error('--root is required');
    const root = path.resolve(args[i + 1]);
    if (args.includes('--launch-runtime') && !args.includes('--status') && !args.includes('--once')) {
      const stop = supervise(root);
      for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
        stop();
        process.exitCode = 0;
      });
    } else {
      const out = bootstrap(root, {
        once: args.includes('--once'),
        status: args.includes('--status')
      });
      process.stdout.write(JSON.stringify(out) + '\n');
      if (out.recovery_required) process.exitCode = 1;
    }
  } catch (e) {
    process.stdout.write(JSON.stringify({
      recovery_required: true,
      error: e.message
    }) + '\n');
    process.exitCode = 1;
  }
}
