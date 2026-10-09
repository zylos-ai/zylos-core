import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import runtimeArguments from './upgrade-runtime-args.cjs';
import { classifyCodexLoginStatus } from './auth-parsers.js';
export const validateUpgradeRuntimeArgs=runtimeArguments.validateRuntimeArgs;
export const validateUpgradeRuntimeNetworkEnv=runtimeArguments.validateRuntimeNetworkEnv;
export const validateRuntimeNetworkEnv=runtimeArguments.validateRuntimeNetworkEnv;

function denied(reason) {
  const error = new Error(`Protected self-upgrade boot capability unavailable: ${reason}`);
  error.code = 'UPGRADE_BOOT_CAPABILITY_UNAVAILABLE';
  throw error;
}

function privateFile(file, uid, maxBytes = 16384) {
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink() || st.uid !== uid || (st.mode & 0o077) || st.size > maxBytes) {
    denied('capability configuration must be a private owned regular file');
  }
  return fs.readFileSync(file, 'utf8');
}

function executable(file, allowedOwners) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) denied('executable path must be absolute');
  const real = fs.realpathSync(file);
  const st = fs.statSync(real);
  if (!st.isFile() || !(st.mode & 0o111) || (st.mode & 0o022) || !allowedOwners.includes(st.uid)) {
    denied('executable ownership or permissions are unsafe');
  }
  return real;
}

// Supported units use literal arguments. Reject expansion/specifiers rather than
// interpret unit text as a shell command or permit a different boot invocation.
export function parseLiteralSystemdArgv(value) {
  if (typeof value !== 'string' || /[$%\\\n\r]/.test(value)) denied('unit ExecStart must use literal arguments');
  const words = [];
  let word = '', quote = '', started = false;
  for (const ch of value.trim()) {
    if (quote) {
      if (ch === quote) quote = '';
      else word += ch;
      started = true;
    } else if (ch === '"' || ch === "'") {
      quote = ch; started = true;
    } else if (/\s/.test(ch)) {
      if (started) { words.push(word); word = ''; started = false; }
    } else { word += ch; started = true; }
  }
  if (quote) denied('unit ExecStart contains an unterminated quote');
  if (started) words.push(word);
  return words;
}

function unitFields(text) {
  if (Buffer.byteLength(text) > 32768) denied('unit is too large');
  let section = '';
  const fields = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^[#;]/.test(line)) continue;
    if (line.startsWith('[') && line.endsWith(']')) { section = line.slice(1, -1); continue; }
    const pos = line.indexOf('=');
    if (pos < 1) denied('unsupported unit syntax');
    const key = `${section}.${line.slice(0, pos).trim()}`;
    if (fields.has(key)) denied('duplicate unit directives require explicit review');
    fields.set(key, line.slice(pos + 1).trim());
  }
  return fields;
}

/** Verify configured boot supervision and real installed runtime login status.
 * This is a pre-npm capability gate, not a promise that credentials never expire.
 * deps exists for deterministic fault tests; production callers omit it.
 */
