import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { test } from 'node:test';
import { verifyUpgradeBootCapability, parseLiteralSystemdArgv, validateUpgradeRuntimeArgs } from '../upgrade-boot-capability.js';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'core803-capability-'));
  const stable = path.join(root, '.zylos/upgrade');
  const units = path.join(root, 'units');
  fs.mkdirSync(stable, { recursive: true, mode: 0o700 });
  fs.mkdirSync(units);
  const bootstrapPath = path.join(stable, 'bootstrap.cjs');
  fs.writeFileSync(bootstrapPath, '// fixture bootstrap\n', { mode: 0o600 });
  const command = path.join(root, 'codex');
  fs.symlinkSync(process.execPath, command);
  const config = { formatVersion: 1, supervisor: { kind: 'systemd', unit: 'zylos-upgrade-recovery.service', scope: 'system' }, runtime: { kind: 'codex', command, args: [], cwd: root, path: process.env.PATH } };
  const configPath = path.join(stable, 'capability.json');
  fs.writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  const unitPath = path.join(units, config.supervisor.unit);
  const unit = `[Unit]\nDescription=Upgrade recovery\n[Service]\nType=simple\nUser=${os.userInfo().username}\nExecStart="${process.execPath}" "${bootstrapPath}" --root "${root}" --launch-runtime\n[Install]\nWantedBy=multi-user.target\n`;
  fs.writeFileSync(unitPath, unit, { mode: 0o644 });
  const calls = [];
  const responses = { enabled: 'enabled\n', dropins: '', authStatus: 0, authText: 'Logged in using fixture credentials', linger: 'yes\n' };
  const run = (file, args, opts) => {
    calls.push({ file, args, opts });
    if (file === 'systemctl' && args.includes('is-enabled')) return { status: 0, stdout: responses.enabled };
    if (file === 'systemctl') return { status: 0, stdout: `LoadState=loaded\nFragmentPath=${unitPath}\nDropInPaths=${responses.dropins}\n` };
    if (file === 'loginctl') return { status: 0, stdout: responses.linger };
    return { status: responses.authStatus, stdout: '', stderr: responses.authText };
  };
  const opts = { zylosDir: root, nodePath: process.execPath, bootstrapPath };
  return { root, config, configPath, unitPath, unit, calls, responses, run, opts, verify: () => verifyUpgradeBootCapability(opts, { spawnSync: run, unitDirectories: [units] }) };
}

test('requires actual enabled boot unit invocation and probes native persisted login', () => {
  const f = fixture();
  const result = f.verify();
  assert.equal(result.verified, true);
  assert.equal(result.authenticated, true);
  assert.deepEqual(f.calls.at(-1).args, ['login', 'status']);
  assert.equal(f.calls.at(-1).opts.env.CODEX_HOME, undefined);
  assert.equal(f.calls.at(-1).opts.env.OPENAI_API_KEY, undefined);
  assert.equal(JSON.stringify(result).includes('authentication output'), false);
  assert.ok(f.calls.every(c => c.opts.timeout === 10000));
});

test('no capability record fails before external commands or runtime launch', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'core803-no-capability-'));
  fs.mkdirSync(path.join(root, '.zylos/upgrade'), { recursive: true, mode: 0o700 });
  let called = false;
  assert.throws(() => verifyUpgradeBootCapability({ zylosDir: root, nodePath: process.execPath, bootstrapPath: 'missing' }, { spawnSync: () => { called = true; } }), /missing or invalid capability/);
  assert.equal(called, false);
});

test('disabled/manual-only supervisor cannot pass protected upgrade gate', () => {
  const f = fixture(); f.responses.enabled = 'disabled\n';
  assert.throws(f.verify, /not enabled for boot/);
  assert.equal(f.calls.some(c => c.args.includes('login')), false);
});

test('unit invoking ordinary CLI or unreviewed drop-ins cannot pass', () => {
  const f = fixture(); fs.writeFileSync(f.unitPath, f.unit.replace('--launch-runtime', '--status'));
  assert.throws(f.verify, /fixed bootstrap/);
  fs.writeFileSync(f.unitPath, f.unit); f.responses.dropins = '/etc/systemd/system/override.conf';
  assert.throws(f.verify, /unreviewed overrides/);
});

test('boot target, execution identity and unit environment are verified', () => {
  const f = fixture();
  for (const [unit, expected] of [
    [f.unit.replace('multi-user.target', 'custom.target'), /normal boot target/],
    [f.unit.replace(`User=${os.userInfo().username}`, 'User=somebodyelse'), /deployment owner/],
    [f.unit.replace('Type=simple', 'Type=simple\nEnvironment=OPENAI_API_KEY=fixture'), /unsupported directive/],
    [f.unit.replace('Type=simple', 'Type=simple\nExecStartPre=/bin/true'), /unsupported directive/],
  ]) { fs.writeFileSync(f.unitPath, unit); assert.throws(f.verify, expected); }
});

test('unavailable native authentication remains a pre-npm failure without exposing output', () => {
  const f = fixture(); f.responses.authStatus = 1;
  assert.throws(f.verify, e => e.code === 'UPGRADE_BOOT_CAPABILITY_UNAVAILABLE' && !e.message.includes('authentication output'));
});

