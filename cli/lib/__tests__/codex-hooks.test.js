import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  codexGlobalConfigPath,
  codexHooksPath,
  codexTrustMarkerPath,
  coreSessionStartCommands,
  describeTrustFailure,
  ensureCodexHooksTrusted,
  hookKeyFor,
  installCoreCodexHook,
  uninstallCoreCodexHook,
} from '../runtime/codex/hooks.js';

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
      ['identity', 'custom', 'references', 'c4-conversations', 'onboarding', 'fg', 'start-prompt']
    );
    for (const hook of coreGroup.hooks) {
      assert.equal(hook.timeout, 25);
      assert.equal(hook.async, undefined);
    }
    assert.ok(config.hooks.SessionStart.some(group =>
      group.hooks?.some(h => h.command.includes('dashboard/hook-ingest.cjs'))
    ));
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
    ['flag value that starts with a dash', 'run --token -SECRETdash1 now --password -Xy9SECRET', ['SECRETdash1', 'Xy9SECRET'], ['run --token [redacted] now --password [redacted]']],
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



});
