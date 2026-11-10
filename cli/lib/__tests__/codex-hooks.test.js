import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  codexGlobalConfigPath,
  codexHooksPath,
  codexProjectConfigPath,
  codexTrustMarkerPath,
  coreSessionStartCommands,
  describeTrustFailure,
  ensureCodexHooksTrusted,
  ensureHooksFeatureInToml,
  extractTrustSnapshot,
  hookKeyFor,
  installCoreCodexHook,
  isCodexTrustValid,
  readHooksState,
  trustCodexHooksWithAppServer,
  uninstallCoreCodexHook,
} from '../codex-hooks.js';

const tmpDirs = [];

function makeEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-codex-hooks-test-'));
  tmpDirs.push(root);
  const homeDir = path.join(root, 'home');
  const zylosDir = path.join(root, 'zylos');
  fs.mkdirSync(path.join(zylosDir, '.claude', 'skills', 'activity-monitor', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(zylosDir, '.claude', 'skills', 'activity-monitor', 'scripts', 'session-start-orchestrator.js'), '// stub');
  return { root, homeDir, zylosDir };
}

afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

describe('Codex SessionStart boundary', () => {
  it('never installs the split assembler as a SessionStart command', () => {
    const { zylosDir } = makeEnv();
    const commands = coreSessionStartCommands(zylosDir);
    assert.ok(commands.length > 0);
    assert.equal(commands.some(command => command.includes('assembler.mjs')), false);
    assert.equal(commands.some(command => command.includes('.zylos/instructions')), false);
  });
});

function writeTrustedState({ homeDir, zylosDir, hash = 'sha256:core' }) {
  const key = hookKeyFor({ zylosDir, event: 'SessionStart', groupIndex: 0, hookIndex: 0 });
  const globalConfigPath = codexGlobalConfigPath(homeDir);
  fs.mkdirSync(path.dirname(globalConfigPath), { recursive: true });
  fs.writeFileSync(globalConfigPath, [
    '[features]',
    'hooks = true',
    '',
    `[hooks.state."${key}"]`,
    'enabled = true',
    `trusted_hash = "${hash}"`,
    '',
  ].join('\n'));
  return key;
}

