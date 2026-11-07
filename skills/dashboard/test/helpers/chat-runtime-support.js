import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const runtimeProxyNames = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'];

export function nativeRuntimeEnvironment(sandbox) {
  // Core's Claude adapter confirms onboarding in HOME/.claude.json. Let the
  // real CLI use that same default, rather than a second config-root file.
  delete sandbox.env.CLAUDE_CONFIG_DIR;
  return sandbox.env;
}

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
// No home/auth/config/history directory is traversed or copied. Each call is
// bounded to six 64KiB log tails, four 64KiB panes, and one small failure file.
export function retainNativeFailure(sandbox, { directory, scenario, tmuxBinary, error, stdout = '', stderr = '' } = {}) {
  sandbox.assertIsolation();
  assert.ok(path.isAbsolute(directory), 'Runtime evidence directory must be absolute');
  const resolved = path.resolve(directory);
  assert.ok(!within(sandbox.root, resolved) && !within(packageRoot, resolved), 'Runtime evidence must outlive the sandbox and stay outside the repository');
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  const canonical = fs.realpathSync(resolved);
  assert.ok(!within(sandbox.root, canonical) && !within(packageRoot, canonical), 'Runtime evidence directory may not redirect into sandbox or repository');
  const output = fs.mkdtempSync(path.join(canonical, `${scenario}-`));
  const secrets = runtimeProxyNames.map(key => sandbox.env[key]).filter(value => typeof value === 'string' && value.length);
  const redact = value => {
    let text = String(value ?? '');
    for (const secret of secrets) text = text.replaceAll(secret, '[REDACTED_PROXY]');
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
  save('failure.log', JSON.stringify({ scenario, message: String(error?.stack || error || '').slice(-16000),
    stdout: stdout.slice(-16000), stderr: stderr.slice(-16000), captureErrors }, null, 2));
  return { directory: output, files, captureErrors: captureErrors.map(redact) };
}
