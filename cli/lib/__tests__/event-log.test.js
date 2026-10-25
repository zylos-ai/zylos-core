import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { appendEvent, rotateEventLog, EventLogReader } from '../event-log.js';
function fixture(t) {const dir=fs.mkdtempSync(path.join(os.tmpdir(),'event-log-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return path.join(dir,'events.jsonl');}
test('IF-31: reader finishes old inode, intermediate rotations, then current exactly once',t=>{
 const file=fixture(t), reader=new EventLogReader(file);t.after(()=>reader.close());
 appendEvent(file,{v:1,n:1});assert.deepEqual(reader.read().map(x=>x.n),[1]);
 appendEvent(file,{v:1,n:2});rotateEventLog(file,{maxBytes:0,now:100});
 appendEvent(file,{v:1,n:3});rotateEventLog(file,{maxBytes:0,now:100});
 appendEvent(file,{v:1,n:4});assert.deepEqual(reader.read().map(x=>x.n),[2,3,4]);assert.deepEqual(reader.read(),[]);
});
test('IF-31: incomplete lines wait, malformed complete lines warn, future fields survive',t=>{
 const file=fixture(t),warnings=[],reader=new EventLogReader(file,{warn:x=>warnings.push(x)});t.after(()=>reader.close());
 fs.writeFileSync(file,'{"v":1,"n":');assert.deepEqual(reader.read(),[]);
 fs.appendFileSync(file,'1}\nBAD\n{"v":2,"n":2,"future":true}\n');assert.deepEqual(reader.read().map(x=>x.n),[1,2]);assert.deepEqual(warnings,['event_log_invalid_line','event_log_new_version']);
});
test('IF-31: directory disappearance drains retained fd without fabricating events',t=>{
 const file=fixture(t),reader=new EventLogReader(file);t.after(()=>reader.close());appendEvent(file,{n:1});reader.read();appendEvent(file,{n:2});
 fs.rmSync(path.dirname(file),{recursive:true});assert.deepEqual(reader.read(),[{n:2}]);assert.deepEqual(reader.read(),[]);
});
test('DM-38: append and rename preserve complete long records and monotonic names',t=>{
 const file=fixture(t),reader=new EventLogReader(file);t.after(()=>reader.close());const payload='多'.repeat(50000);
 appendEvent(file,{n:1,payload});const first=rotateEventLog(file,{maxBytes:1,now:200});appendEvent(file,{n:2,payload});const second=rotateEventLog(file,{maxBytes:1,now:100});
 assert.match(first,/events\.200\.jsonl$/);assert.match(second,/events\.201\.jsonl$/);assert.deepEqual(reader.read(),[{n:1,payload},{n:2,payload}]);
});

test('DM-38: actual write-limit error truncates partial append back to locked length',async t=>{
 const {spawn}=await import('node:child_process');const {fileURLToPath}=await import('node:url');
 const file=fixture(t);appendEvent(file,{n:1});const before=fs.readFileSync(file);
 const helper=fileURLToPath(new URL('../locked-jsonl.pl',import.meta.url));
 const result=await new Promise(resolve=>{
  const child=spawn('bash',['-c',"trap '' XFSZ; ulimit -f 1; exec perl \"$1\" append \"$2\"",'write-limit',helper,file],{stdio:['pipe','ignore','pipe']});let error='';
  child.stderr.on('data',chunk=>{error+=chunk;});child.stdin.on('error',()=>{});child.on('close',code=>resolve({code,error}));child.stdin.end(JSON.stringify({payload:'x'.repeat(32768)})+'\n');
 });
 assert.notEqual(result.code,0);assert.match(result.error,/write:/);assert.deepEqual(fs.readFileSync(file),before);
});

test('DM-38: two real writers each append 10000 long lines during rotations',async t=>{
 const {spawn}=await import('node:child_process');const file=fixture(t);
 const worker=`import {appendEvent} from ${JSON.stringify(new URL('../event-log.js',import.meta.url).href)};for(let n=0;n<10000;n++)appendEvent(process.argv[1],{writer:process.argv[2],n,payload:'x'.repeat(8192)});`;
 const run=writer=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,['--input-type=module','-e',worker,file,writer],{stdio:['ignore','ignore','pipe']});let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;});child.on('error',reject);child.on('close',code=>code===0?resolve():reject(Error(stderr)));});
 const timer=setInterval(()=>rotateEventLog(file,{maxBytes:1024*1024}),100);
 try{await Promise.all([run('a'),run('b')]);}finally{clearInterval(timer);}
 const warnings=[],reader=new EventLogReader(file,{warn:x=>warnings.push(x)});t.after(()=>reader.close());const rows=reader.read();
 assert.equal(rows.length,20000,JSON.stringify(fs.readdirSync(path.dirname(file)).map(name=>({name,size:fs.statSync(path.join(path.dirname(file),name)).size}))) );assert.equal(new Set(rows.map(row=>`${row.writer}:${row.n}`)).size,20000);assert.deepEqual(warnings,[]);
});

