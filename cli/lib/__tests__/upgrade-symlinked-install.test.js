import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {serviceRestartFixture} from './helpers/service-restart-fixture.js';
const m = createRequire(import.meta.url)('../upgrade-maintenance.cjs');

// The journal records the real install path (the upgrade entry resolves
// ZYLOS_DIR), while PM2 and ps keep the path a process was launched with.
function symlinkedInstall(t) {
  const f = serviceRestartFixture(t);
  const link = path.join(f.root, 'linked-zylos');
  fs.symlinkSync(f.env.ZYLOS_DIR, link);
  const linked = file => path.join(link, path.relative(f.env.ZYLOS_DIR, file));
  assert.equal(fs.realpathSync(linked(f.scripts.scheduler)), f.scripts.scheduler);
  assert.ok(!linked(f.scripts.scheduler).includes(f.env.ZYLOS_DIR));
  return {...f, link, linked};
}
function online(f, script) {
  return ['scheduler', 'custom-service'].map(name => ({name, pid:123, pm2_env:{status:'online', pm_exec_path:script(name)}}));
}

// Starts a known one-shot writer through `script` and waits until it runs.
// An intermediate process owns and reaps the writer, so the writer's exit is
// observable while the synchronous stop path blocks this test's event loop.
// The writer records completion in `done` just before it exits.
async function startWriter(t, f, script, lifetimeMs = 1500) {
  const real = path.join(f.skillsDir, 'comm-bridge', 'scripts', 'c4-send.js');
  fs.mkdirSync(path.dirname(real), {recursive:true});
  fs.writeFileSync(real, `process.stdout.write(process.pid + '\\n');
setTimeout(() => { require('node:fs').writeFileSync(process.env.WRITER_DONE, 'done'); process.exit(0); }, Number(process.argv[2]));`);
  const done = path.join(f.root, `writer-done-${Date.now()}`);
  const owner = spawn(process.execPath, ['-e',
    'const c=require("node:child_process").spawn(process.execPath,[process.env.WRITER_SCRIPT,process.env.WRITER_LIFETIME],{stdio:"inherit"});c.on("exit",code=>process.exit(code??1));'],
  {env:{...process.env, WRITER_SCRIPT:script, WRITER_LIFETIME:String(lifetimeMs), WRITER_DONE:done}, stdio:['ignore', 'pipe', 'inherit']});
  let writerPid;
  t.after(() => {
    for (const pid of [writerPid, owner.pid]) try { if (pid) process.kill(pid, 'SIGKILL'); } catch {}
  });
  writerPid = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('writer did not start')), 10000);
    owner.stdout.once('data', chunk => { clearTimeout(timer); resolve(Number(String(chunk).trim())); });
    owner.once('exit', () => { clearTimeout(timer); reject(Error('writer exited before start')); });
  });
  assert.ok(writerPid > 0);
  return {done, pid:writerPid};
}

test('services() reports PM2 services whose recorded script path goes through a symlinked install path', t => {
  const f = symlinkedInstall(t);
  f.records(online(f, name => f.linked(f.scripts[name])));
  assert.deepEqual(m.services(f.j).map(service => [service.name, service.script]),
    [['scheduler', f.linked(f.scripts.scheduler)], ['custom-service', f.linked(f.scripts['custom-service'])]]);
});

test('stopping a symlinked install stops every PM2 service recorded through the symlink', t => {
  const f = symlinkedInstall(t);
  f.records(online(f, name => f.linked(f.scripts[name])));
  m.stop(f.j);
  assert.deepEqual(f.calls().filter(call => call[0] === 'stop'), [['stop', 'scheduler'], ['stop', 'custom-service']]);
  assert.ok(f.records().every(record => record.pm2_env.status === 'stopped' && record.pid === 0));
});

test('observed stop waits for a known writer launched through a symlinked install path', {skip:process.platform !== 'linux'}, async t => {
  const f = symlinkedInstall(t);
  const writer = await startWriter(t, f, f.linked(path.join(f.skillsDir, 'comm-bridge', 'scripts', 'c4-send.js')));
  m.stopObserved(f.j);
  assert.equal(fs.existsSync(writer.done), true, 'stop returned while the symlink-launched writer was still running');
});