describe('Codex core hook installer', () => {
  it('upserts the core SessionStart hook and preserves other groups', () => {
    const { zylosDir } = makeEnv();
    const hooksPath = codexHooksPath(zylosDir);
    fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
    fs.writeFileSync(hooksPath, JSON.stringify({
      hooks: {
        SessionStart: [
          { hooks: [{ type: 'command', command: 'node /tmp/dashboard/hook-ingest.cjs', timeout: 5 }] },
        ],
        Stop: [{ matcher: '*', hooks: [
          { type: 'command', command: 'node /tmp/third-party/hook-activity.js', timeout: 7 },
          { type: 'command', command: `node ${path.join(zylosDir, '.claude/skills/activity-monitor/scripts/hook-activity.js')}`, timeout: 2 },
        ] }],
      },
    }, null, 2) + '\n');

    const first = installCoreCodexHook({ zylosDir });
    const second = installCoreCodexHook({ zylosDir });

    assert.equal(first.changed, true);
    assert.equal(second.changed, false);

    const config = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    assert.equal(config.hooks.SessionStart.length, 3);
    assert.deepEqual(Object.keys(config.hooks).sort(), [
      'PermissionRequest', 'PostToolUse', 'PreToolUse', 'SessionStart', 'Stop', 'UserPromptSubmit',
    ]);
    for (const groups of Object.values(config.hooks)) {
      const activity = groups.flatMap(group => group.hooks).filter(h => h.command.includes(`${zylosDir}/.claude/skills/activity-monitor/scripts/hook-activity.js`));
      assert.equal(activity.length, 1);
      assert.equal(activity[0].timeout, 25);
    }
    assert.deepEqual(config.hooks.Stop[0], { matcher: '*', hooks: [
      { type: 'command', command: 'node /tmp/third-party/hook-activity.js', timeout: 7 },
    ] });
    const coreGroup = config.hooks.SessionStart.find(group =>
      group.hooks?.some(h => h.command.includes('session-start-orchestrator.js'))
    );
    assert.ok(coreGroup);
    // Codex injects in config order, so the shard commands must appear as
    // one contiguous group in chain order.
    assert.deepEqual(
      coreGroup.hooks.map(h => h.command.match(/--shard (\S+)$/)?.[1]),
      ['identity', 'custom', 'references', 'c4-conversations', 'fg', 'start-prompt']
    );
    for (const hook of coreGroup.hooks) {
      assert.equal(hook.timeout, 25);
      assert.equal(hook.async, undefined);
    }
    assert.ok(config.hooks.SessionStart.some(group =>
      group.hooks?.some(h => h.command.includes('dashboard/hook-ingest.cjs'))
    ));
  });

  it('migrates old flat-array hooks.json and uninstall removes only core hook', () => {
    const { zylosDir } = makeEnv();
    const hooksPath = codexHooksPath(zylosDir);
    fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
    fs.writeFileSync(hooksPath, JSON.stringify([
      { event: 'SessionStart', command: 'node /tmp/other.js', timeout: 5 },
      { event: 'SessionStart', command: `node ${path.join(zylosDir, '.claude', 'skills', 'activity-monitor', 'scripts', 'session-start-orchestrator.js')}`, timeout: 10 },
    ], null, 2) + '\n');

    const installed = installCoreCodexHook({ zylosDir });
    // Install replaces the retired no-arg command with the shard command set.
    assert.equal(installed.commands.length, 6);
    const migrated = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    const migratedCommands = migrated.hooks.SessionStart.flatMap(group => group.hooks.map(h => h.command));
    assert.equal(migratedCommands.filter(c => c.includes('session-start-orchestrator.js')).length, 6);
    assert.equal(migratedCommands.some(c => c.includes('session-start-orchestrator.js') && !c.includes('--shard')), false);

    const removed = uninstallCoreCodexHook({ zylosDir });

    assert.equal(removed.removed, 12);
    const config = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    assert.equal(config.hooks.SessionStart.length, 1);
    assert.equal(config.hooks.SessionStart[0].hooks[0].command, 'node /tmp/other.js');
  });

  it('uninstall removes only the core hook from a mixed hook group', () => {
    const { zylosDir } = makeEnv();
    const hooksPath = codexHooksPath(zylosDir);
    const coreCommand = `node ${path.join(zylosDir, '.claude', 'skills', 'activity-monitor', 'scripts', 'session-start-orchestrator.js')}`;
    fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
    fs.writeFileSync(hooksPath, JSON.stringify({
      hooks: {
        SessionStart: [{
          matcher: '*',
          hooks: [
            { type: 'command', command: 'node /tmp/other.js', timeout: 5 },
            { type: 'command', command: coreCommand, timeout: 10 },
          ],
        }],
      },
    }, null, 2) + '\n');

    const removed = uninstallCoreCodexHook({ zylosDir });

    assert.equal(removed.removed, 1);
    const config = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    assert.equal(config.hooks.SessionStart.length, 1);
    assert.equal(config.hooks.SessionStart[0].matcher, '*');
    assert.deepEqual(config.hooks.SessionStart[0].hooks, [
      { type: 'command', command: 'node /tmp/other.js', timeout: 5 },
    ]);
  });

  it('sets [features] hooks=true without dropping existing values', () => {
    const content = ensureHooksFeatureInToml([
      'model = "gpt-5.5"',
      '',
      '[features]',
      'multi_agent = true',
      'hooks = false',
      '',
    ].join('\n'));

    assert.match(content, /^model = "gpt-5\.5"$/m);
    assert.match(content, /\[features\][\s\S]*multi_agent = true[\s\S]*hooks = true/);
    assert.doesNotMatch(content, /hooks = false/);
  });
});

