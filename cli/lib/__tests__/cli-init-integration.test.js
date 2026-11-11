import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import net from 'node:net';
import { test } from 'node:test';

const initUrl = new URL('../../commands/init.js', import.meta.url).href;
const exec = promisify(execFile);
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'p6-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, 'z');
  fs.mkdirSync(path.join(root, 'memory'), { recursive: true });
  fs.mkdirSync(path.join(home, 'empty-bin'));
  return { home, root };
}
function run({ home, root }, source, env = {}) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    encoding: 'utf8', timeout: 15000,
    env: { ...process.env, HOME: home, ZYLOS_DIR: root,
      CODEX_BIN: path.join(home, 'unavailable-codex'), PATH: path.join(home, 'empty-bin'), ...env },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim().split('\n').at(-1));
}

test('default init imports real migration ensure and preserves unreadable records', t => {
  for (const state of ['fresh', 'existing', 'unreadable']) {
    const context = fixture(t);
    fs.writeFileSync(path.join(context.root, 'memory', 'references.md'), '# References\n');
    const recordPath = path.join(context.root, '.zylos', 'migrations', 'references-layout-v1.json');
    if (state === 'unreadable') {
      fs.mkdirSync(path.dirname(recordPath), { recursive: true });
      fs.writeFileSync(recordPath, '{broken record');
    }
    const result = run(context, `
      import { ensureInitMemoryMigration } from ${JSON.stringify(initUrl)};
      const warnings = [];
      const options = { freshInstall: ${state === 'fresh'}, warn: text => warnings.push(text) };
      const first = await ensureInitMemoryMigration(options);
      const second = await ensureInitMemoryMigration(options);
      console.log(JSON.stringify({ first, second, warnings }));
    `);
    assert.deepEqual(result.first, result.second);
    assert.equal(result.first.state, state === 'fresh' ? 'done' : state === 'existing' ? 'pending' : 'unreadable');
    const bytes = fs.readFileSync(recordPath, 'utf8');
    if (state === 'unreadable') {
      assert.equal(bytes, '{broken record');
      assert.equal(result.warnings.length, 2);
      assert.match(result.warnings[0], /RECORD_UNREADABLE/);
    } else {
      const record = JSON.parse(bytes);
      assert.equal(record.createdBy, 'init');
      assert.equal(record.evidence?.kind ?? null, state === 'fresh' ? 'fresh_install' : null);
      assert.equal(record.attempts, 0);
      assert.deepEqual(result.warnings, []);
    }
  }
});

// Real init asset/hook generation with private HOME/ZYLOS_DIR and an empty PATH;
// Codex is unavailable, with no real runtime, PM2, tmux or database reached.
// Run for init assets or model-threshold migration changes; unrelated work may
// skip. The official runner isolates PM2_HOME/short TMPDIR; fixtures are removed.
test('init template generator migrates legacy thresholds, prepares dual hooks and reports unavailable native trust', t => {
  const context = fixture(t);
  const instruction = path.join(context.root, 'instructions.md');
  fs.writeFileSync(instruction, '# Fixture instructions\n');
  fs.writeFileSync(path.join(context.root, 'CLAUDE.md'), '# Fixture instructions\n');
  const configPath = path.join(context.root, '.zylos', 'config.json');
  const config = JSON.stringify({ runtime: 'claude', session_mode: 'multi', new_session_threshold: 30, keep: true });
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, config);
  const result = run(context, `
    import { prepareInitRuntimeAssets, syncSettingsHooksAfterTemplateDeploy } from ${JSON.stringify(initUrl)};
    syncSettingsHooksAfterTemplateDeploy();
    const result = await prepareInitRuntimeAssets({ instruction: () => ${JSON.stringify(instruction)} });
    console.log(JSON.stringify(result));
  `);
  assert.deepEqual(result.completed, ['claude.instructions', 'claude.hooks', 'codex.instructions']);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].item, 'codex.hooks');
  assert.match(result.failed[0].message, /unavailable-codex ENOENT/);
  const claude = JSON.parse(fs.readFileSync(path.join(context.root, '.claude', 'settings.json'), 'utf8'));
  const codex = JSON.parse(fs.readFileSync(path.join(context.root, '.codex', 'hooks.json'), 'utf8'));
  for (const hooks of [claude.hooks, codex.hooks]) {
    const commands = hooks.SessionStart.flatMap(group => group.hooks.map(hook => hook.command));
    assert.ok(commands.some(command => command.includes('session-start-orchestrator.js')));
  }
  for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Stop']) {
    assert.ok(codex.hooks[event].flatMap(group => group.hooks)
      .some(hook => hook.command.endsWith('/hook-activity.js')), `missing nondefault Codex ${event} activity hook`);
  }
  assert.equal(fs.existsSync(path.join(context.root, '.codex', 'hooks.trust.json')), false);
  // Hook sync pins the legacy value to the saved native model. Atomic config
  // writes preserve fields, not the input JSON's whitespace.
  assert.equal(typeof claude.model, 'string');
  assert.ok(claude.model.length > 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), {
    ...JSON.parse(config),
    model_rotation_thresholds: { claude: { [claude.model]: 30 } },
  });
});

