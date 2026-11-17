import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { afterEach, describe, expect, test } from '@jest/globals';

/*
 * Runs the real scripts/install.sh to cover how it decides whether a terminal
 * is available (#917). Every external command the installer may reach is a
 * recording stub in a private bin directory: curl, git, tmux, node, npm,
 * zylos, sudo and the package managers. PATH holds only that directory plus
 * links to the few system utilities the script needs, so nothing is installed
 * and nothing reaches the network. The installer's environment is built from
 * scratch rather than inherited from the test runner, and HOME, NVM_DIR and
 * TMPDIR live in a fresh fixture that afterEach removes; never point this test
 * at a live instance.
 *
 * Run when the consent prompt, the /dev/tty probe or the zylos init hand-off in
 * scripts/install.sh changes. Skip for changes that do not touch the
 * installer. The pseudo-terminal cases need util-linux script(1) and are
 * skipped without it (macOS ships the BSD variant, which rejects the socket
 * Node uses for a child's stdin).
 */

const root = fileURLToPath(new URL('../', import.meta.url));
const installer = path.join(root, 'scripts', 'install.sh');
const supported = process.platform === 'linux' || process.platform === 'darwin';
const suite = supported ? describe : describe.skip;
const RUN_TIMEOUT_MS = 30000;
const TEST_TIMEOUT_MS = RUN_TIMEOUT_MS + 5000;
const SYSTEM_UTILITIES = ['bash', 'basename', 'cat', 'cut', 'grep', 'head', 'id', 'mkdir', 'ln', 'sed', 'sleep', 'uname'];
const STUBBED_COMMANDS = ['curl', 'git', 'tmux', 'node', 'npm', 'zylos', 'sudo', 'apt-get', 'dnf', 'yum', 'brew'];
const STUB_TAG = 'v0.0.0-installer-test';
const INSTALL_URL = `https://github.com/zylos-ai/zylos-core#${STUB_TAG}`;
const RELEASE_LOOKUP = 'curl -fsSL https://api.github.com/repos/zylos-ai/zylos-core/releases/latest';

const fixtures = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fs.rmSync(fixture, { recursive: true, force: true });
});

function which(command) {
  return execFileSync('/bin/sh', ['-c', 'command -v "$1"', 'sh', command], { encoding: 'utf8' }).trim();
}

function findUtilLinuxScript() {
  try {
    const script = which('script');
    return execFileSync(script, ['--version'], { encoding: 'utf8' }).includes('util-linux') ? script : null;
  } catch {
    return null;
  }
}

const scriptPath = process.platform === 'linux' ? findUtilLinuxScript() : null;

// Each stub appends "<name> <args>" to $INSTALL_TEST_CALLS; zylos init also
// records whether its stdin is a terminal. Commands the installer must not
// reach in these scenarios exit 97, and the call log makes any such attempt
// fail the exact-calls assertion.
function stubBody(name) {
  const responses = {
    curl: `case "$*" in
  *api.github.com/repos/zylos-ai/zylos-core/releases/latest*) printf '{\\n  "tag_name": "${STUB_TAG}"\\n}\\n' ;;
  *) exit 97 ;;
esac`,
    git: 'printf "git version 2.0.0-stub\\n"',
    tmux: 'printf "tmux 3.4-stub\\n"',
    node: 'printf "v24.0.0\\n"',
    npm: `case "$1 \${2:-}" in
  "config get") printf "%s\\n" "$INSTALL_TEST_NPM_PREFIX" ;;
  "install -g") ln -s "$INSTALL_TEST_ZYLOS" "$INSTALL_TEST_BIN/zylos" ;;
  *) exit 97 ;;
esac`,
    zylos: `case "\${1:-}" in
  --version) printf "%s\\n" "$INSTALL_TEST_VERSION" ;;
  init) if [ -t 0 ]; then printf "stdin=tty\\n" >> "$INSTALL_TEST_CALLS"; else printf "stdin=other\\n" >> "$INSTALL_TEST_CALLS"; fi ;;
  *) exit 97 ;;
esac`,
  };
  return responses[name] ?? 'exit 97';
}