test('unsafe configuration permissions cannot authorize bootstrap commands', () => {
  const f = fixture(); fs.chmodSync(f.configPath, 0o644);
  assert.throws(f.verify, /private owned/);
});

test('user unit requires lingering so a real boot does not wait for login', () => {
  const f = fixture(); f.config.supervisor.scope = 'user';
  fs.writeFileSync(f.configPath, JSON.stringify(f.config));
  fs.writeFileSync(f.unitPath, f.unit.replace(`User=${os.userInfo().username}\n`, '').replace('multi-user.target', 'default.target'));
  f.responses.linger = 'no\n'; assert.throws(f.verify, /interactive login/);
  f.responses.linger = 'yes\n'; assert.equal(f.verify().verified, true);
  assert.ok(f.calls.some(c => c.file === 'systemctl' && c.args[0] === '--user'));
});

test('literal argument parser supports spaces but refuses expansions and shell ambiguity', () => {
  assert.deepEqual(parseLiteralSystemdArgv('"/node with space" "/root/bootstrap.cjs" --root "/root with space" --launch-runtime'), ['/node with space', '/root/bootstrap.cjs', '--root', '/root with space', '--launch-runtime']);
  for (const text of ['${NODE} /bootstrap', '/node %h/bootstrap', '/node \\\n/bootstrap', '/node "unterminated']) assert.throws(() => parseLiteralSystemdArgv(text));
});


test('boot runtime accepts supported flags but rejects subcommands and existing prompts',()=>{
  assert.deepEqual(validateUpgradeRuntimeArgs('codex',['--no-daemon','--model','gpt-test','--dangerously-bypass-approvals-and-sandbox']),['--no-daemon','--model','gpt-test','--dangerously-bypass-approvals-and-sandbox']);
  assert.deepEqual(validateUpgradeRuntimeArgs('claude',['--dangerously-skip-permissions','--model','sonnet']),['--dangerously-skip-permissions','--model','sonnet']);
  for(const args of [['exec'],['resume'],['existing kick prompt'],['--model'],['--model','--no-daemon'],['--config','shell=arbitrary']]){
    assert.throws(()=>validateUpgradeRuntimeArgs('codex',args));
    const f=fixture();f.config.runtime.args=args;fs.writeFileSync(f.configPath,JSON.stringify(f.config));
    assert.throws(f.verify,/without subcommands or positional prompts/);
    assert.equal(f.calls.length,0);
  }
});

test('Codex exit zero without affirmative persisted login cannot pass the pre-npm gate',()=>{
  for(const text of ['Not logged in','warning only','Logged in using fixture\nNot logged in']){
    const f=fixture();f.responses.authText=text;
    assert.throws(f.verify,error=>error.code==='UPGRADE_BOOT_CAPABILITY_UNAVAILABLE'&&!error.message.includes(text));
  }
  const f=fixture();f.responses.authText='warning\nLogged in using fixture';
  assert.equal(f.verify().authenticated,true);
});

test('conditional, remapped and sandboxed unit directives cannot attest active boot startup',()=>{
  for(const directive of ['ConditionPathExists=/never','ExecCondition=/bin/false','RootDirectory=/elsewhere','PrivateNetwork=yes','InaccessiblePaths=/usr/bin/codex','BindPaths=/other:/work','ExecSearchPath=/other']){
    const f=fixture();const section=directive.startsWith('Condition')?'[Unit]':'[Service]';
    fs.writeFileSync(f.unitPath,f.unit.replace(section,section+'\n'+directive));
    assert.throws(f.verify,/unsupported directive/);
    assert.equal(f.calls.some(c=>c.args.includes('login')),false);
  }
});

test('saved boot network environment is restricted and values never enter capability evidence',()=>{
  const f=fixture();f.config.runtime.networkEnv={HTTPS_PROXY:'http://127.0.0.1:12345',NO_PROXY:'localhost'};fs.writeFileSync(f.configPath,JSON.stringify(f.config));
  const result=f.verify();assert.equal(f.calls.at(-1).opts.env.HTTPS_PROXY,'http://127.0.0.1:12345');
  assert.deepEqual(result.runtime.networkConfigured,['HTTPS_PROXY','NO_PROXY']);assert.equal(result.runtime.networkEnv,undefined);
  assert.equal(JSON.stringify(result).includes('127.0.0.1'),false);
  for(const value of [{OPENAI_API_KEY:'must-deny'},{CODEX_HOME:'/other'},{HTTPS_PROXY:'file:///etc/passwd'},{HTTPS_PROXY:'http://user:password@localhost:12345'},{NO_PROXY:'one\ntwo'}]){
    f.config.runtime.networkEnv=value;fs.writeFileSync(f.configPath,JSON.stringify(f.config));assert.throws(f.verify);
  }
});

test('boot authentication probe uses saved PATH rather than interactive PATH', () => {
  const f = fixture();
  f.config.runtime.path = '/opt/saved-node/bin:/usr/bin:/bin';
  fs.writeFileSync(f.configPath, JSON.stringify(f.config));
  f.verify();
  assert.equal(f.calls.at(-1).opts.env.PATH, f.config.runtime.path);
});
