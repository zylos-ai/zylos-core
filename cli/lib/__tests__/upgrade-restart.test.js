import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, test } from 'node:test';
import {createRequire} from 'node:module';
import {serviceRestartFixture} from './helpers/service-restart-fixture.js';

const { rollback, step7_runPostUpgradeHook, step8_startService } = await import('../upgrade.js');
const { step11_startCoreServices, step12_verifyServices, resumeUpgradeFinalization } = await import('../self-upgrade.js');
const maintenance = createRequire(import.meta.url)('../upgrade-maintenance.cjs');
const {resumeFinalize} = await import('../upgrade-resume.js');

function makeSkillDir(frontmatter) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-upgrade-hook-'));
  const skillDir = path.join(tmpDir, 'demo');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\nname: demo\n${frontmatter}---\n`, 'utf8');
  return { tmpDir, skillDir };
}

describe('step7_runPostUpgradeHook', () => {
  it('skips when no post-upgrade hook is declared', () => {
    const { tmpDir, skillDir } = makeSkillDir('');

    try {
      const result = step7_runPostUpgradeHook({ component: 'demo', skillDir }, {
        spawnSync: () => {
          throw new Error('should not run hook');
        },
      });

      assert.equal(result.status, 'skipped');
      assert.equal(result.message, 'no post-upgrade hook');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('skips when the declared hook file is missing', () => {
    const { tmpDir, skillDir } = makeSkillDir('lifecycle:\n  hooks:\n    post-upgrade: hooks/post-upgrade.js\n');

    try {
      const result = step7_runPostUpgradeHook({ component: 'demo', skillDir });

      assert.equal(result.status, 'skipped');
      assert.equal(result.message, 'hook not found: hooks/post-upgrade.js');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('runs an existing hook and returns captured output', () => {
    const { tmpDir, skillDir } = makeSkillDir('lifecycle:\n  hooks:\n    post-upgrade: hooks/post-upgrade.js\n');
    const hookPath = path.join(skillDir, 'hooks', 'post-upgrade.js');
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    fs.writeFileSync(hookPath, 'console.log("ok");\n', 'utf8');
    const stdoutWrites = [];
    const stderrWrites = [];

    try {
      const result = step7_runPostUpgradeHook({ component: 'demo', skillDir, jsonOutput: false }, {
        spawnSync: (cmd, args, opts) => {
          assert.equal(cmd, process.execPath);
          assert.deepEqual(args, [hookPath]);
          assert.equal(opts.cwd, skillDir);
          assert.deepEqual(opts.stdio, ['ignore', 'pipe', 'pipe']);
          return { status: 0, stdout: 'hook stdout\n', stderr: 'hook stderr\n' };
        },
        stdout: { write: (value) => stdoutWrites.push(value) },
        stderr: { write: (value) => stderrWrites.push(value) },
      });

      assert.equal(result.status, 'done');
      assert.equal(result.message, 'hooks/post-upgrade.js');
      assert.deepEqual(result.output, { stdout: 'hook stdout\n', stderr: 'hook stderr\n' });
      assert.deepEqual(stdoutWrites, ['hook stdout\n']);
      assert.deepEqual(stderrWrites, ['hook stderr\n']);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('treats a failing hook as non-fatal and keeps diagnostics', () => {
    const { tmpDir, skillDir } = makeSkillDir('lifecycle:\n  hooks:\n    post-upgrade: hooks/post-upgrade.js\n');
    const hookPath = path.join(skillDir, 'hooks', 'post-upgrade.js');
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    fs.writeFileSync(hookPath, 'process.exit(1);\n', 'utf8');

    try {
      const result = step7_runPostUpgradeHook({ component: 'demo', skillDir, jsonOutput: true }, {
        spawnSync: () => ({ status: 1, stdout: 'before fail\n', stderr: 'bad things\n' }),
      });

      assert.equal(result.status, 'skipped');
      assert.match(result.message, /hook had issues/);
      assert.match(result.message, /bad things/);
      assert.deepEqual(result.output, { stdout: 'before fail\n', stderr: 'bad things\n' });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('does not replay hook output when jsonOutput is enabled', () => {
    const { tmpDir, skillDir } = makeSkillDir('lifecycle:\n  hooks:\n    post-upgrade: hooks/post-upgrade.js\n');
    const hookPath = path.join(skillDir, 'hooks', 'post-upgrade.js');
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    fs.writeFileSync(hookPath, 'console.log("json safe");\n', 'utf8');
    const stdoutWrites = [];
    const stderrWrites = [];

    try {
      const result = step7_runPostUpgradeHook({ component: 'demo', skillDir, jsonOutput: true }, {
        spawnSync: () => ({ status: 0, stdout: 'hook stdout\n', stderr: 'hook stderr\n' }),
        stdout: { write: (value) => stdoutWrites.push(value) },
        stderr: { write: (value) => stderrWrites.push(value) },
      });

      assert.equal(result.status, 'done');
      assert.deepEqual(result.output, { stdout: 'hook stdout\n', stderr: 'hook stderr\n' });
      assert.deepEqual(stdoutWrites, []);
      assert.deepEqual(stderrWrites, []);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('skips hook paths that escape the skill directory', () => {
    const { tmpDir, skillDir } = makeSkillDir('lifecycle:\n  hooks:\n    post-upgrade: ../outside.js\n');

    try {
      const result = step7_runPostUpgradeHook({ component: 'demo', skillDir }, {
        existsSync: () => true,
        spawnSync: () => {
          throw new Error('should not run hook');
        },
      });

      assert.equal(result.status, 'skipped');
      assert.match(result.message, /escapes skill directory/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('skips hook symlinks that resolve outside the skill directory', () => {
    const { tmpDir, skillDir } = makeSkillDir('lifecycle:\n  hooks:\n    post-upgrade: hooks/outside.js\n');
    const outsideHook = path.join(tmpDir, 'outside.js');
    const hookPath = path.join(skillDir, 'hooks', 'outside.js');
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    fs.writeFileSync(outsideHook, 'console.log("outside");\n', 'utf8');
    fs.symlinkSync(outsideHook, hookPath);

    try {
      const result = step7_runPostUpgradeHook({ component: 'demo', skillDir }, {
        spawnSync: () => {
          throw new Error('should not run hook');
        },
      });

      assert.equal(result.status, 'skipped');
      assert.match(result.message, /escapes skill directory/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

test('core restart starts ecosystem and saved custom services before strict verification', t => {
  const f=serviceRestartFixture(t);f.custom();
  const ctx={journal:f.j,servicesWereRunning:f.j.originalServices.map(service=>service.name)};
  const result=step11_startCoreServices(ctx,{zylosDir:f.env.ZYLOS_DIR,ecosystemPath:f.file});
  assert.equal(result.status,'done',JSON.stringify(result));
  assert.equal(step12_verifyServices(ctx,{execSync:command=>command.startsWith('sleep')?'':JSON.stringify(f.records())}).status,'done');
  assert.ok(f.calls().some(args=>args[0]==='start'&&args.includes('scheduler')));
  assert.ok(f.calls().some(args=>JSON.stringify(args)===JSON.stringify(['restart','custom-service','--update-env'])));
  assert.ok(f.records().every(record=>record.pm2_env.status==='online'));
  assert.ok(!f.calls().some(args=>args[0]==='delete'));
});

for(const source of ['throw Error("broken config")','module.exports={}'])test(`core restart refuses invalid ecosystem configuration ${source}`,t=>{
  const f=serviceRestartFixture(t);fs.writeFileSync(f.file,source);
  const result=step11_startCoreServices({journal:f.j,servicesWereRunning:['scheduler']},{zylosDir:f.env.ZYLOS_DIR,ecosystemPath:f.file});
  assert.equal(result.status,'failed');
  assert.match(result.error,/ecosystem.*load|load.*ecosystem/i);
  assert.match(result.error,/broken config|invalid ecosystem/);
  assert.doesNotMatch(result.error,/\[eval\]|\n\s+at |Node\.js v/);
  assert.deepEqual(f.calls(),[]);
});

test('core restart without an ecosystem uses verified saved PM2 records',t=>{
  const f=serviceRestartFixture(t,{ecosystem:false});f.custom();
  const result=step11_startCoreServices({journal:f.j,servicesWereRunning:f.j.originalServices.map(service=>service.name)},{zylosDir:f.env.ZYLOS_DIR,ecosystemPath:f.file});
  assert.equal(result.status,'done',JSON.stringify(result));
  assert.deepEqual(f.calls(),[['jlist'],['restart','scheduler','--update-env'],['restart','custom-service','--update-env'],['save']]);
  assert.ok(f.records().every(record=>record.pm2_env.status==='online'));
  assert.equal(fs.existsSync(f.file),false);
});

for(const defect of ['missing','changed','outside','duplicate-saved','duplicate-record'])test(`core restart without an ecosystem refuses ${defect} saved PM2 identity`,t=>{
  const f=serviceRestartFixture(t,{ecosystem:false});
  if(defect==='missing')f.records([]);
  if(defect==='changed')f.records([{...f.record('scheduler'),pm2_env:{status:'stopped',pm_exec_path:path.join(f.skillsDir,'changed.js')}}]);
  if(defect==='outside')f.records([{...f.record('scheduler'),pm2_env:{status:'stopped',pm_exec_path:'/tmp/untrusted.js'}}]);
  if(defect==='duplicate-saved')f.j.originalServices.push({...f.j.originalServices[0]});
  if(defect==='duplicate-record')f.records([f.record('scheduler'),f.record('scheduler')]);
  const result=step11_startCoreServices({journal:f.j,servicesWereRunning:['scheduler']},{zylosDir:f.env.ZYLOS_DIR,ecosystemPath:f.file});
  assert.equal(result.status,'failed');assert.match(result.error,/original PM2 service record missing or changed/);
  assert.deepEqual(f.calls(),defect==='duplicate-saved'?[]:[['jlist']]);
});

for(const defect of ['missing','changed','outside','duplicate-saved','duplicate-record'])test(`core restart refuses ${defect} original custom identity before starting any service`, t=>{
  const f=serviceRestartFixture(t);f.custom();
  if(defect==='missing')f.records([f.record('scheduler')]);
  if(defect==='changed')f.records([f.record('scheduler'),{...f.record('custom-service'),pm2_env:{status:'stopped',pm_exec_path:path.join(f.skillsDir,'changed.js')}}]);
  if(defect==='outside')f.records([f.record('scheduler'),{...f.record('custom-service'),pm2_env:{status:'stopped',pm_exec_path:'/tmp/untrusted.js'}}]);
  if(defect==='duplicate-saved')f.j.originalServices.push({...f.j.originalServices[1]});
  if(defect==='duplicate-record')f.records([f.record('scheduler'),f.record('custom-service'),f.record('custom-service')]);
  const result=step11_startCoreServices({journal:f.j,servicesWereRunning:f.j.originalServices.map(service=>service.name)},{zylosDir:f.env.ZYLOS_DIR,ecosystemPath:f.file});
  assert.equal(result.status,'failed');assert.match(result.error,/original PM2 service record missing or changed/);
  assert.deepEqual(f.calls(),defect==='duplicate-saved'?[]:[['jlist']]);
});

test('core custom restart failure preserves its original PM2 record without ecosystem retry',t=>{
  const f=serviceRestartFixture(t,{names:[]});f.fail();
  const result=step11_startCoreServices({journal:f.j,servicesWereRunning:['scheduler']},{zylosDir:f.env.ZYLOS_DIR,ecosystemPath:f.file});
  assert.equal(result.status,'failed');
  assert.deepEqual(f.calls(),[['jlist'],['restart','scheduler','--update-env']]);
});

test('resume-finalize runs real service restart and verification for an app absent from ecosystem',async t=>{
  const f=serviceRestartFixture(t);f.custom();
  const root=f.env.ZYLOS_DIR,id='upgrade-custom',dir=path.join(root,'.backup/self-upgrade',id),db=path.join(root,'.backup/db',id);
  fs.mkdirSync(dir,{recursive:true,mode:0o700});fs.mkdirSync(db,{recursive:true,mode:0o700});
  const manifest={formatVersion:2,function:'core-self-upgrade-db',status:'complete',id,
    databases:['comm-bridge/c4.db','scheduler/scheduler.db','web-console/web-console.db','components/dashboard/dashboard.db'].map(source=>({source,status:'missing',file:null,bytes:0,sha256:null,userVersion:null,integrityCheck:null}))};
  maintenance.durable(path.join(db,'manifest.json'),manifest);
  const digest=maintenance.hash(path.join(db,'manifest.json'));
  const journal={...f.j,transactionId:id,phase:'recovery_required',resumePhase:'compensation_closed',installationIntent:true,from:'old',to:'new',dbBackupDir:db,snapshotManifestHash:digest,
    compensationCutoff:{formatVersion:1,closed:true,transactionId:id,snapshotManifestHash:digest,closedAt:new Date().toISOString(),writer:'finalizer'},postCutoff:{items:{hooks:{state:'done'}}}};
  maintenance.durable(path.join(dir,'journal.json'),journal);
  const read=()=>maintenance.read(path.join(dir,'journal.json'));
  const m={...maintenance,discover:()=>({candidates:[{dir,journal:read()}],diagnostics:[]}),transaction:read,acquire:()=>()=>{},marker:()=>{}};
  const result=await resumeFinalize(root,{}, {maintenance:m,quiesce:()=>{},finalize:ctx=>resumeUpgradeFinalization(ctx,{
    publish:()=>({ok:true}),updateConfig:()=>{},ensureMemoryMigration:()=>{},verifyPublicationForServices:()=>{},
    startServices:ctx=>step11_startCoreServices(ctx,{zylosDir:root,ecosystemPath:f.file}),
    dashboardOwner:{verifyDashboard:()=>({state:'ready',errors:[]})},readModeStatus:()=>({ok:true,data:{sessionMode:'single',transition:null}}),
    readMode:()=>({mode:'single'}),readTransition:()=>null,restart:()=>({ok:true,data:{result:'accepted'}}),audit:()=>[],
    protectedSuccess:ctx=>m.update(dir,ctx.journal,{phase:'upgrade_complete'}),
  })});
  assert.equal(result.ok,true,JSON.stringify(result));
  assert.equal(result.data.core.state,'done');
  assert.ok(f.calls().some(args=>args[0]==='restart'&&args[1]==='custom-service'));
  assert.ok(f.records().every(record=>record.pm2_env.status==='online'));
  assert.equal(read().phase,'upgrade_complete');
});

test('core verification retains a saved custom service that remains stopped',t=>{
  const f=serviceRestartFixture(t);f.custom();let polls=0;
  const result=step12_verifyServices({servicesWereRunning:f.j.originalServices.map(service=>service.name)},{execSync:command=>{
    if(command.startsWith('sleep')){if(++polls===2)throw Error('poll cancelled');return '';}
    return JSON.stringify([f.record('scheduler','online'),f.record('custom-service')]);
  }});
  assert.equal(result.status,'failed');assert.equal(polls,2);
});

describe('step8_startService', () => {
  it('retries deleted services through ecosystem restart instead of pm2 start <name>', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-upgrade-step8-'));
    const skillDir = path.join(tmpDir, 'demo');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\nname: demo\nlifecycle:\n  service:\n    name: zylos-demo\n---\n`, 'utf8');
    fs.writeFileSync(path.join(skillDir, 'ecosystem.config.cjs'), 'module.exports = { apps: [] };\n', 'utf8');

    const calls = [];
    const result = step8_startService({
      component: 'demo',
      skillDir,
      serviceWasRunning: true,
    }, {
      restartManagedProcess: () => {
        throw new Error('process missing');
      },
      restartFromEcosystem: (names, opts) => {
        calls.push({ type: 'ecosystem', names, opts });
      },
      execSync: (cmd) => {
        calls.push({ type: 'exec', cmd });
      },
      existsSync: (file) => file === path.join(skillDir, 'ecosystem.config.cjs'),
    });

    assert.equal(result.status, 'done');
    assert.equal(calls.some((call) => call.type === 'ecosystem' && call.names[0] === 'zylos-demo'), true);
    assert.equal(calls.some((call) => call.type === 'exec' && call.cmd === 'pm2 start zylos-demo 2>/dev/null'), false);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('persists the PM2 dump (save: true) on a normal upgrade restart (#1696)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-upgrade-step8-save-'));
    const skillDir = path.join(tmpDir, 'demo');
    const ecosystemPath = path.join(skillDir, 'ecosystem.config.cjs');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\nname: demo\nlifecycle:\n  service:\n    name: zylos-demo\n---\n`, 'utf8');
    fs.writeFileSync(ecosystemPath, 'module.exports = { apps: [] };\n', 'utf8');

    const calls = [];
    const result = step8_startService({
      component: 'demo',
      skillDir,
      serviceWasRunning: true,
    }, {
      restartManagedProcess: (name, opts) => {
        calls.push({ name, opts });
      },
      restartFromEcosystem: () => {
        throw new Error('should not reach ecosystem fallback on the happy path');
      },
      existsSync: (file) => file === ecosystemPath,
    });

    assert.equal(result.status, 'done');
    assert.deepStrictEqual(calls, [{
      name: 'zylos-demo',
      opts: { ecosystemPath, stdio: 'pipe', save: true },
    }]);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('persists the PM2 dump (save: true) when restarting from ecosystem after the process disappeared (#1696)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-upgrade-step8-fallback-save-'));
    const skillDir = path.join(tmpDir, 'demo');
    const ecosystemPath = path.join(skillDir, 'ecosystem.config.cjs');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\nname: demo\nlifecycle:\n  service:\n    name: zylos-demo\n---\n`, 'utf8');
    fs.writeFileSync(ecosystemPath, 'module.exports = { apps: [] };\n', 'utf8');

    const ecosystemCalls = [];
    const result = step8_startService({
      component: 'demo',
      skillDir,
      serviceWasRunning: true,
    }, {
      restartManagedProcess: () => {
        throw new Error('process missing');
      },
      restartFromEcosystem: (names, opts) => {
        ecosystemCalls.push({ names, opts });
      },
      execSync: () => {},
      existsSync: (file) => file === ecosystemPath,
    });

    assert.equal(result.status, 'done');
    assert.deepStrictEqual(ecosystemCalls, [{
      names: ['zylos-demo'],
      opts: { ecosystemPath, stdio: 'pipe', save: true },
    }]);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('component upgrade rollback', () => {
  it('restores from skillDir/.backup/<timestamp> and preserves backup metadata', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-upgrade-rollback-'));
    const skillDir = path.join(tmpDir, 'skills', 'demo');
    const backupDir = path.join(skillDir, '.backup', 'run-1');

    fs.mkdirSync(backupDir, { recursive: true });
    fs.mkdirSync(path.join(skillDir, '.zylos'), { recursive: true });
    fs.mkdirSync(path.join(skillDir, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(backupDir, 'SKILL.md'), 'old\n', 'utf8');
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), 'broken\n', 'utf8');
    fs.writeFileSync(path.join(skillDir, 'new-file.txt'), 'remove\n', 'utf8');
    fs.writeFileSync(path.join(skillDir, '.zylos', 'manifest.json'), '{}\n', 'utf8');
    fs.writeFileSync(path.join(skillDir, '.zylos', 'other-metadata.json'), 'keep\n', 'utf8');
    fs.writeFileSync(path.join(skillDir, 'node_modules', 'keep.txt'), 'deps\n', 'utf8');

    const results = rollback({
      backupDir,
      skillDir,
      serviceWasRunning: false,
    });

    assert.equal(results.some((item) => item.action === 'restore_files' && item.success), true);
    assert.equal(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8'), 'old\n');
    assert.equal(fs.existsSync(path.join(skillDir, 'new-file.txt')), false);
    assert.equal(fs.readFileSync(path.join(skillDir, '.backup', 'run-1', 'SKILL.md'), 'utf8'), 'old\n');
    assert.equal(fs.readFileSync(path.join(skillDir, 'node_modules', 'keep.txt'), 'utf8'), 'deps\n');
    // #715 commit-boundary contract: rollback never touches .zylos because
    // the outer pipeline commits the new baseline only after every failing
    // step has succeeded. The pre-upgrade baseline and other metadata stay.
    assert.equal(results.some((item) => item.action === 'restore_baseline'), false);
    assert.equal(fs.readFileSync(path.join(skillDir, '.zylos', 'manifest.json'), 'utf8'), '{}\n');
    assert.equal(fs.readFileSync(path.join(skillDir, '.zylos', 'other-metadata.json'), 'utf8'), 'keep\n');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('persists the PM2 dump (save: true) when restarting the service after rollback (#1696)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-upgrade-rollback-save-'));
    const skillDir = path.join(tmpDir, 'skills', 'demo');
    const ecosystemPath = path.join(skillDir, 'ecosystem.config.cjs');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\nname: demo\nlifecycle:\n  service:\n    name: zylos-demo\n---\n`, 'utf8');

    const calls = [];
    const results = rollback({
      skillDir,
      serviceWasRunning: true,
    }, {
      restartManagedProcess: (name, opts) => {
        calls.push({ name, opts });
      },
    });

    assert.equal(results.some((item) => item.action === 'restart_service' && item.success), true);
    assert.deepStrictEqual(calls, [{
      name: 'zylos-demo',
      opts: { ecosystemPath, stdio: 'pipe', save: true },
    }]);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('step11_startCoreServices', () => {
  it('passes the core ecosystem path instead of null when no template is available yet', t => {
    const f=serviceRestartFixture(t,{names:['activity-monitor']});
    const calls = [];
    const result = step11_startCoreServices({
      tempDir: null,
      servicesWereRunning: ['activity-monitor'],
    }, {
      fs: {
        existsSync: () => true,
        mkdirSync: () => {},
        copyFileSync: () => {},
      },
      ecosystemPath: f.file,
      restartManagedProcess: (name, opts) => {
        calls.push({ name, opts });
      },
      verifyActivityMonitorEnv: () => true,
      execSync: (cmd) => calls.push({ type: 'exec', cmd }),
    });

    assert.equal(result.status, 'done');
    assert.deepStrictEqual(calls, [{
      name: 'activity-monitor',
      opts: {
        ecosystemPath: f.file,
        stdio: 'pipe',
        fallbackToPlainRestartOnError: false,
      },
    }, {
      type: 'exec',
      cmd: 'pm2 save 2>/dev/null',
    }]);
  });

  it('uses the module default restart helper when no restart dep is injected', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-step11-default-'));
    const binDir = path.join(tmpDir, 'bin');
    const logPath = path.join(tmpDir, 'pm2.log');
    const ecosystemPath = path.join(tmpDir, 'ecosystem.config.cjs');
    const pm2Path = path.join(binDir, 'pm2');
    const originalPath = process.env.PATH;

    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(ecosystemPath, 'module.exports = { apps: [{name:"activity-monitor"}] };\n', 'utf8');
    fs.writeFileSync(pm2Path, `#!/bin/sh\necho "$@" >> "${logPath}"\nif [ "$1" = "jlist" ]; then echo '[{"name":"activity-monitor","pm_id":3,"pm2_env":{"status":"online","ZYLOS_PACKAGE_ROOT":"${tmpDir}"}}]'; fi\n`, { mode: 0o755 });

    process.env.PATH = `${binDir}:${originalPath}`;

    try {
      const result = step11_startCoreServices({
        tempDir: null,
        servicesWereRunning: ['activity-monitor'],
      }, {
        fs: {
          existsSync: (file) => file === ecosystemPath,
          mkdirSync: () => {},
          copyFileSync: () => {},
        },
        ecosystemPath,
      });

      assert.equal(result.status, 'done');
      assert.match(fs.readFileSync(logPath, 'utf8'), /start .*ecosystem\.config\.cjs.*--only activity-monitor/);
      assert.match(fs.readFileSync(logPath, 'utf8'), /--update-env/);
      assert.match(fs.readFileSync(logPath, 'utf8'), /^jlist$/m);
      assert.doesNotMatch(fs.readFileSync(logPath, 'utf8'), /^env activity-monitor$/m);
      assert.match(fs.readFileSync(logPath, 'utf8'), /save/);
    } finally {
      process.env.PATH = originalPath;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('fails before saving when pm2 jlist lacks activity-monitor package-root env', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-step11-jlist-missing-'));
    const binDir = path.join(tmpDir, 'bin');
    const logPath = path.join(tmpDir, 'pm2.log');
    const ecosystemPath = path.join(tmpDir, 'ecosystem.config.cjs');
    const pm2Path = path.join(binDir, 'pm2');
    const originalPath = process.env.PATH;

    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(ecosystemPath, 'module.exports = { apps: [{name:"activity-monitor"}] };\n', 'utf8');
    fs.writeFileSync(pm2Path, `#!/bin/sh\necho "$@" >> "${logPath}"\nif [ "$1" = "jlist" ]; then echo '[{"name":"activity-monitor","pm_id":3,"pm2_env":{"status":"online"}}]'; fi\n`, { mode: 0o755 });

    process.env.PATH = `${binDir}:${originalPath}`;

    try {
      const result = step11_startCoreServices({
        tempDir: null,
        servicesWereRunning: ['activity-monitor'],
      }, {
        fs: {
          existsSync: (file) => file === ecosystemPath,
          mkdirSync: () => {},
          copyFileSync: () => {},
        },
        ecosystemPath,
      });

      assert.equal(result.status, 'failed');
      assert.match(result.error, /ZYLOS_PACKAGE_ROOT/);
      assert.match(fs.readFileSync(logPath, 'utf8'), /^jlist$/m);
      assert.doesNotMatch(fs.readFileSync(logPath, 'utf8'), /^save$/m);
    } finally {
      process.env.PATH = originalPath;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('fails before saving when activity-monitor restarts without refreshed package-root env', t => {
    const f=serviceRestartFixture(t,{names:['activity-monitor']});
    const calls = [];
    const result = step11_startCoreServices({
      tempDir: null,
      servicesWereRunning: ['activity-monitor'],
    }, {
      fs: {
        existsSync: () => true,
        mkdirSync: () => {},
        copyFileSync: () => {},
      },
      ecosystemPath: f.file,
      restartManagedProcess: (name, opts) => {
        calls.push({ name, opts });
      },
      verifyActivityMonitorEnv: () => false,
      execSync: (cmd) => calls.push({ type: 'exec', cmd }),
    });

    assert.equal(result.status, 'failed');
    assert.match(result.error, /ZYLOS_PACKAGE_ROOT/);
    assert.equal(calls.some(call => call.type === 'exec' && call.cmd === 'pm2 save 2>/dev/null'), false);
  });
});