function makeFixture({ missing = [], manager = 'apt-get', uid = '0', osName, installStatus = 0, installed = true, version = '0.0.0-stub' } = {}) {
  const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zit-')));
  fixtures.push(fixture);
  const dirs = Object.fromEntries(['home', 'bin', 'tmp', 'npm-prefix', 'zylos', 'pm2'].map((name) => {
    const dir = path.join(fixture, name);
    fs.mkdirSync(dir);
    return [name, fs.realpathSync(dir)];
  }));
  const bash = which('bash');
  for (const utility of SYSTEM_UTILITIES) fs.symlinkSync(which(utility), path.join(dirs.bin, utility));
  for (const name of STUBBED_COMMANDS) {
    fs.writeFileSync(name === 'zylos' ? path.join(fixture, 'zylos-command') : path.join(dirs.bin, name), `#!${bash}
printf '%s' ${name} >> "$INSTALL_TEST_CALLS"
for arg in "$@"; do printf ' %s' "$arg" >> "$INSTALL_TEST_CALLS"; done
printf '\\n' >> "$INSTALL_TEST_CALLS"
${stubBody(name)}
`, { mode: 0o700 });
  }
  for (const name of ['ps', 'pgrep']) {
    if (!missing.includes(name)) fs.writeFileSync(path.join(dirs.bin, name), `#!${bash}\nexit 0\n`, { mode: 0o700 });
  }
  // Recording package managers never install anything on the host.
  for (const name of ['apt-get', 'dnf', 'yum']) {
    if (name !== manager) fs.unlinkSync(path.join(dirs.bin, name));
  }
  fs.writeFileSync(path.join(dirs.bin, manager), `#!${bash}
    printf '%s\\n' "${manager} $*" >> "$INSTALL_TEST_CALLS"
    exit ${installStatus}
  `, { mode: 0o700 });
  fs.unlinkSync(path.join(dirs.bin, 'id'));
  fs.writeFileSync(path.join(dirs.bin, 'id'), `#!${bash}\nprintf '${uid}\\n'\n`, { mode: 0o700 });
  if (uid !== '0') fs.unlinkSync(path.join(dirs.bin, 'sudo'));
  if (osName) {
    fs.unlinkSync(path.join(dirs.bin, 'uname'));
    fs.writeFileSync(path.join(dirs.bin, 'uname'), `#!${bash}\nif [ "$1" = '-s' ]; then echo '${osName}'; else echo x86_64; fi\n`, { mode: 0o700 });
  }
  // The root courtesy delay is outside these prerequisite/terminal assertions.
  fs.unlinkSync(path.join(dirs.bin, 'sleep'));
  fs.writeFileSync(path.join(dirs.bin, 'sleep'), `#!${bash}\nexit 0\n`, { mode: 0o700 });
  if (installed) fs.symlinkSync(path.join(fixture, 'zylos-command'), path.join(dirs.bin, 'zylos'));
  const calls = path.join(fixture, 'calls');
  const env = {
    HOME: dirs.home,
    ZYLOS_DIR: dirs.zylos,
    PM2_HOME: dirs.pm2,
    NVM_DIR: path.join(dirs.home, '.nvm'),
    TMPDIR: dirs.tmp,
    PATH: dirs.bin,
    SHELL: path.join(dirs.bin, 'bash'),
    INSTALL_TEST_CALLS: calls,
    INSTALL_TEST_BIN: dirs.bin,
    INSTALL_TEST_ZYLOS: path.join(fixture, 'zylos-command'),
    INSTALL_TEST_NPM_PREFIX: dirs['npm-prefix'],
  };
  // Read back every path the installer or a stub may use, failing closed on drift.
  for (const value of Object.values(env)) {
    expect(path.resolve(value).startsWith(fixture + path.sep)).toBe(true);
  }
  for (const dir of Object.values(dirs)) expect(fs.realpathSync(dir)).toBe(dir);
  env.INSTALL_TEST_VERSION = version;
  expect(fs.readdirSync(dirs.home)).toEqual([]);
  return { fixture, dirs, env, calls, bash };
}

// The stub zylos is already on PATH, so the installer reports the existing
// version and leaves the executable untouched.
function fullInstallCalls(init, initStdin) {
  return [
    RELEASE_LOOKUP,
    'git --version',
    'tmux -V',
    'node -v',
    'node -v',
    'zylos --version',
    init,
    initStdin,
  ];
}

function readCalls(calls) {
  return fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n') : [];
}

// Runs the command in a new session (setsid), so it has no controlling
// terminal regardless of how the test runner was started.
function run(command, args, { env, cwd, input }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.stdin.on('error', () => {});
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    }, RUN_TIMEOUT_MS);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, output });
    });
    child.stdin.end(input);
  });
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

// Pipes the installer into bash on a fresh pseudo-terminal, as
// `curl ... | bash` does in an interactive session, and types the consent
// answer into the terminal. script -e passes the pipeline's exit status through.
function runInPty({ env, dirs, bash }, answer) {
  const command = `cat ${shellQuote(installer)} | ${shellQuote(bash)}`;
  return run(scriptPath, ['-qec', command, '/dev/null'], { env, cwd: dirs.home, input: `${answer}\n` });
}