// Integration boundary: the real default init Codex hook step, in a child process with HOME and ZYLOS_DIR in a
// temp dir and an empty PATH; Codex is either missing or a stub app-server written into that temp dir, so no
// real Codex, PM2, tmux, socket or database is reached. Run when init's Codex hook step, the trust report or
// the init wording changes; skip for changes elsewhere. Only run it isolated: separate HOME, ZYLOS_DIR,
// PM2_HOME and short TMPDIR, private tmux socket and test database, never live resources. The temp dir is
// removed when the case ends.
test('init reports a Codex hook trust failure as blocking later launches, not as a stopped start', t => {
  const prepare = (context, env) => run(context, `
    import { prepareInitRuntimeAssets } from ${JSON.stringify(initUrl)};
    console.log(JSON.stringify(await prepareInitRuntimeAssets({ instruction: () => ${JSON.stringify(context.root)} })));
  `, env).failed.filter(failure => failure.item === 'codex.hooks');
  const suffix = '. Codex will not start until hook trust succeeds; each Codex launch tries it again.';

  const missing = fixture(t);
  const failed = prepare(missing);
  assert.equal(failed.length, 1);
  assert.match(failed[0].message, /^spawnSync \S*unavailable-codex ENOENT\. Codex will not start until hook trust succeeds; each Codex launch tries it again\.$/);
  assert.doesNotMatch(failed[0].message, /did not start/);

  // A Codex too old to report currentHash: the trust report already ends a sentence, and is joined without "..".
  const old = fixture(t);
  const codex = path.join(old.home, 'hashless-codex');
  fs.writeFileSync(codex, `#!${process.execPath}
if (process.argv[2] === '--version') { console.log('codex-cli 0.128.0'); process.exit(0); }
let buf = '';
process.stdin.on('data', chunk => {
  buf += chunk; const lines = buf.split('\\n'); buf = lines.pop();
  for (const line of lines) {
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') console.log(JSON.stringify({ id: msg.id, result: {} }));
    if (msg.method === 'hooks/list') console.log(JSON.stringify({ id: msg.id, result: { data: [{ hooks: [{ key: 'k:session_start:0:0', isManaged: false }] }] } }));
    if (msg.method === 'config/batchWrite') console.log(JSON.stringify({ id: msg.id, result: { status: 'ok' } }));
  }
});
`, { mode: 0o755 });
  const hashless = prepare(old, { CODEX_BIN: codex });
  assert.equal(hashless.length, 1);
  assert.equal(hashless[0].message, 'Codex hook trust failed (missing_current_hash): Codex CLI "codex-cli 0.128.0" does not report ' +
    'currentHash in hooks/list (field added in Codex CLI 0.129.0). Upgrade Codex CLI to 0.129.0 or later (0.146+ recommended)' + suffix);
});

test('init template sync never restarts or invokes the wrapper CLI', async t => {
  const { home, root } = fixture(t);
  const wrapperLog = path.join(home, 'wrapper.jsonl'), restartLog = path.join(home, 'restart.jsonl');
  const recorder = file => `#!${process.execPath}\nimport fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(file)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`;
  const preload = path.join(home, 'record-wrapper.mjs'), probe = path.join(home, 'sync-settings-hooks.js');
  fs.writeFileSync(preload, `import fs from 'node:fs'; if (process.argv[1]?.endsWith('/sync-settings-hooks.js')) fs.appendFileSync(${JSON.stringify(wrapperLog)}, 'wrapper-child\\n');`);
  fs.writeFileSync(probe, '');
  const bin = path.join(home, 'empty-bin'), node = path.join(bin, 'node');
  fs.writeFileSync(path.join(home, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(node, recorder(wrapperLog), { mode: 0o755 });
  const control = path.join(root, '.claude', 'skills', 'comm-bridge', 'scripts', 'c4-control.js');
  fs.mkdirSync(path.dirname(control), { recursive: true });
  fs.writeFileSync(control, recorder(restartLog));
  const socketPath = path.join(root, 'activity-monitor', 'am.sock');
  fs.mkdirSync(path.dirname(socketPath), { recursive: true });
  assert.ok(Buffer.byteLength(socketPath) < 104, 'fixture socket must fit macOS sun_path including its terminator');
  const requests = [];
  const server = net.createServer(socket => {
    let input = '';
    socket.on('data', chunk => {
      input += chunk;
      if (!input.includes('\n')) return;
      const request = JSON.parse(input.slice(0, input.indexOf('\n')));
      requests.push(request);
      socket.end(JSON.stringify({ ...request, ok: true, result: 'done_empty', runCount: 0 }) + '\n');
    });
  });
  await new Promise((resolve, reject) => server.once('error', reject).listen(socketPath, resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const env = { ...process.env, HOME: home, ZYLOS_DIR: root, PATH: bin,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --import=${preload}` };
  await exec(node, ['recorder-positive'], { env });
  await exec(process.execPath, [probe], { env });
  await exec(process.execPath, [control, 'recorder-positive'], { env });
  await new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath, () => socket.write('{"requestId":"recorder-positive"}\n'));
    socket.on('data', () => {}); socket.once('end', resolve); socket.once('error', reject);
  });
  assert.equal(requests.length, 1);
  for (const mode of ['single', 'multi']) {
    const config = path.join(root, '.zylos', 'config.json');
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, JSON.stringify({ runtime: 'claude', session_mode: mode }));
    await exec(process.execPath, ['--input-type=module', '-e', `
      import { syncSettingsHooksAfterTemplateDeploy } from ${JSON.stringify(initUrl)};
      await syncSettingsHooksAfterTemplateDeploy();
    `], { env, timeout: 15000 });
    assert.ok(fs.existsSync(path.join(root, '.claude', 'settings.json')));
    assert.ok(fs.existsSync(path.join(root, '.codex', 'hooks.json')));
    assert.equal(fs.readFileSync(wrapperLog, 'utf8'), '["recorder-positive"]\nwrapper-child\n', mode);
    assert.equal(fs.readFileSync(restartLog, 'utf8'), '["recorder-positive"]\n', mode);
    assert.equal(requests.length, 1, mode);
  }
});