export function verifyUpgradeBootCapability({ zylosDir, nodePath, bootstrapPath }, deps = {}) {
  const run = deps.spawnSync || spawnSync;
  const uid = deps.uid ?? process.getuid?.();
  const username = deps.username || os.userInfo().username;
  const home = deps.home || os.userInfo().homedir;
  const root = fs.realpathSync(zylosDir);
  const directory = path.join(root, '.zylos', 'upgrade');
  const dst = fs.lstatSync(directory);
  if (!dst.isDirectory() || dst.isSymbolicLink() || dst.uid !== uid || (dst.mode & 0o022)) {
    denied('stable bootstrap directory is not owned and protected');
  }
  let configuration;
  try { configuration = JSON.parse(privateFile(path.join(directory, 'capability.json'), uid)); }
  catch (error) { if (error.code === 'UPGRADE_BOOT_CAPABILITY_UNAVAILABLE') throw error; denied('missing or invalid capability configuration'); }
  if (configuration.formatVersion !== 1) denied('unsupported capability format');
  const supervisor = configuration.supervisor;
  if (supervisor?.kind !== 'systemd' || supervisor.unit !== 'zylos-upgrade-recovery.service' || !['system', 'user'].includes(supervisor.scope)) {
    denied('unsupported boot supervisor');
  }
  const node = executable(nodePath, [uid, 0]);
  // Stable recovery uses flock for serialized controller mutation, and a PTY
  // transport for interactive runtime startup without a login terminal.
  executable('/usr/bin/flock', [uid, 0]);
  executable('/usr/bin/tmux', [uid, 0]);
  const bootstrap = fs.realpathSync(bootstrapPath);
  if (bootstrap !== path.join(directory, 'bootstrap.cjs')) denied('bootstrap must be at the stable fixed path');
  const bst = fs.statSync(bootstrap);
  if (!bst.isFile() || ![uid, 0].includes(bst.uid) || (bst.mode & 0o022)) denied('bootstrap is not protected');
  const runtime = configuration.runtime;
  if (!runtime || !['codex', 'claude'].includes(runtime.kind) || runtime.cwd !== root || !Array.isArray(runtime.args)
      || runtime.args.length > 64 || runtime.args.some(arg => typeof arg !== 'string' || arg.length > 4096 || /[\0\r\n]/.test(arg))) {
    denied('invalid runtime launch specification');
  }
  const command = executable(runtime.command, [uid, 0]);
  try { validateUpgradeRuntimeArgs(runtime.kind,runtime.args);validateUpgradeRuntimeNetworkEnv(runtime.networkEnv); }
  catch { denied('runtime arguments must use supported flags without subcommands or positional prompts'); }
  // Codex distributions resolve a launcher script to codex.js; Claude may be a
  // versioned native executable. Verify the configured launcher name as well.
  if (path.basename(runtime.command) !== runtime.kind) denied('runtime command does not match its declared kind');
  const flags = supervisor.scope === 'user' ? ['--user'] : [];
  const invoke = (program, argv, options = {}) => run(program, argv, { encoding: 'utf8', timeout: 10000, maxBuffer: 65536, ...options });
  const enabled = invoke('systemctl', [...flags, 'is-enabled', supervisor.unit]);
  if (enabled.error || enabled.status !== 0 || String(enabled.stdout).trim() !== 'enabled') denied('supervisor unit is not enabled for boot');
  const properties = invoke('systemctl', [...flags, 'show', supervisor.unit, '--property=LoadState', '--property=FragmentPath', '--property=DropInPaths']);
  if (properties.error || properties.status !== 0) denied('supervisor cannot be inspected');
  const props = Object.fromEntries(String(properties.stdout).trim().split(/\r?\n/).map(line => {
    const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)];
  }));
  if (props.LoadState !== 'loaded' || props.DropInPaths) denied('unit is unloaded or has unreviewed overrides');
  const unit = fs.realpathSync(props.FragmentPath || denied('missing unit fragment'));
  const roots = deps.unitDirectories || (supervisor.scope === 'system'
    ? ['/etc/systemd/system', '/usr/lib/systemd/system', '/lib/systemd/system']
    : [path.join(home, '.config/systemd/user')]);
  if (!roots.some(dir => path.dirname(unit) === fs.realpathSync(dir)) || path.basename(unit) !== supervisor.unit) denied('unit is outside the supported supervisor directory');
  const ust = fs.statSync(unit);
  if (!ust.isFile() || ![0, uid].includes(ust.uid) || (ust.mode & 0o022)) denied('unit file ownership or permissions are unsafe');
  const fields = unitFields(fs.readFileSync(unit, 'utf8'));
  // Declared ExecStart alone is insufficient: conditions, alternate roots and
  // executable filters can prevent or redirect that exact launch at boot.
  const supported=new Set(['Unit.Description','Unit.DefaultDependencies','Unit.After','Unit.Wants','Service.Type','Service.User','Service.ExecStart','Service.Restart','Service.RestartSec','Service.StandardOutput','Service.StandardError','Install.WantedBy']);
  for(const key of fields.keys())if(!supported.has(key))denied('unit has an unsupported directive: '+key);
  for(const key of ['Unit.After','Unit.Wants'])if(fields.has(key)&&!fields.get(key).split(/\s+/).every(value=>['network.target','network-online.target'].includes(value)))denied('unit has unsupported boot dependencies');
  if(fields.has('Unit.DefaultDependencies')&&!['yes','no'].includes(fields.get('Unit.DefaultDependencies')))denied('invalid unit default dependency setting');
  if(fields.has('Service.Restart')&&!['always','on-failure','no'].includes(fields.get('Service.Restart')))denied('unsupported supervisor restart setting');
  if(fields.has('Service.RestartSec')&&!/^\d+(?:s)?$/.test(fields.get('Service.RestartSec')))denied('unsupported supervisor restart interval');
  for(const key of ['Service.StandardOutput','Service.StandardError'])if(fields.has(key)&&!['journal','null','inherit'].includes(fields.get(key)))denied('unsupported supervisor output transport');
  if (fields.get('Install.WantedBy') !== (supervisor.scope === 'system' ? 'multi-user.target' : 'default.target')) denied('unit is not attached to the normal boot target');
  if (!['simple', 'exec', undefined].includes(fields.get('Service.Type'))) denied('unsupported supervisor service type');
  const argv = parseLiteralSystemdArgv(fields.get('Service.ExecStart'));
  const expected = [nodePath, bootstrapPath, '--root', root, '--launch-runtime'];
  if (JSON.stringify(argv) !== JSON.stringify(expected) || fs.realpathSync(argv[0]) !== node) denied('boot unit does not run the fixed bootstrap/runtime launch path');
  if (fields.get('Service.User') !== (supervisor.scope === 'system' ? username : undefined)) denied('unit must run as the deployment owner');
  if (fields.has('Service.Environment') || fields.has('Service.EnvironmentFile') || fields.has('Service.ExecStartPre') || fields.has('Service.ExecStartPost')) {
    denied('unit has unreviewed environment or extra commands');
  }
  if (supervisor.scope === 'user') {
    const linger = invoke('loginctl', ['show-user', username, '--property=Linger', '--value']);
    if (linger.error || linger.status !== 0 || String(linger.stdout).trim() !== 'yes') denied('user supervisor cannot start without an interactive login');
  }
  // Probe native persisted login, with transient API/session credentials removed.
  // Never include authentication output in diagnostics or return values.
  const env = {
    HOME: home, USER: username, LOGNAME: username,
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    LANG: process.env.LANG || 'C.UTF-8',
    ...validateUpgradeRuntimeNetworkEnv(runtime.networkEnv),
  };
  const terminal=invoke('/usr/bin/tmux',['-V'],{env,cwd:root});
  if(terminal.error||terminal.status!==0)denied('runtime terminal transport is unavailable in the boot environment');
  const auth = invoke(runtime.command, runtime.kind === 'codex' ? ['login', 'status'] : ['auth', 'status', '--json'], { env, cwd: root });
  if (auth.error || auth.status !== 0) denied('runtime persisted authentication is unavailable');
  if (runtime.kind === 'codex' && classifyCodexLoginStatus(String(auth.stdout||'')+'\n'+String(auth.stderr||'')) !== 'success') {
    denied('runtime persisted authentication is unavailable');
  }
  if (runtime.kind === 'claude') {
    let status;
    try { status = JSON.parse(auth.stdout); } catch { denied('runtime authentication status is invalid'); }
    if (status.loggedIn !== true) denied('runtime persisted authentication is unavailable');
  }
  const {networkEnv,...savedRuntime}=runtime;
  return { supervisor: { ...supervisor, fragmentPath: unit }, runtime: { ...savedRuntime, command, networkConfigured:Object.keys(validateUpgradeRuntimeNetworkEnv(networkEnv)) }, authenticated: true, verified: true };
}