test('DM-38 regression: maintenance never treats current filename as rotation timestamp zero',t=>{
 const file=fixture(t);appendEvent(file,{n:1});rotateEventLog(file,{maxBytes:1024,now:1700000000000});assert.equal(fs.existsSync(file),true);
 const reader=new EventLogReader(file);t.after(()=>reader.close());assert.deepEqual(reader.read(),[{n:1}]);
});

test('T08 recovery: backward UTF-8 chunk scan stops at boundary and resumes partial/current rotation once',t=>{
 const file=fixture(t),reader=new EventLogReader(file);t.after(()=>reader.close());
 appendEvent(file,{n:0});rotateEventLog(file,{maxBytes:0,now:100});
 appendEvent(file,{n:1});appendEvent(file,{n:2,payload:'多'.repeat(30000)});fs.appendFileSync(file,'{"n":');
 let visited=0;const rows=reader.recoverTail(row=>{visited++;return {keep:true,done:row.n===1};});
 assert.deepEqual(rows.map(row=>row.n),[1,2]);assert.equal(rows[1].payload,'多'.repeat(30000));assert.equal(visited,2);
 fs.appendFileSync(file,'3}\n');rotateEventLog(file,{maxBytes:0,now:101});appendEvent(file,{n:4});
 assert.deepEqual(reader.read().map(row=>row.n),[3,4]);assert.deepEqual(reader.read(),[]);
});