describe('Codex hook trust backstop', () => {
  it('re-trusts all hooks, writes marker, then skips app-server in steady state', () => {
    const { homeDir, zylosDir } = makeEnv();
    installCoreCodexHook({ zylosDir });

    let spawnCalls = 0;
    const spawnSyncImpl = () => {
      spawnCalls++;
      writeTrustedState({ homeDir, zylosDir });
      return { status: 0, stdout: JSON.stringify({ ok: true, trusted: 1 }) + '\n', stderr: '' };
    };
    const execFileSyncImpl = () => 'codex-cli 0.142.2\n';

    const first = ensureCodexHooksTrusted({ zylosDir, projectDir: zylosDir, homeDir, execFileSyncImpl, spawnSyncImpl });
    const second = ensureCodexHooksTrusted({ zylosDir, projectDir: zylosDir, homeDir, execFileSyncImpl, spawnSyncImpl });

    assert.equal(first.trusted, true);
    assert.equal(first.reason, 'project_hooks_feature_off');
    assert.equal(second.skipped, true);
    assert.equal(spawnCalls, 1);
    assert.ok(fs.existsSync(codexTrustMarkerPath(zylosDir)));
  });

  it('detects unchanged hooks.json with corrupted trusted_hash value', () => {
    const { homeDir, zylosDir } = makeEnv();
    installCoreCodexHook({ zylosDir });

    let spawnCalls = 0;
    const spawnSyncImpl = () => {
      spawnCalls++;
      writeTrustedState({ homeDir, zylosDir, hash: 'sha256:good' });
      return { status: 0, stdout: JSON.stringify({ ok: true, trusted: 1 }) + '\n', stderr: '' };
    };
    const execFileSyncImpl = () => 'codex-cli 0.142.2\n';

    ensureCodexHooksTrusted({ zylosDir, projectDir: zylosDir, homeDir, execFileSyncImpl, spawnSyncImpl });
    writeTrustedState({ homeDir, zylosDir, hash: 'sha256:bad' });

    const validity = isCodexTrustValid({
      zylosDir,
      projectDir: zylosDir,
      homeDir,
      codexVersion: 'codex-cli 0.142.2',
    });
    assert.equal(validity.valid, false);
    assert.equal(validity.reason, 'trust_snapshot_changed');

    ensureCodexHooksTrusted({ zylosDir, projectDir: zylosDir, homeDir, execFileSyncImpl, spawnSyncImpl });
    assert.equal(spawnCalls, 2);
  });

  it('re-trusts after a hook group index shift changes hooks.state keys', () => {
    const { homeDir, zylosDir } = makeEnv();
    const hooksPath = codexHooksPath(zylosDir);
    fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
    fs.writeFileSync(hooksPath, JSON.stringify({
      hooks: {
        SessionStart: [
          { hooks: [{ type: 'command', command: 'node /tmp/leading.js', timeout: 5 }] },
        ],
      },
    }, null, 2) + '\n');
    installCoreCodexHook({ zylosDir });

    let spawnCalls = 0;
    const spawnSyncImpl = () => {
      spawnCalls++;
      const key = hookKeyFor({ zylosDir, event: 'SessionStart', groupIndex: 1, hookIndex: 0 });
      const globalConfigPath = codexGlobalConfigPath(homeDir);
      fs.mkdirSync(path.dirname(globalConfigPath), { recursive: true });
      fs.writeFileSync(globalConfigPath, [
        '[features]',
        'hooks = true',
        '',
        `[hooks.state."${key}"]`,
        'enabled = true',
        'trusted_hash = "sha256:core"',
        '',
      ].join('\n'));
      return { status: 0, stdout: JSON.stringify({ ok: true, trusted: 1 }) + '\n', stderr: '' };
    };
    const execFileSyncImpl = () => 'codex-cli 0.142.2\n';

    ensureCodexHooksTrusted({ zylosDir, projectDir: zylosDir, homeDir, execFileSyncImpl, spawnSyncImpl });

    const config = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    config.hooks.SessionStart.shift();
    fs.writeFileSync(hooksPath, JSON.stringify(config, null, 2) + '\n');

    const secondSpawnSyncImpl = () => {
      spawnCalls++;
      const key = hookKeyFor({ zylosDir, event: 'SessionStart', groupIndex: 0, hookIndex: 0 });
      const globalConfigPath = codexGlobalConfigPath(homeDir);
      fs.mkdirSync(path.dirname(globalConfigPath), { recursive: true });
      fs.writeFileSync(globalConfigPath, [
        '[features]',
        'hooks = true',
        '',
        `[hooks.state."${key}"]`,
        'enabled = true',
        'trusted_hash = "sha256:core"',
        '',
      ].join('\n'));
      return { status: 0, stdout: JSON.stringify({ ok: true, trusted: 1 }) + '\n', stderr: '' };
    };

    const result = ensureCodexHooksTrusted({
      zylosDir,
      projectDir: zylosDir,
      homeDir,
      execFileSyncImpl,
      spawnSyncImpl: secondSpawnSyncImpl,
    });

    assert.equal(result.trusted, true);
    assert.equal(result.reason, 'hooks_json_changed');
    assert.equal(spawnCalls, 2);
  });

  it('detects hooks feature disabled and restores it before trusting', () => {
    const { homeDir, zylosDir } = makeEnv();
    installCoreCodexHook({ zylosDir });
    let spawnCalls = 0;
    const args = {
      zylosDir,
      projectDir: zylosDir,
      homeDir,
      execFileSyncImpl: () => 'codex-cli 0.142.2\n',
      spawnSyncImpl: () => {
        spawnCalls++;
        writeTrustedState({ homeDir, zylosDir });
        return { status: 0, stdout: JSON.stringify({ ok: true, trusted: 1 }) + '\n', stderr: '' };
      },
    };

    ensureCodexHooksTrusted(args);
    fs.writeFileSync(codexProjectConfigPath(zylosDir), '[features]\nhooks = false\n');
    const result = ensureCodexHooksTrusted(args);

    assert.equal(result.trusted, true);
    assert.equal(result.reason, 'project_hooks_feature_off');
    assert.equal(spawnCalls, 2);
    assert.match(fs.readFileSync(codexProjectConfigPath(zylosDir), 'utf8'), /hooks = true/);
  });

  it('detects Codex version change', () => {
    const { homeDir, zylosDir } = makeEnv();
    installCoreCodexHook({ zylosDir });
    const key = writeTrustedState({ homeDir, zylosDir });
    const hooksContent = fs.readFileSync(codexHooksPath(zylosDir), 'utf8');
    fs.mkdirSync(path.dirname(codexProjectConfigPath(zylosDir)), { recursive: true });
    fs.writeFileSync(codexProjectConfigPath(zylosDir), '[features]\nhooks = true\n');
    fs.writeFileSync(codexTrustMarkerPath(zylosDir), JSON.stringify({
      hooksHash: crypto.createHash('sha256').update(hooksContent).digest('hex'),
      codexVersion: 'codex-cli 0.142.1',
      trustSnapshot: extractTrustSnapshot(readHooksState(codexGlobalConfigPath(homeDir)), codexHooksPath(zylosDir)),
      key,
    }, null, 2));

    const validity = isCodexTrustValid({
      zylosDir,
      projectDir: zylosDir,
      homeDir,
      codexVersion: 'codex-cli 0.142.2',
    });

    assert.equal(validity.valid, false);
    assert.equal(validity.reason, 'codex_version_changed');
  });

  it('fails closed when app-server trust fails', () => {
    const { homeDir, zylosDir } = makeEnv();
    installCoreCodexHook({ zylosDir });

    assert.throws(
      () => ensureCodexHooksTrusted({
        zylosDir,
        projectDir: zylosDir,
        homeDir,
        execFileSyncImpl: () => 'codex-cli 0.142.2\n',
        spawnSyncImpl: () => ({ status: 0, stdout: JSON.stringify({ ok: false, reason: 'hooks_list_error' }) + '\n', stderr: '' }),
      }),
      /Codex hook trust failed \(hooks_list_error\)/
    );
  });

  // A stub app-server that logs to stderr and then refuses one request with an error; everything else succeeds.
  function writeRefusingCodex(root, name, { method, stderr, error }) {
    const codexBin = path.join(root, name);
    fs.writeFileSync(codexBin, [
      '#!/usr/bin/env node',
      `const STDERR = ${JSON.stringify(stderr)};`,
      `const ERROR = ${JSON.stringify(error)};`,
      `const REFUSE = ${JSON.stringify(method)};`,
      "let buf = '';",
      "process.stdin.on('data', chunk => {",
      '  buf += chunk.toString();',
      "  const lines = buf.split('\\n');",
      '  buf = lines.pop();',
      '  for (const line of lines) {',
      '    let msg;',
      '    try { msg = JSON.parse(line); } catch { continue; }',
      '    if (msg.method === REFUSE) {',
      '      // Codex logs the failure before answering, as it does for a refused request.',
      "      process.stderr.write(STDERR, () => setTimeout(() => process.stdout.write(JSON.stringify({ id: msg.id, error: ERROR }) + '\\n'), 50));",
      "    } else if (msg.method === 'initialize') process.stdout.write(JSON.stringify({ id: msg.id, result: {} }) + '\\n');",
      "    else if (msg.method === 'hooks/list') process.stdout.write(JSON.stringify({ id: msg.id, result: { data: [{ hooks: [",
      "      { key: '/tmp/hooks.json:session_start:0:0', currentHash: 'sha256:h', isManaged: false }] }] } }) + '\\n');",
      "    else if (msg.method === 'config/batchWrite') process.stdout.write(JSON.stringify({ id: msg.id, result: { status: 'ok' } }) + '\\n');",
      '  }',
      '});',
      '',
    ].join('\n'), { mode: 0o755 });
    return codexBin;
  }
  const trustFailure = args => {
    let message;
    assert.throws(() => ensureCodexHooksTrusted({ ...args, execFileSyncImpl: () => 'codex-cli 0.146.0\n' }),
      thrown => { message = thrown.message; return true; });
    return message;
  };

  it('reports Codex\'s error code, message and the end of app-server stderr when the config write is refused', () => {
    const { root, homeDir, zylosDir } = makeEnv();
    installCoreCodexHook({ zylosDir });
    // Older diagnostic lines first, so only a capped tail of stderr can reach the report.
    const stderr = `STDERR-HEAD ${'early diagnostic '.repeat(60)}\n` +
      'ERROR codex_core::config: write config.toml failed: Operation not permitted (os error 1)\n' +
      'request header Authorization: Bearer abc.def-SECRETBEARER\n' +
      'retrying with api_key=sk-proj-SECRETKEYabcdef1234 and token: SECRETTOKEN\n';
    const error = {
      code: -32603,
      message: 'failed to persist config: Operation not permitted (os error 1) refresh_token="SECRETREFRESH"',
      data: { config: 'model_provider_secret = "SECRETDATA"' },
    };
    const codexBin = writeRefusingCodex(root, 'fake-codex-refuses-write.js', { method: 'config/batchWrite', stderr, error });
    const message = trustFailure({ zylosDir, projectDir: zylosDir, homeDir, codexBin });

    assert.ok(message.startsWith('Codex hook trust failed (config_batch_write_error): Codex error -32603: ' +
      'failed to persist config: Operation not permitted (os error 1) refresh_token=[redacted]; '), message);
    const label = 'stderr (last 600 characters): ';
    assert.ok(message.includes(label), message);
    const tail = message.slice(message.indexOf(label) + label.length);
    assert.equal(tail.length, 600);
    assert.ok(tail.includes('ERROR codex_core::config: write config.toml failed: Operation not permitted (os error 1) | ' +
      'request header Authorization: [redacted] | '), tail);
    assert.ok(tail.endsWith('retrying with api_key=[redacted] and token: [redacted]'), tail);
    for (const leaked of ['STDERR-HEAD', 'SECRETBEARER', 'SECRETKEY', 'SECRETTOKEN', 'SECRETREFRESH', 'SECRETDATA']) {
      assert.equal(message.includes(leaked), false, `report must not contain ${leaked}`);
    }
    assert.equal(message.includes('\n'), false, 'the report stays on one log line');
    assert.doesNotMatch(message, /SessionStart bootstrap may not run/);
  });

  it('keeps the reason, Codex\'s error and the stderr tail when Codex writes more than 1 MiB of stderr', () => {
    const { root, homeDir, zylosDir } = makeEnv();
    installCoreCodexHook({ zylosDir });
    // As with RUST_LOG=debug: far more stderr than spawnSync's default 1 MiB output buffer.
    const stderr = `${'debug codex_core::trace noise line\n'.repeat(36_000)}ERROR write failed: Operation not permitted END-OF-STDERR\n`;
    assert.ok(stderr.length > 1024 * 1024);
    const codexBin = writeRefusingCodex(root, 'fake-codex-loud.js', { method: 'config/batchWrite', stderr,
      error: { code: -32603, message: 'failed to persist config' } });
    const message = trustFailure({ zylosDir, projectDir: zylosDir, homeDir, codexBin });
    assert.ok(message.startsWith('Codex hook trust failed (config_batch_write_error): Codex error -32603: failed to persist config; ' +
      'stderr (last 600 characters): '), message.slice(0, 200));
    assert.ok(message.endsWith('debug codex_core::trace noise line | ERROR write failed: Operation not permitted END-OF-STDERR'), message.slice(-200));
  });

  it('reports the stderr tail when Codex refuses to list hooks', () => {
    const { root, homeDir, zylosDir } = makeEnv();
    installCoreCodexHook({ zylosDir });
    const codexBin = writeRefusingCodex(root, 'fake-codex-refuses-list.js', { method: 'hooks/list',
      stderr: 'WARN hooks: cannot read hooks.json: Permission denied (os error 13)\n', error: { code: -32600, message: 'hooks unavailable' } });
    assert.equal(trustFailure({ zylosDir, projectDir: zylosDir, homeDir, codexBin }),
      'Codex hook trust failed (hooks_list_error): Codex error -32600: hooks unavailable; ' +
      'stderr: WARN hooks: cannot read hooks.json: Permission denied (os error 13)');
  });

  it('caps Codex\'s error message and code, adds exit codes and labels stderr only when it was cut', () => {
    const { homeDir, zylosDir } = makeEnv();
    installCoreCodexHook({ zylosDir });
    const refuse = (error, stderr) => trustFailure({ zylosDir, projectDir: zylosDir, homeDir,
      spawnSyncImpl: () => ({ status: 0, stdout: JSON.stringify({ ok: false, reason: 'config_batch_write_error', error, stderr }) + '\n', stderr: '' }) });
    assert.equal(refuse({ code: 'EPERM', message: `${'m'.repeat(300)}CUT-OFF` }, 'short stderr line\n'),
      `Codex hook trust failed (config_batch_write_error): Codex error EPERM: ${'m'.repeat(300)}; stderr: short stderr line`);
    assert.equal(refuse({ message: '' }, ''), 'Codex hook trust failed (config_batch_write_error): Codex error: (no message)');
    assert.equal(refuse({ code: `${'C'.repeat(40)}LONGCODE`, message: 'x' }, ''),
      `Codex hook trust failed (config_batch_write_error): Codex error ${'C'.repeat(40)}: x`);
    assert.equal(describeTrustFailure({ reason: 'codex_app_server_exit', code: 3, stderr: 'panicked at config.rs' }),
      'exit code 3; stderr: panicked at config.rs');
    assert.equal(describeTrustFailure({ reason: 'trust_helper_exit', status: 9 }), 'exit code 9');
    assert.equal(describeTrustFailure({ reason: 'codex_app_server_exit', code: null }), '');
  });

  it('removes terminal control sequences so the report cannot overwrite a log line', () => {
    assert.equal(describeTrustFailure({ stderr: 'progress 10%\rprogress 99%\r\n\x1b[31mERROR\x1b[0m write failed\x07\x1b]0;title\x07 done' }),
      'stderr: progress 10% | progress 99% | ERROR write failed  done');
  });

  // Each input below can be caught by one redaction rule only, so dropping or weakening that rule leaks it.
  const redactionCases = [
    ['Cookie header, several values', 'request Cookie: a=1; session=SECRETCOOKIE\nnext line', ['SECRETCOOKIE'], ['request Cookie: [redacted] | next line']],
    ['Authorization header with a plain-looking value', 'sent Authorization: Basic zzsecretzz to proxy', ['zzsecretzz', 'Basic'], ['sent Authorization: [redacted] to proxy']],
    ['bare Bearer value', 'retrying with Bearer abc.DEF-SECRETBEARER2 now', ['SECRETBEARER2'], ['retrying with Bearer [redacted] now']],
    ['bare Basic value that looks like base64', 'got Basic dXNlcjpTRUNSRVQ= back', ['dXNlcjpTRUNSRVQ='], ['got Basic [redacted] back']],
    ['bare Basic value of letters only, in mixed case', 'got Basic dXNlcjpwYXNz back', ['dXNlcjpwYXNz'], ['got Basic [redacted] back']],
    ['ordinary words after basic', 'Basic validation failed; basic check skipped', [], ['Basic validation failed; basic check skipped']],
    ['bare JWT', 'cached eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJTRUNSRVRKV1QifQ.c2lnbmF0dXJl ok', ['eyJzdWIiOiJTRUNSRVRKV1QifQ'], ['cached [redacted] ok']],
    ['bare OpenAI-style key', 'using sk-proj-SECRETSK123456 for requests', ['SECRETSK123456'], ['using [redacted] for requests']],
    ['bare GitHub token', 'remote ghp_SECRETGH1234567890abcd rejected', ['SECRETGH'], ['remote [redacted] rejected']],
    ['URL userinfo', 'proxy http://user:SECRETURL@proxy:8080 refused', ['SECRETURL', 'user:'], ['proxy http://[redacted]@proxy:8080 refused']],
    ['URL password holding an unencoded @', 'proxy http://user:pa@SECRETAT@proxy:8080/x refused', ['SECRETAT', 'pa@'], ['proxy http://[redacted]@proxy:8080/x refused']],
    ['command-line flag', 'spawn tool --api-key SECRETFLAG --verbose', ['SECRETFLAG'], ['spawn tool --api-key [redacted] --verbose']],
    ['secret flag after a plain flag', 'spawn tool --verbose --api-key SECRETNEXT done', ['SECRETNEXT'], ['spawn tool --verbose --api-key [redacted] done']],
    ['upper-case environment names', 'env OPENAI_API_KEY=SECRETENV GITHUB_TOKEN=SECRETUP set', ['SECRETENV', 'SECRETUP'], ['env OPENAI_API_KEY=[redacted] GITHUB_TOKEN=[redacted] set']],
    ['quoted value with spaces', 'parsed password: "has SECRETSPACE inside" from file', ['SECRETSPACE'], ['parsed password: [redacted] from file']],
    ['quoted value with an escaped quote', '{"password": "ab\\"SECRETESC", "user": "felix"}', ['SECRETESC'], ['{"password": [redacted], "user": "felix"}']],
    ['Rust debug-escaped JSON', 'config: "{\\"api_key\\":\\"SECRETRUST\\",\\"model\\":\\"gpt\\"}"', ['SECRETRUST'], ['config: "{\\"api_key\\":[redacted],\\"model\\":\\"gpt\\"}"']],
    ['Rust debug-escaped JSON with an escaped quote in the value', 'body: "{\\"password\\": \\"ab\\\\\\"SECRETDEEP\\"}" next', ['SECRETDEEP'],
      ['body: "{\\"password\\": [redacted]}" next']],
    ['secret pair in the bare value of a plain name', 'flags opts=token=SECRETCHAIN mode=fast', ['SECRETCHAIN'], ['flags opts=token=[redacted] mode=fast']],
    ['names that end in _key or contain secret', 'aws_secret_access_key=SECRETAWS SECRET_KEY=SECRETSK2 private_key: SECRETPK passphrase=SECRETPP region=us-east-1',
      ['SECRETAWS', 'SECRETSK2', 'SECRETPK', 'SECRETPP'], ['aws_secret_access_key=[redacted] SECRET_KEY=[redacted] private_key: [redacted] passphrase=[redacted] region=us-east-1']],
  ];
  for (const [name, input, secrets, kept] of redactionCases) {
    it(`redacts ${name} in Codex's error message and stderr`, () => {
      for (const report of [describeTrustFailure({ stderr: input }), describeTrustFailure({ error: { code: 1, message: input } })]) {
        for (const secret of secrets) assert.equal(report.includes(secret), false, `${report} must not contain ${secret}`);
        for (const text of kept) assert.ok(report.includes(text), `${report} keeps ${text}`);
      }
    });
  }

  it('redacts a secret in a non-numeric Codex error code', () => {
    const report = describeTrustFailure({ error: { code: 'auth sk-proj-SECRETCODE99 rejected', message: 'refused' } });
    assert.equal(report, 'Codex error auth [redacted] rejected: refused');
  });

  it('does not call an error of the trust helper or of spawning Codex a Codex error', () => {
    const { homeDir, zylosDir } = makeEnv();
    installCoreCodexHook({ zylosDir });
    const timedOut = Object.assign(new Error('spawnSync /usr/bin/node ETIMEDOUT'), { code: 'ETIMEDOUT' });
    assert.equal(trustFailure({ zylosDir, projectDir: zylosDir, homeDir, spawnSyncImpl: () => ({ error: timedOut, status: null, stdout: '', stderr: '' }) }),
      'Codex hook trust failed (trust_helper_error): error: Error: spawnSync /usr/bin/node ETIMEDOUT');
    assert.equal(describeTrustFailure({ reason: 'codex_app_server_error', error: 'Error: spawn /missing/codex ENOENT', stderr: '' }),
      'error: Error: spawn /missing/codex ENOENT');
  });

  // Only the start of a message and the end of stderr are redacted; a cut replaces the token it went through.
  it('redacts a bounded part of huge input and marks a token the cut went through', () => {
    assert.equal(describeTrustFailure({ stderr: `${'k'.repeat(9000)} end` }), 'stderr: [cut] end');
    assert.equal(describeTrustFailure({ error: { code: 1, message: `start ${'k'.repeat(5000)}` } }), 'Codex error 1: start [cut]');
    // Inputs that make backtracking patterns slow: runs of 8000 characters, longer than the part that is
    // redacted, repeated with spaces between them to about 1 MiB.
    const runs = (unit) => `${unit.repeat(Math.ceil(8000 / unit.length)).slice(0, 8000)} `.repeat(132);
    const units = ['a', '-', 'x.', 'token', 'api_key_token-', 'secret_key=', 'a@', 'sk-', '\\"', `http://${'a@'.repeat(4000)}`,
      'a=', '"a":', '\\"a\\":', 'token="', "token='", 'token=\\"', `${'k'.repeat(4000)} `];
    // The best of five times, so a pause of the machine does not count. Each input is compared with plain words of
    // the same length: linear redaction takes about as long on both, and a pattern that backtracks over a run takes
    // tens of times longer. The margin keeps a slow or busy machine from failing the test.
    const bestTime = (text) => {
      let best = Infinity;
      for (let i = 0; i < 5; i += 1) {
        const started = performance.now();
        describeTrustFailure({ stderr: text });
        describeTrustFailure({ error: { code: 1, message: text } });
        best = Math.min(best, performance.now() - started);
      }
      return best;
    };
    const plain = bestTime(runs('plain words '));
    for (const unit of units) {
      const time = bestTime(runs(unit));
      assert.ok(time < 10 * plain + 20, `redacting runs of ${JSON.stringify(unit.slice(0, 12))} took ${time.toFixed(1)} ms, plain words ${plain.toFixed(1)} ms`);
    }
  });

  it('redacts a JWT that straddles the message limit before cutting the message', () => {
    const header = 'eyJhbGciOiJIUzI1NiJ9', payload = 'eyJzdWIiOiJTRUNSRVRKV1QiLCJuYW1lIjoiZmVsaXgifQ';
    // The 300-character cut falls inside the payload.
    const message = `${'x'.repeat(250)} ${header}.${payload}.c2lnbmF0dXJlc2lnbmF0dXJl tail`;
    const report = describeTrustFailure({ error: { code: 1, message } });
    assert.equal(report, `Codex error 1: ${'x'.repeat(250)} [redacted] tail`);
    assert.equal(report.includes(header.slice(0, 12)) || report.includes(payload.slice(0, 12)), false);
  });

  it('fails closed when app-server succeeds but no matching trust snapshot is written', () => {
    const { homeDir, zylosDir } = makeEnv();
    installCoreCodexHook({ zylosDir });
    const globalConfigPath = codexGlobalConfigPath(homeDir);

    assert.throws(
      () => ensureCodexHooksTrusted({
        zylosDir,
        projectDir: zylosDir,
        homeDir,
        execFileSyncImpl: () => 'codex-cli 0.142.2\n',
        spawnSyncImpl: () => {
          fs.mkdirSync(path.dirname(globalConfigPath), { recursive: true });
          fs.writeFileSync(globalConfigPath, [
            '[features]',
            'hooks = true',
            '',
            '[hooks.state."/tmp/other-hooks.json:session_start:0:0"]',
            'enabled = true',
            'trusted_hash = "sha256:other"',
            '',
          ].join('\n'));
          return { status: 0, stdout: JSON.stringify({ ok: true, trusted: 1 }) + '\n', stderr: '' };
        },
      }),
      /Codex hook trust failed \(empty_trust_snapshot\)/
    );
  });

  it('reports actionable version guidance when hooks/list omits currentHash (issue #752)', () => {
    const { homeDir, zylosDir } = makeEnv();
    installCoreCodexHook({ zylosDir });

    assert.throws(
      () => ensureCodexHooksTrusted({
        zylosDir,
        projectDir: zylosDir,
        homeDir,
        execFileSyncImpl: () => 'codex-cli 0.128.0\n',
        spawnSyncImpl: () => ({
          status: 0,
          stdout: JSON.stringify({ ok: true, trusted: 0, candidates: 14, missingHash: 14 }) + '\n',
          stderr: '',
        }),
      }),
      (error) => {
        assert.match(error.message, /missing_current_hash/);
        assert.match(error.message, /0\.128\.0/);
        assert.match(error.message, /0\.129\.0/);
        return true;
      }
    );
  });

  it('keeps empty_trust_snapshot for zero-candidate results without missing hashes', () => {
    const { homeDir, zylosDir } = makeEnv();
    installCoreCodexHook({ zylosDir });

    assert.throws(
      () => ensureCodexHooksTrusted({
        zylosDir,
        projectDir: zylosDir,
        homeDir,
        execFileSyncImpl: () => 'codex-cli 0.142.2\n',
        spawnSyncImpl: () => ({
          status: 0,
          stdout: JSON.stringify({ ok: true, trusted: 0, candidates: 0, missingHash: 0 }) + '\n',
          stderr: '',
        }),
      }),
      /Codex hook trust failed \(empty_trust_snapshot\)/
    );
  });

  it('counts candidates and missing currentHash through the real trust helper against a stub app-server', () => {
    const { root, zylosDir } = makeEnv();

    const makeHook = (i, withHash) => ({
      key: `/tmp/hooks.json:session_start:0:${i}`,
      eventName: 'SessionStart',
      command: ['node', `/tmp/hook-${i}.js`],
      enabled: true,
      isManaged: false,
      ...(withHash ? { currentHash: `sha256:hash-${i}` } : {}),
    });

    // Non-candidates: managed and keyless hooks must be excluded from every count.
    const makeNonCandidates = (withHash) => [
      { ...makeHook(90, withHash), isManaged: true },
      (({ key, ...rest }) => rest)(makeHook(91, withHash)),
    ];

    const writeFakeCodexBin = (name, hooks) => {
      const stubPath = path.join(root, name);
      fs.writeFileSync(stubPath, [
        '#!/usr/bin/env node',
        `const HOOKS = ${JSON.stringify(hooks)};`,
        "let buf = '';",
        'process.stdin.on(\'data\', chunk => {',
        '  buf += chunk.toString();',
        "  const lines = buf.split('\\n');",
        '  buf = lines.pop();',
        '  for (const line of lines) {',
        '    if (!line.trim()) continue;',
        '    let msg;',
        '    try { msg = JSON.parse(line); } catch { continue; }',
        '    if (msg.id === undefined) continue;',
        "    if (msg.method === 'initialize') {",
        "      process.stdout.write(JSON.stringify({ id: msg.id, result: {} }) + '\\n');",
        "    } else if (msg.method === 'hooks/list') {",
        "      process.stdout.write(JSON.stringify({ id: msg.id, result: { data: [{ hooks: HOOKS }] } }) + '\\n');",
        "    } else if (msg.method === 'config/batchWrite') {",
        "      process.stdout.write(JSON.stringify({ id: msg.id, result: { status: 'ok' } }) + '\\n');",
        '    }',
        '  }',
        '});',
        '',
      ].join('\n'), { mode: 0o755 });
      return stubPath;
    };

    const hashlessBin = writeFakeCodexBin('fake-codex-no-hash.js', [
      ...[0, 1, 2].map(i => makeHook(i, false)),
      ...makeNonCandidates(false),
    ]);
    const hashedBin = writeFakeCodexBin('fake-codex-with-hash.js', [
      ...[0, 1, 2].map(i => makeHook(i, true)),
      ...makeNonCandidates(true),
    ]);

    const missing = trustCodexHooksWithAppServer({ zylosDir, codexBin: hashlessBin });
    assert.equal(missing.ok, true);
    assert.equal(missing.trusted, 0);
    assert.equal(missing.candidates, 3);
    assert.equal(missing.missingHash, 3);

    const present = trustCodexHooksWithAppServer({ zylosDir, codexBin: hashedBin });
    assert.equal(present.ok, true);
    assert.equal(present.trusted, 3);
    assert.equal(present.candidates, 3);
    assert.equal(present.missingHash, 0);
  });
});
