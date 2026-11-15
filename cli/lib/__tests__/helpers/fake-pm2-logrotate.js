import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Fake `pm2` executable for log rotation tests. It records every invocation and
// mimics the PM2 module records that `pm2 set` and `pm2 install` write. Modes:
// success, fail, timeout (hangs with an npm-like child), no-record.
const SOURCE = `
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_PM2_LOG, JSON.stringify(args) + '\\n');
const file = path.join(process.env.PM2_HOME, 'module_conf.json');
const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
const write = conf => { fs.mkdirSync(process.env.PM2_HOME, { recursive: true }); fs.writeFileSync(file, JSON.stringify(conf, null, 4)); };
const mode = process.env.FAKE_PM2_MODE || 'success';
if (args[0] === 'set') {
  const [name, key] = args[1].split(':');
  const conf = read();
  conf[name] = { ...conf[name], [key]: args[2] };
  write(conf);
  process.exit(0);
}
if (args[0] === 'install') {
  if (mode === 'fail') { process.stderr.write('npm error code ENOTFOUND\\nnpm error network request failed\\n'); process.exit(1); }
  if (mode === 'timeout') {
    const child = spawn('sleep', ['600'], { stdio: 'ignore' });
    fs.writeFileSync(process.env.FAKE_PM2_CHILD, String(child.pid));
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === 'no-record') process.exit(0);
  const conf = read();
  const defaults = { max_size: '10M', retain: '30', compress: false, dateFormat: 'YYYY-MM-DD_HH-mm-ss', workerInterval: '30', rotateInterval: '0 0 * * *', rotateModule: true };
  conf[args[1]] = { ...defaults, ...conf[args[1]] };
  conf['module-db-v2'] = { ...conf['module-db-v2'], [args[1]]: {} };
  write(conf);
  process.exit(0);
}
process.stderr.write('unexpected fake PM2 command: ' + args.join(' '));
process.exit(64);
`;

export function fakePm2(t, { mode = 'success', installPm2 = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'logrotate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  const pm2Home = path.join(root, 'pm2-home');
  const log = path.join(root, 'calls.jsonl');
  const childPid = path.join(root, 'child.pid');
  fs.mkdirSync(bin);
  if (installPm2) fs.writeFileSync(path.join(bin, 'pm2'), `#!${process.execPath}\n${SOURCE}`, { mode: 0o755 });
  // The fake directory is the only PM2 on PATH; /usr/bin and /bin supply sleep and sh.
  const env = { HOME: root, PM2_HOME: pm2Home, PATH: [bin, '/usr/bin', '/bin'].join(path.delimiter),
    FAKE_PM2_MODE: mode, FAKE_PM2_LOG: log, FAKE_PM2_CHILD: childPid };
  return {
    root, bin, pm2Home, env,
    calls: () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [],
    conf: () => JSON.parse(fs.readFileSync(path.join(pm2Home, 'module_conf.json'), 'utf8')),
    confFile: path.join(pm2Home, 'module_conf.json'),
    childPid: () => Number(fs.readFileSync(childPid, 'utf8')),
    writeConf(conf) {
      fs.mkdirSync(pm2Home, { recursive: true });
      fs.writeFileSync(path.join(pm2Home, 'module_conf.json'), typeof conf === 'string' ? conf : JSON.stringify(conf, null, 4));
    },
  };
}

export function processAlive(pid) {
  try {
    const state = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1)[0];
    return state !== 'Z';
  } catch {
    try { process.kill(pid, 0); return true; } catch { return false; }
  }
}
