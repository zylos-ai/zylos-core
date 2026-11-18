import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

async function runChild(command, args, options) {
  const child = spawn(command, args, { ...options, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', failure;
  const stop = error => {
    failure ??= error;
    try { process.kill(-child.pid, 'SIGKILL'); } catch (err) { if (err.code !== 'ESRCH') throw err; }
  };
  const timer = setTimeout(() => stop(new Error('Upgrade fixture timed out')), 15000);
  try {
    for (const [stream, append] of [[child.stdout, s => { stdout += s; }], [child.stderr, s => { stderr += s; }]]) {
      stream.on('data', chunk => {
        if (failure) return;
        append(chunk.toString());
        if (stdout.length + stderr.length > 128 * 1024) stop(new Error('Upgrade fixture output limit exceeded'));
      });
    }
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') stop(error); });
    child.stdin.end(options.input ?? '');
    const status = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    if (failure) throw failure;
    return { status, stdout, stderr };
  } finally {
    clearTimeout(timer);
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
}

// Boundary: real upgrade command dispatch, confirmation and prompt. Native module
// mocks replace remote checks/downloads/installers; no service, tmux or DB starts.
// Run when upgrade admission or prompt behavior changes; skip unrelated changes.
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'uc-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const dir of ['home', 'tmp', 'deployment/.zylos', 'deployment/.claude/skills/sample', 'target/cli/lib']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  fs.writeFileSync(path.join(root, 'deployment/.zylos/components.json'), JSON.stringify({ sample: { version: '1.0.0', repo: 'fixture/component' } }));
  fs.writeFileSync(path.join(root, 'deployment/.claude/skills/sample/SKILL.md'), '---\nname: sample\nversion: 1.0.0\n---\n');
  fs.writeFileSync(path.join(root, 'target/package.json'), '{"type":"module","version":"1.0.1"}');
  fs.writeFileSync(path.join(root, 'target/cli/lib/upgrade-entry.js'),
    'import fs from "node:fs"; import path from "node:path"; fs.appendFileSync(path.join(process.env.UPGRADE_CONFIRMATION_ROOT, "calls"), "upgrade\\n");\n');
  const env = { ...process.env, HOME: path.join(root, 'home'), ZYLOS_DIR: path.join(root, 'deployment'),
    PM2_HOME: path.join(root, 'home/.pm2'), TMPDIR: path.join(root, 'tmp'), TMUX_TMPDIR: path.join(root, 'tmp'),
    UPGRADE_CONFIRMATION_ROOT: root, UPGRADE_MIGRATIONS: '0' };
  for (const name of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR']) {
    assert.ok(env[name].startsWith(root + path.sep));
  }
  t.diagnostic(JSON.stringify({ root, HOME: env.HOME, ZYLOS_DIR: env.ZYLOS_DIR, PM2_HOME: env.PM2_HOME,
    TMPDIR: env.TMPDIR, TMUX_TMPDIR: env.TMUX_TMPDIR, services: false, databases: false }));
  const calls = () => fs.existsSync(path.join(root, 'calls')) ? fs.readFileSync(path.join(root, 'calls'), 'utf8') : '';
  async function run(args, { tty = false, migrations = false } = {}) {
    const argv = ['--experimental-test-module-mocks', path.resolve('test/helpers/run-upgrade-confirmation.js'), ...args];
    const options = { env: { ...env, UPGRADE_MIGRATIONS: migrations ? '1' : '0' }, encoding: 'utf8', timeout: 15000, maxBuffer: 128 * 1024 };
    const result = tty
      ? await runChild('script', ['-qec', [process.execPath, ...argv].map(s => "'" + s.replaceAll("'", "'\\''") + "'").join(' '), '/dev/null'], { ...options, input: 'n\n' })
      : await runChild(process.execPath, argv, options);
    t.diagnostic(`args=${JSON.stringify(args)} tty=${tty} exit=${result.status} calls=${JSON.stringify(calls())}`);
    return result;
  }
  return { run, calls, env };
}

for (const target of ['--self', 'sample', '--all']) {
  for (const json of [false, true]) {
    test(`${target} refuses non-interactive upgrade ${json ? 'JSON' : 'text'} before download`, async t => {
      const f = fixture(t);
      const version = () => spawnSync(process.execPath, [path.resolve('cli/zylos.js'), '--version'], { env: f.env, encoding: 'utf8', timeout: 10000 });
      const before = version();
      assert.equal(before.status, 0, before.stderr);
      const result = await f.run([target, ...(json ? ['--json'] : [])]);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.equal(f.calls(), '');
      if (json) {
        const output = JSON.parse(result.stdout);
        assert.equal(output.success, false);
        assert.equal(output.error, 'confirmation_required');
        assert.equal(output.requiresConfirmation, true);
        assert.match(output.message, /--yes/);
      } else assert.match(result.stderr, /--yes/);
      assert.equal(version().stdout, before.stdout);
    });
  }
  test(`${target} keeps interactive cancellation successful`, async t => {
    const f = fixture(t);
    const result = await f.run([target, '--skip-eval'], { tty: true });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /\[y\/N\]/);
    assert.match(result.stdout, /Upgrade cancelled/);
    assert.doesNotMatch(f.calls(), /upgrade/);
  });
}

for (const target of ['--self', 'sample', '--all']) {
  test(`${target} accepts explicit yes and reaches the upgrade boundary`, async t => {
    const f = fixture(t);
    const result = await f.run([target, '--yes', '--skip-eval']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(f.calls(), /download\nupgrade\n/);
  });
}

test('pending database migrations keep the existing JSON confirmation response', async t => {
  const f = fixture(t);
  const result = await f.run(['--self', '--json'], { migrations: true });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.action, 'check');
  assert.equal(output.success, true);
  assert.equal(output.requiresConfirmation, true);
  assert.deepEqual(output.pendingMigrations, [{ source: 'c4', fromVersion: 1, toVersion: 2 }]);
  assert.equal(output.error, undefined);
  assert.match(output.reply, /migration/i);
  assert.equal(f.calls(), '');
});

for (const target of ['--self', 'sample']) {
  test(`${target} accepts short yes with JSON output`, async t => {
    const f = fixture(t);
    const result = await f.run([target, '-y', '--json', '--skip-eval']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(f.calls(), /download\nupgrade\n/);
  });
}

test('all-component JSON checks remain available without confirmation', async t => {
  const f = fixture(t);
  const result = await f.run(['--all', '--check', '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).action, 'check_all');
  assert.equal(f.calls(), '');
});
