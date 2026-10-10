import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
const helper = fileURLToPath(new URL('../../native/macos-recovery-helper', import.meta.url));
const native = (args, fd, options = {}) => cp.spawnSync(helper, args, {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe', fd ?? 'ignore'], ...options
});
const macTest = (name, fn) => test(name, { skip: process.platform !== 'darwin' }, fn);
const fixture = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-native-'));
  const guard = path.join(dir, 'guard');
  const script = path.join(dir, 'child.cjs');
  fs.writeFileSync(script, "require('fs').writeFileSync(process.argv[2], String(process.pid)); if(process.argv[3]) setInterval(()=>{},1000);\n");
  const fd = fs.openSync(guard, 'w+', 0o600);
  return { dir, guard, script, fd, marker: path.join(dir, 'started') };
};
const acquire = (f, fd = f.fd, wait = '50', extra = [], options = {}) => native(
  ['lock-exec', wait, process.execPath, f.script, f.marker, ...extra], fd, options);
macTest('probe and precise identity stable across independent queries', () => {
  assert.equal(JSON.parse(native(['probe']).stdout).protocol, 1);
  const a = JSON.parse(native(['identity', String(process.pid)]).stdout);
  const b = JSON.parse(native(['identity', String(process.pid)]).stdout);
  assert.equal(a.status, 'present'); assert.equal(a.pid, process.pid);
  assert.match(a.start, /^\d+:\d{6}$/); assert.deepEqual(a,b);
});
macTest('captured child identity becomes absent after exit; bad queries fail', async () => {
  const child = cp.spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
  assert.equal(JSON.parse(native(['identity',String(child.pid)]).stdout).status,'present');
  const exited = once(child,'exit'); child.kill('SIGTERM'); await exited;
  assert.equal(JSON.parse(native(['identity',String(child.pid)]).stdout).status,'absent');
  assert.equal(native(['identity','garbage']).status,64);
});
macTest('exec inherits lock; parent reference holds it after helper exit', () => {
  const f=fixture(); const inode=fs.statSync(f.guard).ino;
  try {
    assert.equal(acquire(f).status,0);
    const contender=fs.openSync(f.guard,'r+');
    try { assert.equal(acquire(f,contender).status,75); } finally { fs.closeSync(contender); }
  } finally { fs.closeSync(f.fd); }
  const next=fs.openSync(f.guard,'r+');
  try { assert.equal(acquire(f,next).status,0); assert.equal(fs.statSync(f.guard).ino,inode); }
  finally { fs.closeSync(next); }
});
macTest('timeout kills only exec child; close parent reference permits takeover', () => {
  const f=fixture();
  try {
    const result=acquire(f,f.fd,'50',['hold'],{ timeout:200 });
    assert.equal(result.error?.code,'ETIMEDOUT'); assert.equal(result.signal,'SIGTERM');
    const contender=fs.openSync(f.guard,'r+');
    try { assert.equal(acquire(f,contender).status,75); } finally { fs.closeSync(contender); }
  } finally { fs.closeSync(f.fd); }
  const next=fs.openSync(f.guard,'r+');
  try { assert.equal(acquire(f,next).status,0); } finally { fs.closeSync(next); }
});
macTest('failed exec retains lock until parent closes; unsafe guard denied', () => {
  const f=fixture();
  try {
    assert.equal(native(['lock-exec','50','/nonexistent/node',f.script],f.fd).status,1);
    const contender=fs.openSync(f.guard,'r+');
    try { assert.equal(acquire(f,contender).status,75); } finally { fs.closeSync(contender); }
    fs.fchmodSync(f.fd,0o666);
    assert.equal(acquire(f).status,1);
  } finally { fs.closeSync(f.fd); }
});
macTest('fullsync file and directory, invalid inherited descriptor fails closed', () => {
  const f=fixture();
  try { fs.writeSync(f.fd,'data'); assert.equal(native(['fullsync','3'],f.fd).status,0); }
  finally { fs.closeSync(f.fd); }
  const dirfd=fs.openSync(f.dir,'r');
  try { assert.equal(native(['fullsync','3'],dirfd).status,0); } finally { fs.closeSync(dirfd); }
  assert.equal(native(['fullsync','99']).status,1);
});
macTest('bounded lock wait arguments reject oversized and malformed requests', () => {
  const f=fixture();
  try {
    assert.equal(acquire(f,f.fd,'5001').status,64);
    assert.equal(acquire(f,f.fd,'-1').status,64);
    assert.equal(native(['lock-exec','0','relative',f.script],f.fd).status,1);
  } finally { fs.closeSync(f.fd); }
});
macTest('parent death preserves exec child lock until captured child death', async () => {
  const f=fixture(); fs.closeSync(f.fd);
  const wrapper=path.join(f.dir,'wrapper.cjs');
  fs.writeFileSync(wrapper, `const fs=require('fs'),cp=require('child_process');
const fd=fs.openSync(process.argv[3],'r+');
const c=cp.spawn(process.argv[2],['lock-exec','50',process.execPath,process.argv[4],process.argv[5],'hold'],{stdio:['ignore','ignore','ignore',fd]});
process.send({pid:c.pid}); setInterval(()=>{},1000);\n`);
  const parent=cp.fork(wrapper,[helper,f.guard,f.script,f.marker],{stdio:['ignore','ignore','ignore','ipc']});
  const [{pid}]=await once(parent,'message');
  const deadline=Date.now()+5000;
  while(!fs.existsSync(f.marker) && Date.now()<deadline) await new Promise(r=>setTimeout(r,10));
  assert.equal(Number(fs.readFileSync(f.marker,'utf8')),pid);
  const identity=JSON.parse(native(['identity',String(pid)]).stdout);
  const exited=once(parent,'exit'); parent.kill('SIGTERM'); await exited;
  const contender=fs.openSync(f.guard,'r+');
  try {
    assert.equal(acquire(f,contender).status,75);
    assert.deepEqual(JSON.parse(native(['identity',String(pid)]).stdout),identity);
    process.kill(pid,'SIGTERM');
    // Kernel drops last descriptor on child death; bounded wait acquires it.
    assert.equal(acquire(f,contender,'5000').status,0);
  } finally { fs.closeSync(contender); }
});
