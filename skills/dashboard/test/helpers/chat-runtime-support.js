import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const runtimeProxyNames = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'];

export function writeNativeRuntimeManifest(root, bin) {
  fs.writeFileSync(path.join(root, '.zylos/runtime-env.manifest'), [
    `path_prepend ${bin}`, ...['ZYLOS_PACKAGE_ROOT', 'CODEX_HOME', 'PM2_HOME', 'TMPDIR',
      'TMUX_TMPDIR', 'NODE_OPTIONS', 'CLAUDE_BIN', 'CODEX_BIN', ...runtimeProxyNames].map(key => `inherit ${key}`),
  ].join('\n') + '\n');
}

const within = (root, filename) => filename === root || filename.startsWith(root + path.sep);
const packageRoot = path.resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const byteLimit = 65536;
const logFiles = ['activity-monitor/native-fixture.log', 'activity-monitor/supervisor-events.jsonl',
  'activity-monitor/pool-metrics.jsonl', 'activity-monitor/hook-activity-errors.log',
  'comm-bridge/router-events.jsonl', 'comm-bridge/receive-events.jsonl'];

// Collect only this proven fixture's known runtime logs and terminal panes.
// Only the two copied sandbox auth JSON files are read to build an in-memory
// redaction list; no auth/config/history file is copied to the evidence. Each
// call retains at most six 64KiB log tails, four 64KiB panes and a failure file.
export function retainNativeFailure(sandbox, { directory, scenario, tmuxBinary, error, stdout = '', stderr = '' } = {}) {
  sandbox.assertIsolation();
  assert.ok(path.isAbsolute(directory), 'Runtime evidence directory must be absolute');
  const resolved = path.resolve(directory);
  assert.ok(!within(sandbox.root, resolved) && !within(packageRoot, resolved), 'Runtime evidence must outlive the sandbox and stay outside the repository');
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  const canonical = fs.realpathSync(resolved);
  assert.ok(!within(sandbox.root, canonical) && !within(packageRoot, canonical), 'Runtime evidence directory may not redirect into sandbox or repository');
  const output = fs.mkdtempSync(path.join(canonical, `${scenario}-`));
  const secrets = new Set(runtimeProxyNames.map(key => sandbox.env[key]).filter(value => typeof value === 'string' && value.length));
  for (const relative of ['.claude/.credentials.json', '.codex/auth.json']) {
    const filename = path.join(sandbox.paths.home, relative);
    try {
      const stat = fs.lstatSync(filename);
      assert.ok(stat.isFile() && !stat.isSymbolicLink() && within(sandbox.paths.home, fs.realpathSync(filename)),
        'Redaction credentials must be copied files inside the sandbox home');
      let credentials;
      try { credentials = JSON.parse(fs.readFileSync(filename, 'utf8')); }
      catch { throw Error('Cannot read sandbox credential JSON for failure redaction'); }
      const pending = [credentials];
      while (pending.length) {
        const value = pending.pop();
        if (typeof value === 'string' && value.length >= 8) {
          secrets.add(value);
          secrets.add(JSON.stringify(value).slice(1, -1));
        } else if (value && typeof value === 'object') pending.push(...Object.values(value));
      }
    } catch (failure) { if (failure.code !== 'ENOENT') throw failure; }
  }
  const literals = [...secrets].sort((left, right) => right.length - left.length);
  const redact = value => {
    let text = String(value ?? '');
    for (const secret of literals) text = text.replaceAll(secret, '[REDACTED]');
    text = text.replace(/sk-ant-[\w-]+/g, '[REDACTED]')
      .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[REDACTED]');
    return text.replace(/(Bearer\s+)[^\s"']+/gi, '$1[REDACTED]')
      .replace(/("?(?:access_?token|refresh_?token|api_?key|password|authorization)"?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,}]+)/gi, '$1"[REDACTED]"');
  };
  const files = [], captureErrors = [];
  const save = (name, value) => {
    const bytes = Buffer.from(redact(value));
    fs.writeFileSync(path.join(output, name), bytes.subarray(Math.max(0, bytes.length - byteLimit)), { mode: 0o600 });
    files.push(name);
  };
  for (const relative of logFiles) {
    const source = path.join(sandbox.paths.zylos, relative);
    try {
      const stat = fs.lstatSync(source);
      if (!stat.isFile() || stat.isSymbolicLink() || !within(sandbox.root, fs.realpathSync(source))) continue;
      const fd = fs.openSync(source, 'r');
      try {
        const bytes = Buffer.alloc(Math.min(byteLimit, stat.size));
        const count = fs.readSync(fd, bytes, 0, bytes.length, Math.max(0, stat.size - bytes.length));
        save(relative.replaceAll('/', '_'), bytes.subarray(0, count).toString('utf8'));
      } finally { fs.closeSync(fd); }
    } catch (failure) { if (failure.code !== 'ENOENT') captureErrors.push(`${relative}: ${failure.code || failure.message}`); }
  }
  const tmux = args => spawnSync(tmuxBinary, ['-S', sandbox.paths.socket, ...args], {
    env: sandbox.env, cwd: sandbox.paths.zylos, encoding: 'utf8', timeout: 2000, maxBuffer: byteLimit,
  });
  try {
    const listed = tmux(['list-panes', '-a', '-F', '#{pane_id}']);
    if (listed.status !== 0) captureErrors.push(`list-panes: ${listed.error?.code || listed.stderr || listed.status}`);
    else for (const pane of listed.stdout.split('\n').filter(value => /^%\d+$/.test(value)).slice(0, 4)) {
      const capture = tmux(['capture-pane', '-p', '-S', '-200', '-t', pane]);
      save(`pane-${pane.slice(1)}.log`, capture.stdout || capture.stderr || capture.error?.message || '');
      if (capture.status !== 0) captureErrors.push(`capture-pane ${pane}: ${capture.error?.code || capture.status}`);
    }
  } catch (failure) { captureErrors.push(`tmux capture: ${failure.code || failure.message}`); }
  save('failure.log', JSON.stringify({ scenario, message: redact(String(error?.stack || error || '').slice(-16000)),
    stdout: redact(stdout.slice(-16000)), stderr: redact(stderr.slice(-16000)), captureErrors: captureErrors.map(redact) }, null, 2));
  return { directory: output, files, captureErrors: captureErrors.map(redact) };
}
