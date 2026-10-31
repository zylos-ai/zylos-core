'use strict';

// A detached child owns one process group. Keep confirmation independent of
// installed code, and never infer child exit merely from controller death.
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
function members(group) {
  const result = cp.spawnSync('ps', ['-eo', 'pid=,ppid=,pgid=,stat='], {
    encoding: 'utf8', timeout: 10000
  });
  if (result.error || result.status !== 0) throw Error('cannot verify installer process exit');
  const rows = result.stdout.split('\n').map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)$/)).filter(Boolean);
  const parents = new Map(rows.map(row => [Number(row[1]), Number(row[2])]));
  const observerProcess = pid => {
    const seen = new Set();
    while (Number.isSafeInteger(pid) && pid > 0 && !seen.has(pid)) {
      if (pid === result.pid) return true;
      seen.add(pid);
      pid = parents.get(pid);
    }
    return false;
  };
  return rows.filter(row => Number(row[3]) === group && !observerProcess(Number(row[1])) && !row[4].startsWith('Z'))
    .map(row => [row[0], row[1], row[3], row[4]]);
}
function quiesce(_dir, j, {terminate = false, kind = 'installer'} = {}) {
  if (kind !== 'installer') throw Error('unsupported contained process kind');
  if (j[kind+'ExitConfirmed'] && !j[kind+'ExitUnconfirmed'] || !j[kind+'Started'] && !j[kind+'ExitUnconfirmed']) return {confirmed:true};
  const pid = j[kind+'Pid'];
  if (!Number.isSafeInteger(pid) || pid <= 1) return {
    confirmed:false, error:kind+' exit cannot be confirmed after interrupted launch'
  };
  if (kind === 'installer' && !j.installerIdentity) return {confirmed:false,error:'installer process identity is missing'};
  if (kind === 'installer') {
    try {
      const current = members(pid);
      if (!current.length) return {confirmed:true};
      const m = require('./maintenance.cjs');
      const observed = m.identity(pid), saved = j.installerIdentity;
      const same = saved.pid === pid && !observed.unsupported && !observed.absent && observed.start === saved.start && observed.boot === saved.boot;
      if (!same) return {confirmed:false,error:'installer process identity changed or cannot be verified; manual recovery required'};
    } catch (error) { return {confirmed:false,error:error.message}; }
  }
  if (terminate) {
    try { process.kill(-pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') return {confirmed:false,error:error.message}; }
    // Give signalled descendants time to exit before the single ps snapshot.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,50);
  }
  try {
    return members(pid).length ? {confirmed:false,error:kind+' process group is still active'} : {confirmed:true};
  } catch (error) { return {confirmed:false,error:error.message}; }
}
module.exports = {members,quiesce};

if (require.main === module && process.argv[2] === 'installer') {
  try {
    const m = require('./maintenance.cjs');
    const dir = path.resolve(process.argv[3]);
    const j = m.read(path.join(dir, 'journal.json'));
    m.validateRecoveryFiles(dir, j, ['installer.cjs', 'maintenance.cjs']);
    if (!j.installerStarted || j.installerPid !== null) throw Error('installer launch identity rejected');
    const options = JSON.parse(fs.readFileSync(0, 'utf8'));
    m.privatePath(options.npmCli);
    if (!path.isAbsolute(options.npmCli) || path.basename(options.npmCli) !== 'npm-cli.js') throw Error('untrusted npm CLI');
    // The group leader publishes its identity durably before npm can write.
    m.update(dir, j, {installerPid:process.pid, installerIdentity:m.identity()});
    const result = cp.spawnSync(j.nodePath, [options.npmCli, ...options.args], {
      env:process.env, encoding:'utf8', stdio:['ignore','pipe','pipe'],
      timeout:options.timeout, killSignal:'SIGKILL', maxBuffer:4*1024*1024
    });
    // Keep the leader alive until all remaining members have been drained.
    for (const row of members(process.pid)) if (Number(row[1]) !== process.pid) {
      try {process.kill(Number(row[1]), 'SIGKILL');} catch (error) {if(error.code !== 'ESRCH') throw error;}
    }
    const deadline = Date.now() + 5000;
    while (members(process.pid).some(row => Number(row[1]) !== process.pid)) {
      if (Date.now() >= deadline) throw Error('installer descendants did not exit');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,25);
    }
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.error?.message || result.stderr || '');
    process.exitCode = result.error ? 1 : result.status ?? 1;
  } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