// Instrument the current production helper, preserving its actual lock and inode
// check. Each process pauses once on fd 3; retrying after rotation never pauses.
const openAnchor = '  sysopen(my $fh,$file,O_WRONLY|O_APPEND|O_CREAT,0600) or die "open: $!\\n";';
const lockAnchor = '  flock($fh,LOCK_EX) or die "lock: $!\\n";';
const inodeAnchor = '  if (!@current || $opened[0]!=$current[0] || $opened[1]!=$current[1]) { close($fh); next; }';
function replaceOnce(source, anchor, replacement) {
 assert.equal(source.split(anchor).length, 2, `helper anchor must occur once: ${anchor}`);
 return source.replace(anchor, replacement);
}
function barrierHelper(file, mutation = 'none') {
 let source = fs.readFileSync(new URL('../locked-jsonl.pl', import.meta.url), 'utf8');
 source = replaceOnce(source, 'while (1) {', `my $paused=0;
sub barrier {
  my ($point)=@_;
  return if $paused || $ENV{TEST_BARRIER} ne $point;
  $paused=1;
  open(my $control,"+<&=3") or die "barrier open: $!\\n";
  syswrite($control,"ready\\n",6)==6 or die "barrier write: $!\\n";
  my $ack; sysread($control,$ack,1)==1 or die "barrier read: $!\\n";
}
while (1) {`);
 source = replaceOnce(source, openAnchor, openAnchor + '\n  barrier("open");');
 source = replaceOnce(source, lockAnchor, lockAnchor + '\n  barrier("lock");');
 if (mutation === 'no-lock') source = replaceOnce(source, lockAnchor, '  # lock removed by negative control');
 if (mutation === 'no-inode-check') source = replaceOnce(source, inodeAnchor, '  # inode check removed by negative control');
 const helper = path.join(path.dirname(file), `helper-${mutation}.pl`);
 fs.writeFileSync(helper, source);
 return helper;
}
function pausedHelper(helper, operation, file, point, input = '') {
 const child = spawn('perl', [helper, operation, file, '100', '0'], {
  env: { ...process.env, TEST_BARRIER: point }, stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
 });
 let stdout = '', stderr = '', spawnError, timedOut = false;
 const watchdog = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 15000);
 child.stdout.on('data', chunk => { stdout += chunk; });
 child.stderr.on('data', chunk => { stderr += chunk; });
 child.stdin.on('error', () => {});
 child.stdio[3].on('error', () => {});
 child.on('error', error => { spawnError = error; });
 const done = new Promise(resolve => child.once('close', (code, signal) => {
  clearTimeout(watchdog); resolve({ code, signal });
 }));
 const ready = new Promise((resolve, reject) => {
  let data = '';
  const timer = setTimeout(() => reject(Error(`helper barrier timeout: ${stderr}`)), 10000);
  const finish = error => { clearTimeout(timer); error ? reject(error) : resolve(); };
  child.stdio[3].on('data', chunk => { data += chunk; if (data === 'ready\n') finish(); });
  done.then(() => finish(Error(`helper exited before barrier: ${spawnError || stderr}`)));
 });
 child.stdin.end(input);
 return {
  ready,
  release() { child.stdio[3].write('x'); },
  async finish() { const result = await done; assert.equal(timedOut, false, 'helper completion timeout'); assert.equal(result.code, 0, `${spawnError || stderr} (${result.signal})`); return stdout.trim(); },
  async stop() { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await done; },
 };
}
function probeLock(file) {
 return execFileSync('perl', ['-MFcntl=:DEFAULT,:flock', '-MErrno=EAGAIN,EWOULDBLOCK', '-e',
  'sysopen(my $fh,$ARGV[0],O_WRONLY) or die "open: $!"; if(flock($fh,LOCK_EX|LOCK_NB)){print "available"}elsif($! == EAGAIN || $! == EWOULDBLOCK){print "held"}else{die "lock: $!"}', file],
 { encoding: 'utf8', timeout: 10000 });
}
async function assertRealLock(file, mutation) {
 appendEvent(file, { n: 1 });
 const child = pausedHelper(barrierHelper(file, mutation), 'append', file, 'lock', '{"n":2}\n');
 try {
  await child.ready;
  assert.equal(probeLock(file), 'held', 'actual helper must hold the exclusive lock before writing');
  child.release(); await child.finish();
  assert.equal(probeLock(file), 'available');
  assert.equal(fs.readFileSync(file, 'utf8'), '{"n":1}\n{"n":2}\n');
 } finally { await child.stop(); }
}
async function assertReopenAfterRotation(file, mutation) {
 appendEvent(file, { n: 1 });
 const helper = barrierHelper(file, mutation);
 const rotator = pausedHelper(helper, 'rotate', file, 'lock');
 let appender;
 try {
  await rotator.ready;
  appender = pausedHelper(helper, 'append', file, 'open', '{"n":2}\n');
  await appender.ready; // Its fd now references the inode the rotator has locked.
  rotator.release();
  const rotated = await rotator.finish();
  assert.equal(rotated, file.replace(/\.jsonl$/, '.100.jsonl'));
  appender.release(); await appender.finish();
  assert.equal(fs.readFileSync(rotated, 'utf8'), '{"n":1}\n', 'append must not land on the rotated inode');
  assert.equal(fs.readFileSync(file, 'utf8'), '{"n":2}\n');
 } finally { if (appender) await appender.stop(); await rotator.stop(); }
}

test('DM-38: real helper excludes competing lock; removing its flock fails the same assertion', async t => {
 await assertRealLock(fixture(t), 'none');
 await assert.rejects(assertRealLock(fixture(t), 'no-lock'), {
  code: 'ERR_ASSERTION', message: /actual helper must hold the exclusive lock/,
 });
});

test('DM-38: real helper reopens after locked rotation; removing inode check fails the same assertion', async t => {
 await assertReopenAfterRotation(fixture(t), 'none');
 await assert.rejects(assertReopenAfterRotation(fixture(t), 'no-inode-check'), {
  code: 'ERR_ASSERTION', message: /append must not land on the rotated inode/,
 });
});
