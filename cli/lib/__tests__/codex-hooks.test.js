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
      },
    }, null, 2) + '\n');

    const first = installCoreCodexHook({ zylosDir });
    const second = installCoreCodexHook({ zylosDir });

    assert.equal(first.changed, true);
    assert.equal(second.changed, false);

    const config = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    assert.equal(config.hooks.SessionStart.length, 2);
    const coreGroup = config.hooks.SessionStart.find(group =>
      group.hooks?.some(h => h.command.includes('session-start-orchestrator.js'))
    );
    assert.ok(coreGroup);
    // Codex injects in config order, so the shard commands must appear as
    // one contiguous group in chain order.
    assert.deepEqual(
      coreGroup.hooks.map(h => h.command.match(/--shard (\S+)$/)?.[1]),
      ['identity', 'custom', 'references', 'state', 'c4-checkpoint', 'c4-conversations', 'fg', 'start-prompt']
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
    assert.equal(installed.commands.length, 8);
    const migrated = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    const migratedCommands = migrated.hooks.SessionStart.flatMap(group => group.hooks.map(h => h.command));
    assert.equal(migratedCommands.filter(c => c.includes('session-start-orchestrator.js')).length, 8);
    assert.equal(migratedCommands.some(c => c.includes('session-start-orchestrator.js') && !c.includes('--shard')), false);

    const removed = uninstallCoreCodexHook({ zylosDir });

    assert.equal(removed.removed, 8);
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