const ptyTest = scriptPath ? test : test.skip;

suite('scripts/install.sh terminal handling', () => {
  // Boundary: `curl ... | bash` without a controlling terminal (ssh -T, cron,
  // CI). /dev/tty exists but cannot be opened, so the consent prompt must be
  // skipped and zylos init must run without reading from /dev/tty.
  test('without a controlling terminal skips the consent prompt and runs init', async () => {
    const context = makeFixture();
    const result = await run(context.bash, ['-s'], {
      env: context.env, cwd: context.dirs.home, input: fs.readFileSync(installer, 'utf8'),
    });

    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
    expect(result.output).not.toContain('Security Notice');
    expect(result.output).not.toContain('/dev/tty');
    expect(result.output).toContain('Installation complete!');
    expect(readCalls(context.calls)).toEqual(fullInstallCalls('zylos init', 'stdin=other'));
  }, TEST_TIMEOUT_MS);

  // Boundary: `curl ... | bash` in an interactive terminal, user declines. Nothing past the
  // release lookup may run and HOME must stay untouched.
  ptyTest('in a terminal, answering n cancels before anything is installed', async () => {
    const context = makeFixture();
    const result = await runInPty(context, 'n');

    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
    expect(result.output).toContain('Security Notice');
    expect(result.output).toContain('Installation cancelled. No changes were made.');
    expect(readCalls(context.calls)).toEqual([RELEASE_LOOKUP]);
    expect(fs.readdirSync(context.dirs.home)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  // Boundary: `curl ... | bash` in an interactive terminal, user accepts. The
  // installer must pass --skip-consent so zylos init does not ask again, and
  // hand init the terminal instead of the piped script on stdin.
  ptyTest('in a terminal, answering y runs zylos init --skip-consent on the terminal', async () => {
    const context = makeFixture();
    const result = await runInPty(context, 'y');

    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
    expect(result.output).toContain('Security Notice');
    expect(result.output).not.toContain('Installation cancelled');
    expect(readCalls(context.calls)).toEqual(fullInstallCalls('zylos init --skip-consent', 'stdin=tty'));
  }, TEST_TIMEOUT_MS);

  // Boundary: `curl ... | bash` in an interactive terminal, user presses Enter.
  // The prompt defaults to Y, so an empty answer must install exactly like y.
  ptyTest('in a terminal, pressing Enter accepts the default like answering y', async () => {
    const context = makeFixture();
    const result = await runInPty(context, '');

    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
    expect(result.output).toContain('Security Notice');
    expect(result.output).not.toContain('Installation cancelled');
    expect(readCalls(context.calls)).toEqual(fullInstallCalls('zylos init --skip-consent', 'stdin=tty'));
  }, TEST_TIMEOUT_MS);
});

// Boundary: real install.sh prerequisite selection and failure propagation, with
// every package/install command recorded in a private PATH. Run when procps
// detection or package selection changes; skip for unrelated installer changes.
// makeFixture verifies HOME/NVM_DIR/TMPDIR and all writable paths before launch.
for (const manager of ['apt-get', 'dnf', 'yum']) {
  for (const missing of [['ps'], ['pgrep'], ['ps', 'pgrep']]) {
    test(`installer selects ${manager} package when missing ${missing.join(' and ')}`, async () => {
      const context = makeFixture({ missing, manager });
      const result = await run(context.bash, [installer, '--branch', STUB_TAG, '--no-init'], {
        env: context.env, cwd: context.dirs.home,
      });
      expect(result.status).toBe(0);
      const calls = readCalls(context.calls);
      expect(calls.filter(call => call.startsWith(`${manager} `))).toEqual(manager === 'apt-get'
        ? ['apt-get update -qq', 'apt-get install -y -qq procps'] : [`${manager} install -y procps-ng`]);
      expect(result.output).toContain('procps: installed');
      expect(result.output).toContain('Installation complete!');
    }, TEST_TIMEOUT_MS);
  }
}

test('installer reports existing procps without package installation', async () => {
  const context = makeFixture();
  const result = await run(context.bash, [installer, '--branch', STUB_TAG, '--no-init'], {
    env: context.env, cwd: context.dirs.home,
  });
  expect(result.status).toBe(0);
  expect(result.output.match(/procps: ps and pgrep available/g)).toHaveLength(1);
  expect(readCalls(context.calls).some(call => /^(apt-get|dnf|yum|brew) /.test(call))).toBe(false);
}, TEST_TIMEOUT_MS);

test('installer requires manual procps installation without root or sudo', async () => {
  const context = makeFixture({ missing: ['ps'], uid: '1000' });
  const result = await run(context.bash, [installer, '--branch', STUB_TAG, '--no-init'], {
    env: context.env, cwd: context.dirs.home,
  });
  expect(result.status).toBe(1);
  expect(result.output).toContain('sudo not found and not running as root. Please install procps manually as root');
  expect(readCalls(context.calls).some(call => /^(apt-get|npm) /.test(call))).toBe(false);
}, TEST_TIMEOUT_MS);

test('installer leaves macOS procps unchanged even when commands are missing', async () => {
  const context = makeFixture({ missing: ['ps', 'pgrep'], osName: 'Darwin' });
  const result = await run(context.bash, [installer, '--branch', STUB_TAG, '--no-init'], {
    env: context.env, cwd: context.dirs.home,
  });
  expect(result.status).toBe(0);
  expect(result.output).not.toContain('procps:');
  expect(readCalls(context.calls).some(call => /^(apt-get|dnf|yum|brew) /.test(call))).toBe(false);
}, TEST_TIMEOUT_MS);

test('installer stops when procps package installation fails', async () => {
  const context = makeFixture({ missing: ['ps'], installStatus: 42 });
  const result = await run(context.bash, [installer, '--branch', STUB_TAG, '--no-init'], {
    env: context.env, cwd: context.dirs.home,
  });
  expect(result.status).toBe(42);
  expect(result.output).not.toContain('procps: installed');
  expect(readCalls(context.calls).some(call => call.startsWith('npm '))).toBe(false);
}, TEST_TIMEOUT_MS);

// Boundary: installer command routing and PATH/init continuation with isolated
// command doubles. Run for install_zylos or branch argument changes; skip for
// unrelated code. This does not cover npm's real Git installation internals.
suite('scripts/install.sh existing installations', () => {
  test('a fresh installation keeps the GitHub source URL and install flags', async () => {
    const context = makeFixture({ installed: false });
    const result = await run(context.bash, [installer, '--no-init'], {
      env: context.env, cwd: context.dirs.home,
    });
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
    expect(readCalls(context.calls)).toEqual([
      RELEASE_LOOKUP, 'git --version', 'tmux -V', 'node -v', 'node -v',
      'npm config get prefix', `npm install -g --install-links ${INSTALL_URL}`,
      'zylos --version',
    ]);
    expect(result.output).toContain(`Installing zylos from GitHub (${STUB_TAG})...`);
    expect(result.output).toContain('Skipping zylos init (--no-init).');
  }, TEST_TIMEOUT_MS);

  test.each(['0.9.6', '1.0.0-beta.11'])(
    'preserves installed version %s and continues PATH setup without init', async (version) => {
      const context = makeFixture({ version });
      const executable = fs.readFileSync(context.env.INSTALL_TEST_ZYLOS, 'utf8');
      const result = await run(context.bash, [installer, '--no-init'], {
        env: context.env, cwd: context.dirs.home,
      });
      expect(result.signal).toBeNull();
      expect(result.status).toBe(0);
      expect(readCalls(context.calls)).toEqual([
        RELEASE_LOOKUP, 'git --version', 'tmux -V', 'node -v', 'node -v', 'zylos --version',
      ]);
      expect(result.output).toContain(`zylos is already installed (${version}). To upgrade, run: zylos upgrade --self\n`);
      expect(result.output).not.toContain('Upgrading...');
      expect(result.output).not.toContain('ENOTEMPTY');
      expect(result.output).toContain('Skipping zylos init (--no-init).');
      expect(fs.readFileSync(context.env.INSTALL_TEST_ZYLOS, 'utf8')).toBe(executable);
      expect(fs.readFileSync(path.join(context.dirs.home, '.bashrc'), 'utf8')).toContain('zylos-managed: bin PATH');
    }, TEST_TIMEOUT_MS,
  );

  test('an explicit branch only changes the upgrade hint and init still runs', async () => {
    const context = makeFixture({ version: '1.0.0-beta.11' });
    const result = await run(context.bash, [installer, '--branch', 'multi-session/prerelease', '-y'], {
      env: context.env, cwd: context.dirs.home,
    });
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
    expect(result.output).toContain('To upgrade, run: zylos upgrade --self --branch multi-session/prerelease');
    expect(result.output).not.toContain('Upgrading...');
    expect(readCalls(context.calls)).toEqual([
      'git --version', 'tmux -V', 'node -v', 'node -v', 'zylos --version',
      'zylos init -y', 'stdin=other',
    ]);
  }, TEST_TIMEOUT_MS);
});