test('process-identity stop waits for a known writer launched through a symlinked install path', {skip:process.platform !== 'linux'}, async t => {
  if (!m.canRecognizeProcesses()) return t.skip('process identity recognition unavailable on this host');
  const f = symlinkedInstall(t);
  const writer = await startWriter(t, f, f.linked(path.join(f.skillsDir, 'comm-bridge', 'scripts', 'c4-send.js')));
  m.stop(f.j);
  assert.equal(fs.existsSync(writer.done), true, 'stop returned while the symlink-launched writer was still running');
});

test('an install without symlinks keeps matching only services under the journal skills path', t => {
  const f = serviceRestartFixture(t);
  const outside = path.join(f.root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'service.js'), '');
  fs.symlinkSync(outside, path.join(f.root, 'outside-link'));
  const sibling = path.join(f.env.ZYLOS_DIR, '.claude', 'skills-other', 'service.js');
  fs.mkdirSync(path.dirname(sibling), {recursive:true});
  fs.writeFileSync(sibling, '');
  // The upgrade command may run from inside a skill directory, where a missing
  // or relative script path would resolve under the install.
  const cwd = process.cwd();
  process.chdir(path.dirname(f.scripts.scheduler));
  t.after(() => process.chdir(cwd));
  f.records([...online(f, name => f.scripts[name]),
    {name:'unrelated', pid:124, pm2_env:{status:'online', pm_exec_path:path.join(outside, 'service.js')}},
    {name:'unrelated-link', pid:125, pm2_env:{status:'online', pm_exec_path:path.join(f.root, 'outside-link', 'service.js')}},
    {name:'missing-path', pid:126, pm2_env:{status:'online'}},
    {name:'relative-path', pid:127, pm2_env:{status:'online', pm_exec_path:'service.js'}},
    {name:'sibling-directory', pid:128, pm2_env:{status:'online', pm_exec_path:sibling}}]);
  assert.deepEqual(m.services(f.j).map(service => [service.name, service.script]),
    [['scheduler', f.scripts.scheduler], ['custom-service', f.scripts['custom-service']]]);
});

test('services() keeps a service whose skill directory links outside the install root', t => {
  const f = serviceRestartFixture(t);
  const checkout = path.join(f.root, 'development-checkout');
  fs.mkdirSync(checkout);
  fs.writeFileSync(path.join(checkout, 'service.js'), '');
  fs.symlinkSync(checkout, path.join(f.skillsDir, 'linked-skill'));
  const script = path.join(f.skillsDir, 'linked-skill', 'service.js');
  assert.ok(!fs.realpathSync(script).startsWith(f.skillsDir + path.sep));
  f.records([...online(f, name => f.scripts[name]), {name:'linked-skill', pid:124, pm2_env:{status:'online', pm_exec_path:script}}]);
  assert.deepEqual(m.services(f.j).map(service => [service.name, service.script]),
    [['scheduler', f.scripts.scheduler], ['custom-service', f.scripts['custom-service']], ['linked-skill', script]]);
});

test('an install without symlinks still waits for a writer launched through the journal path', {skip:process.platform !== 'linux'}, async t => {
  const f = serviceRestartFixture(t);
  const writer = await startWriter(t, f, path.join(f.skillsDir, 'comm-bridge', 'scripts', 'c4-send.js'));
  m.stopObserved(f.j);
  assert.equal(fs.existsSync(writer.done), true);
});

test('a writer launched through a journal install path that contains spaces is still waited for', {skip:process.platform !== 'linux'}, async t => {
  const f = serviceRestartFixture(t);
  const zylosDir = path.join(f.root, 'zylos home');
  const spaced = {root:f.root, skillsDir:path.join(zylosDir, '.claude', 'skills')};
  const writer = await startWriter(t, spaced, path.join(spaced.skillsDir, 'comm-bridge', 'scripts', 'c4-send.js'));
  m.stopObserved({...f.j, zylosDir, skillsDir:spaced.skillsDir});
  assert.equal(fs.existsSync(writer.done), true, 'stop returned while the writer under the spaced install path was still running');
});

test('a known writer from another install is not waited for', {skip:process.platform !== 'linux'}, async t => {
  const f = serviceRestartFixture(t);
  const other = {root:f.root, skillsDir:path.join(f.root, 'other-zylos', '.claude', 'skills')};
  const writer = await startWriter(t, other, path.join(other.skillsDir, 'comm-bridge', 'scripts', 'c4-send.js'), 8000);
  const started = Date.now();
  m.stopObserved(f.j);
  assert.ok(Date.now() - started < 5000);
  assert.equal(fs.existsSync(writer.done), false);
});
