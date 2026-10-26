#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const versions = ['3.2a', '3.3a', '3.4', '3.7c', '3.8'];
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const usage = 'Usage: node scripts/run-tmux-matrix.js --output NEW_DIRECTORY 3.2a=/path/to/tmux 3.3a=/path/to/tmux 3.4=/path/to/tmux 3.7c=/path/to/tmux 3.8=/path/to/tmux';
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') { console.log(usage); process.exit(0); }
if (args[0] !== '--output' || args.length !== 7) throw Error(usage);
const output = path.resolve(args[1]);
const binaries = new Map();
for (const arg of args.slice(2)) {
  const separator = arg.indexOf('=');
  const version = arg.slice(0, separator);
  if (separator < 0 || !versions.includes(version) || binaries.has(version)) throw Error(usage);
  const binary = fs.realpathSync(path.resolve(arg.slice(separator + 1)));
  fs.accessSync(binary, fs.constants.X_OK);
  const observed = execFileSync(binary, ['-V'], { encoding: 'utf8', timeout: 5000 }).trim();
  if (observed !== `tmux ${version}`) throw Error(`Expected tmux ${version}, observed ${observed}`);
  binaries.set(version, binary);
}
// Never overwrite evidence from an earlier invocation.
fs.mkdirSync(output);
const testDir = 'cli/lib/runtime/__tests__';
const tests = fs.readdirSync(path.join(repo, testDir)).filter(name => name.endsWith('.test.js')).sort().map(name => `${testDir}/${name}`);
tests.push(
  'skills/comm-bridge/scripts/__tests__/router-delivery-tmux.test.js',
  'cli/lib/__tests__/session-group-paths.test.js',
  'skills/activity-monitor/scripts/__tests__/supervisor-tmux-stress.test.js',
);
const sha256 = filename => createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
const sourceHashes = {};
function hashTree(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) hashTree(filename);
    else if (entry.name.endsWith('.js')) sourceHashes[path.relative(repo, filename)] = sha256(filename);
  }
}
hashTree(path.join(repo, 'cli/lib/runtime'));
sourceHashes['scripts/run-node-tests.js'] = sha256(path.join(repo, 'scripts/run-node-tests.js'));
sourceHashes['scripts/run-tmux-matrix.js'] = sha256(fileURLToPath(import.meta.url));
sourceHashes['test/helpers/isolated-tmux.js'] = sha256(path.join(repo, 'test/helpers/isolated-tmux.js'));
sourceHashes['skills/comm-bridge/scripts/tmux-protocol.js'] = sha256(path.join(repo, 'skills/comm-bridge/scripts/tmux-protocol.js'));
for (const filename of tests) sourceHashes[filename] = sha256(path.join(repo, filename));
const summary = { head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
  node: process.version, platform: process.platform, tests, sourceHashes, versions: [] };
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-matrix-'));
let active;
const stop = signal => active?.kill(signal);
process.on('SIGINT', stop); process.on('SIGTERM', stop);
async function run(selected, env, filename) {
  const fd = fs.openSync(filename, 'wx');
  try {
    active = spawn(process.execPath, ['scripts/run-node-tests.js', ...selected], {
      cwd: repo, env, stdio: ['ignore', fd, fd],
    });
    return await new Promise((resolve, reject) => {
      active.once('error', reject);
      active.once('close', (code, signal) => resolve({ code, signal }));
    });
  } finally { active = null; fs.closeSync(fd); }
}
try {
  for (const version of versions) {
    const binary = binaries.get(version);
    const binDir = path.join(temporary, version); fs.mkdirSync(binDir);
    fs.symlinkSync(binary, path.join(binDir, 'tmux'));
    const supervisorLog = path.join(output, `tmux-${version}-supervisor-stress.json`);
    const env = { ...process.env, TEST_TMUX_BIN: binary, PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
      ZYLOS_TMUX_CHURN_STRESS: '1', P05_TMUX_STRESS: '1',
      P05_LAUNCH_ROUNDS: '300', P05_DELIVERY_ROUNDS: '150', P05_STRESS_RESULT: supervisorLog };
    delete env.ZYLOS_TMUX_BAD_CONTROL;
    const runtimeLog = path.join(output, `tmux-${version}-runtime.tap`);
    console.log(`${version}: ${tests.length} runtime/caller files, including adapter and supervisor stress`);
    const runtime = await run(tests, env, runtimeLog);
    const text = fs.readFileSync(runtimeLog, 'utf8');
    const metricsLine = text.split('\n').find(line => /^# \{"matrixStress":true,/.test(line));
    const metrics = metricsLine ? JSON.parse(metricsLine.slice(2)) : null;
    const supervisorMetrics = fs.existsSync(supervisorLog) ? JSON.parse(fs.readFileSync(supervisorLog, 'utf8')) : null;
    const badLog = path.join(output, `tmux-${version}-bad-control.tap`);
    const bad = await run([`${testDir}/session-adapter-churn.test.js`], { ...env, ZYLOS_TMUX_BAD_CONTROL: '1' }, badLog);
    const badText = fs.readFileSync(badLog, 'utf8');
    const badDetected = bad.code === 1 && badText.includes('stale-message') && badText.includes('GENERATION_CHANGED');
    const record = { version, binary, binarySha256: sha256(binary), runtime, runtimeLog, metrics,
      supervisorLog, supervisorMetrics, bad, badLog, badDetected,
      tests: Number(text.match(/^# tests (\d+)$/m)?.[1]), failures: Number(text.match(/^# fail (\d+)$/m)?.[1]),
      skipped: Number(text.match(/^# skipped (\d+)$/m)?.[1]) };
    record.passed = runtime.code === 0 && metrics?.launches >= 300 && metrics?.deliveries >= 150 &&
      metrics.churnRounds > 0 && metrics.errors === 0 && metrics.serverCrashes === 0 &&
      metrics.wrongPaneLines === 0 && metrics.missingLines === 0 &&
      supervisorMetrics?.launchRounds >= 300 && supervisorMetrics?.deliveryRounds >= 150 &&
      supervisorMetrics.churnCycles > 0 && supervisorMetrics.errors.length === 0 &&
      supervisorMetrics.serverLost === false && supervisorMetrics.foreignLines === 0 &&
      supervisorMetrics.missingLines === 0 && supervisorMetrics.duplicates === 0 && badDetected;
    summary.versions.push(record);
    fs.writeFileSync(path.join(output, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(`${version}: ${record.passed ? 'PASS' : 'FAIL'}; positive control detected=${badDetected}`);
    if (runtime.signal || bad.signal) break;
  }
} finally {
  process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  fs.rmSync(temporary, { recursive: true, force: true });
}
if (summary.versions.length !== versions.length || summary.versions.some(record => !record.passed)) process.exitCode = 1;
