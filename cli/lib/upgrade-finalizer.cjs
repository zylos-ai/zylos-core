'use strict';

// A detached child owns one process group. Keep confirmation independent of
// installed code, and never infer child exit merely from controller death.
const cp = require('node:child_process');
function members(group) {
  const result = cp.spawnSync('ps', ['-eo', 'pid=,pgid=,stat='], {
    encoding: 'utf8', timeout: 10000
  });
  if (result.error || result.status !== 0) throw Error('cannot verify finalizer process exit');
  return result.stdout.split('\n').map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)$/))
    .filter(Boolean).filter(row => Number(row[2]) === group && !row[3].startsWith('Z'));
}
function quiesce(_dir, j, {terminate = false, kind = 'finalizer'} = {}) {
  if (!['finalizer', 'installer'].includes(kind)) throw Error('unsupported contained process kind');
  if (j[kind+'ExitConfirmed'] && !j[kind+'ExitUnconfirmed'] || !j[kind+'Started'] && !j[kind+'ExitUnconfirmed']) return {confirmed:true};
  const pid = j[kind+'Pid'];
  if (!Number.isSafeInteger(pid) || pid <= 1) return {
    confirmed:false, error:kind+' exit cannot be confirmed after interrupted launch'
  };
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
