import assert from 'node:assert/strict';
import { after, before, describe, it, mock } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'smol-toml';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-runtime-setup-test-'));
const fakeHome = path.join(tmpRoot, 'home');
const fakeZylosDir = path.join(tmpRoot, 'zylos');

const originalHome = process.env.HOME;
const originalZylosDir = process.env.ZYLOS_DIR;

process.env.HOME = fakeHome;
process.env.ZYLOS_DIR = fakeZylosDir;

fs.mkdirSync(fakeHome, { recursive: true });
fs.mkdirSync(fakeZylosDir, { recursive: true });

const { writeCodexConfig, renderCodexProjectConfig, renderCodexGlobalConfig, writeCodexProjectConfig, resolveCodexBypassPermissions } = await import('../runtime-setup.js');
const { parseClaudeAuthStatus, parseCodexLoginStatus, classifyCodexLoginStatus } = await import('../auth-parsers.js');

before(() => {
  fs.mkdirSync(path.join(fakeHome, '.codex'), { recursive: true });
});

after(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;

  if (originalZylosDir === undefined) delete process.env.ZYLOS_DIR;
  else process.env.ZYLOS_DIR = originalZylosDir;

  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('renderCodexProjectConfig', () => {
  it('includes headless settings, features, and notice suppression', () => {
    const content = renderCodexProjectConfig();
    assert.match(content, /check_for_update_on_startup = false/);
    assert.match(content, /model_availability_nux = "gpt-5\.4"/);
    assert.match(content, /^model = "gpt-5\.5"$/m);
    assert.match(content, /^model_reasoning_effort = "medium"$/m);
    assert.match(content, /\[features\][\s\S]*multi_agent = true[\s\S]*fast_mode = false[\s\S]*hooks = true/);
    assert.match(content, /\[notice\]/);
    assert.match(content, /hide_full_access_warning = true/);
    assert.match(content, /hide_rate_limit_model_nudge = true/);
    assert.match(content, /\[notice\.model_migrations\]/);
  });

  it('does not include trust declarations or base URL', () => {
    const content = renderCodexProjectConfig();
    assert.doesNotMatch(content, /\[projects\./);
    assert.doesNotMatch(content, /trust_level/);
    assert.doesNotMatch(content, /openai_base_url/);
  });

  it('preserves unknown top-level keys, sections, and feature flags while updating zylos keys', () => {
    const existing = [
      '# User comment',
      'user_added = "keep"',
      'check_for_update_on_startup = true',
      '',
      '[features]',
      'fast_mode = true',
      'multi_agent = false',
      'custom_feature = true',
      '',
      '[profile.fast]',
      'model = "gpt-5.4-mini"',
      '',
    ].join('\n');

    const content = renderCodexProjectConfig(existing);
    assert.match(content, /user_added = "keep"/);
    assert.match(content, /^# Zylos project-level Codex config\./);
    assert.doesNotMatch(content, /# User comment/);
    assert.match(content, /check_for_update_on_startup = false/);
    assert.match(content, /model_availability_nux = "gpt-5\.4"/);
    assert.match(content, /\[features\][\s\S]*fast_mode = false[\s\S]*multi_agent = true[\s\S]*custom_feature = true[\s\S]*hooks = true/);
    assert.match(content, /\[profile\.fast\]\nmodel = "gpt-5\.4-mini"/);
  });

  it('backfills model defaults without overriding user configuration', () => {
    const content = renderCodexProjectConfig([
      'model = "gpt-5.4"',
      'model_reasoning_effort = "high"',
      '',
    ].join('\n'));

    assert.match(content, /^model = "gpt-5\.4"$/m);
    assert.match(content, /^model_reasoning_effort = "high"$/m);
    assert.doesNotMatch(content, /^model = "gpt-5\.5"$/m);
    assert.doesNotMatch(content, /^model_reasoning_effort = "medium"$/m);
  });

  it('replaces zylos-owned notice sections exactly without touching dotted siblings', () => {
    const existing = [
      '[notice]',
      'hide_full_access_warning = false',
      'stale_notice = true',
      '',
      '[notice.experimental]',
      'future_key = true',
      '',
      '[notice.model_migrations]',
      '"old-model" = "new-model"',
      '',
    ].join('\n');

    const content = renderCodexProjectConfig(existing);
    assert.match(content, /\[notice\][\s\S]*hide_full_access_warning = true/);
    assert.doesNotMatch(content, /stale_notice/);
    assert.doesNotMatch(content, /"old-model"/);
    assert.match(content, /\[notice\.experimental\]\nfuture_key = true/);
    assert.match(content, /\[notice\.model_migrations\]\n"gpt-5\.3-codex" = "gpt-5\.4"/);
  });
});

describe('Codex persistent permission defaults', () => {
  it('supports repeatable true → false → true without claiming user settings', () => {
    const first = renderCodexProjectConfig('user_setting = "keep"\n');
    assert.equal(parse(first).approval_policy, 'never');
    assert.equal(parse(first).sandbox_mode, 'danger-full-access');
    assert.equal(renderCodexProjectConfig(first), first);
    const disabled = renderCodexProjectConfig(first, { bypassPermissions: false });
    assert.equal(parse(disabled).approval_policy, undefined);
    assert.equal(parse(disabled).sandbox_mode, undefined);
    assert.equal(parse(disabled).user_setting, 'keep');
    assert.deepEqual(parse(renderCodexProjectConfig(disabled)), parse(first));
  });

  it('preserves explicit legacy and named user selections', () => {
    for (const input of [
      'approval_policy = "on-request"\nsandbox_mode = "read-only"\n',
      'approval_policy = "never"\ndefault_permissions = ":read-only"\n',
    ]) {
      const first = renderCodexProjectConfig(input);
      const disabled = parse(renderCodexProjectConfig(first, { bypassPermissions: false }));
      for (const [key, value] of Object.entries(parse(input))) assert.equal(disabled[key], value);
      if (disabled.default_permissions) assert.equal(parse(first).sandbox_mode, undefined);
    }
  });

  it('does not overwrite an edited permission or remove it on opt-out', () => {
    for (const [key, from, to] of [
      ['approval_policy', 'never', 'on-request'],
      ['sandbox_mode', 'danger-full-access', 'read-only'],
    ]) {
      const edited = renderCodexProjectConfig().replace(`${key} = "${from}"`, `${key} = "${to}"`);
      const enabled = renderCodexProjectConfig(edited);
      assert.equal(parse(enabled)[key], to);
      const disabled = parse(renderCodexProjectConfig(enabled, { bypassPermissions: false }));
      assert.equal(disabled[key], to);
      const other = key === 'approval_policy' ? 'sandbox_mode' : 'approval_policy';
      assert.equal(disabled[other], undefined);
    }
  });

  it('removes only the owned sandbox when a named profile is selected', () => {
    const content = renderCodexProjectConfig();
    const named = renderCodexProjectConfig('default_permissions = ":read-only"\n' + content);
    assert.equal(parse(named).default_permissions, ':read-only');
    assert.equal(parse(named).sandbox_mode, undefined);
    assert.equal(parse(named).approval_policy, 'never');
  });

  it('preserves explicit workspace-write options rather than bypassing them', () => {
    const existing = '[sandbox_workspace_write]\nnetwork_access = false\n';
    const config = parse(renderCodexProjectConfig(existing));
    assert.equal(config.sandbox_mode, undefined);
    assert.equal(config.sandbox_workspace_write.network_access, false);
    const edited = renderCodexProjectConfig() + existing;
    assert.equal(parse(renderCodexProjectConfig(edited)).sandbox_mode, undefined);
  });

  it('treats lost ownership comments as user-owned configuration', () => {
    const content = renderCodexProjectConfig().replace(/^# zylos-managed-permission-defaults:.*\n/m, '');
    const disabled = parse(renderCodexProjectConfig(content, { bypassPermissions: false }));
    assert.equal(disabled.approval_policy, 'never');
    assert.equal(disabled.sandbox_mode, 'danger-full-access');
  });

  it('keeps the original bytes after partial temporary writes or rename failure', () => {
    for (const failure of ['writeFileSync', 'renameSync']) {
      const project = path.join(tmpRoot, `atomic-${failure}`);
      const file = path.join(project, '.codex', 'config.toml');
      const original = 'user_setting = "keep"\n';
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, original);
      const realWrite = fs.writeFileSync;
      const fault = mock.method(fs, failure, (...args) => {
        if (failure === 'writeFileSync') realWrite(args[0], 'partial');
        throw new Error('injected write failure');
      });
      try { assert.throws(() => writeCodexProjectConfig(project), /injected write failure/); }
      finally { fault.mock.restore(); }
      assert.equal(fs.readFileSync(file, 'utf8'), original);
      assert.deepEqual(fs.readdirSync(path.dirname(file)), ['config.toml']);
    }
  });

  it('preserves symlinks and original mode before writing replacement contents', () => {
    const project = path.join(tmpRoot, 'atomic-symlink');
    const file = path.join(project, '.codex', 'config.toml');
    const target = path.join(tmpRoot, 'linked-config.toml');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(target, 'user_setting = "keep"\n');
    fs.chmodSync(target, 0o640);
    fs.symlinkSync(target, file);
    const realWrite = fs.writeFileSync;
    let observedMode;
    const inspect = mock.method(fs, 'writeFileSync', (fd, ...args) => {
      observedMode = fs.fstatSync(fd).mode & 0o777;
      return realWrite(fd, ...args);
    });
    const oldMask = process.umask(0o077);
    try { writeCodexProjectConfig(project); }
    finally { process.umask(oldMask); inspect.mock.restore(); }
    assert.equal(observedMode, 0o640);
    assert.equal(fs.statSync(target).mode & 0o777, 0o640);
    assert.ok(fs.lstatSync(file).isSymbolicLink());
    assert.equal(parse(fs.readFileSync(target, 'utf8')).sandbox_mode, 'danger-full-access');
  });

  it('creates new project configuration privately', () => {
    const project = path.join(tmpRoot, 'atomic-new');
    writeCodexProjectConfig(project);
    assert.equal(fs.statSync(path.join(project, '.codex', 'config.toml')).mode & 0o777, 0o600);
  });

  it('rejects malformed project TOML without overwriting the original', () => {
    const project = path.join(tmpRoot, 'malformed');
    const file = path.join(project, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '[broken');
    assert.throws(() => writeCodexProjectConfig(project));
    assert.equal(fs.readFileSync(file, 'utf8'), '[broken');
  });

  it('resolves explicit launch options, process env, then deployment .env', () => {
    const previous = process.env.CODEX_BYPASS_PERMISSIONS;
    const project = path.join(tmpRoot, 'bypass-source');
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, '.env'), 'CODEX_BYPASS_PERMISSIONS="false"\n');
    try {
      delete process.env.CODEX_BYPASS_PERMISSIONS;
      assert.equal(resolveCodexBypassPermissions(project), false);
      assert.equal(resolveCodexBypassPermissions(project, { bypassPermissions: true }), true);
      process.env.CODEX_BYPASS_PERMISSIONS = 'true';
      assert.equal(resolveCodexBypassPermissions(project), true);
      assert.equal(resolveCodexBypassPermissions(project, { bypassPermissions: false }), false);
      writeCodexProjectConfig(project);
      assert.equal(parse(fs.readFileSync(path.join(project, '.codex', 'config.toml'), 'utf8')).sandbox_mode, 'danger-full-access');
      delete process.env.CODEX_BYPASS_PERMISSIONS;
      writeCodexProjectConfig(project);
      assert.equal(parse(fs.readFileSync(path.join(project, '.codex', 'config.toml'), 'utf8')).sandbox_mode, undefined);
    } finally {
      if (previous === undefined) delete process.env.CODEX_BYPASS_PERMISSIONS;
      else process.env.CODEX_BYPASS_PERMISSIONS = previous;
    }
  });

  it('warns when preserved user settings can restrict unattended resume', () => {
    const project = path.join(tmpRoot, 'warn-permissions');
    fs.mkdirSync(path.join(project, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(project, '.codex', 'config.toml'), 'approval_policy = "on-request"\n');
    const old = console.warn; const warnings = [];
    console.warn = message => warnings.push(message);
    try { writeCodexProjectConfig(project, { bypassPermissions: true }); }
    finally { console.warn = old; }
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /unattended resume may be restricted or require approval/);
  });
});

describe('renderCodexGlobalConfig', () => {
  it('includes trust declaration for the project directory', () => {
    const content = renderCodexGlobalConfig('/home/user/zylos');
    assert.match(content, /\[projects\."\/home\/user\/zylos"\]\ntrust_level = "trusted"/);
  });

  it('preserves unrelated trust entries', () => {
    const existing = [
      '[projects."/tmp/other-project"]',
      'trust_level = "trusted"',
      '',
    ].join('\n');
    const content = renderCodexGlobalConfig('/home/user/zylos', existing);
    assert.match(content, /\[projects\."\/tmp\/other-project"\]/);
    assert.match(content, /\[projects\."\/home\/user\/zylos"\]/);
  });

  it('includes only the hooks feature flag, not headless settings', () => {
    const content = renderCodexGlobalConfig('/home/user/zylos');
    assert.match(content, /\[features\]\nhooks = true/);
    assert.doesNotMatch(content, /\[notice\]/);
    assert.doesNotMatch(content, /check_for_update_on_startup/);
  });

  it('includes openai_base_url when provided', () => {
    const content = renderCodexGlobalConfig('/home/user/zylos', '', { openaiBaseUrl: 'https://proxy.example.com/v1' });
    assert.match(content, /openai_base_url = "https:\/\/proxy\.example\.com\/v1"/);
  });

  it('preserves unknown global top-level keys, sections, and unrelated projects', () => {
    const existing = [
      '# User global config',
      'model_reasoning_effort = "medium"',
      '',
      '[profile.fast]',
      'model = "gpt-5.4-mini"',
      '',
      '[projects."/tmp/other-project"]',
      'trust_level = "trusted"',
      '',
    ].join('\n');

    const content = renderCodexGlobalConfig('/home/user/zylos', existing);
    assert.match(content, /^# Codex global config\./);
    assert.doesNotMatch(content, /# User global config/);
    assert.match(content, /model_reasoning_effort = "medium"/);
    assert.match(content, /\[profile\.fast\]\nmodel = "gpt-5\.4-mini"/);
    assert.match(content, /\[projects\."\/tmp\/other-project"\]\ntrust_level = "trusted"/);
    assert.match(content, /\[projects\."\/home\/user\/zylos"\]\ntrust_level = "trusted"/);
  });

  it('preserves existing openai_base_url when zylos has no value', () => {
    const existing = 'openai_base_url = "https://user-proxy.example.com/v1"\n';
    const content = renderCodexGlobalConfig('/home/user/zylos', existing);
    assert.match(content, /openai_base_url = "https:\/\/user-proxy\.example\.com\/v1"/);
  });

  it('overwrites existing openai_base_url when zylos has a value', () => {
    const existing = 'openai_base_url = "https://old-proxy.example.com/v1"\n';
    const content = renderCodexGlobalConfig('/home/user/zylos', existing, {
      openaiBaseUrl: 'https://new-proxy.example.com/v1',
    });
    assert.match(content, /openai_base_url = "https:\/\/new-proxy\.example\.com\/v1"/);
    assert.doesNotMatch(content, /old-proxy/);
  });
});

describe('writeCodexConfig', () => {
  it('writes project-level config and global config to separate locations', () => {
    const globalConfigPath = path.join(fakeHome, '.codex', 'config.toml');
    const projectDir = path.join(fakeZylosDir, 'workspace', 'project-a');
    const projectConfigPath = path.join(path.resolve(projectDir), '.codex', 'config.toml');

    fs.mkdirSync(projectDir, { recursive: true });

    assert.equal(writeCodexConfig(projectDir), true);

    // Project-level config has headless settings
    const projectContent = fs.readFileSync(projectConfigPath, 'utf8');
    assert.match(projectContent, /\[features\]\nmulti_agent = true/);
    assert.match(projectContent, /\[notice\]/);
    assert.match(projectContent, /check_for_update_on_startup = false/);
    assert.doesNotMatch(projectContent, /\[projects\./);

    // Global config has trust only
    const globalContent = fs.readFileSync(globalConfigPath, 'utf8');
    assert.match(
      globalContent,
      new RegExp(`\\[projects\\."${escapeRegExp(path.resolve(projectDir))}"\\]\\ntrust_level = "trusted"`)
    );
    assert.match(globalContent, /\[features\]\nhooks = true/);
    assert.doesNotMatch(globalContent, /\[notice\]/);
  });

  it('preserves unrelated trusted projects in global config', () => {
    const globalConfigPath = path.join(fakeHome, '.codex', 'config.toml');
    const projectDir = path.join(fakeZylosDir, 'workspace', 'project-b');
    const otherProjectDir = path.join(tmpRoot, 'other-project');

    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(otherProjectDir, { recursive: true });

    fs.writeFileSync(
      globalConfigPath,
      [
        `[projects."${otherProjectDir}"]`,
        'trust_level = "trusted"',
        '',
        `[projects."${path.resolve(projectDir)}"]`,
        'trust_level = "untrusted"',
        '',
      ].join('\n'),
      'utf8'
    );

    assert.equal(writeCodexConfig(projectDir), true);

    const globalContent = fs.readFileSync(globalConfigPath, 'utf8');
    assert.match(
      globalContent,
      new RegExp(`\\[projects\\."${escapeRegExp(path.resolve(projectDir))}"\\]\\ntrust_level = "trusted"`)
    );
    assert.match(
      globalContent,
      new RegExp(`\\[projects\\."${escapeRegExp(otherProjectDir)}"\\]\\ntrust_level = "trusted"`)
    );
    assert.doesNotMatch(
      globalContent,
      new RegExp(`\\[projects\\."${escapeRegExp(path.resolve(projectDir))}"\\]\\ntrust_level = "untrusted"`)
    );
  });

  it('preserves existing project-level config while regenerating zylos keys', () => {
    const projectDir = path.join(fakeZylosDir, 'workspace', 'project-c');
    const projectConfigPath = path.join(path.resolve(projectDir), '.codex', 'config.toml');

    fs.mkdirSync(path.dirname(projectConfigPath), { recursive: true });
    fs.writeFileSync(
      projectConfigPath,
      [
        'user_added = "keep"',
        '',
        '[features]',
        'fast_mode = true',
        '',
      ].join('\n'),
      'utf8'
    );

    assert.equal(writeCodexConfig(projectDir), true);

    const projectContent = fs.readFileSync(projectConfigPath, 'utf8');
    assert.match(projectContent, /user_added = "keep"/);
    assert.match(projectContent, /\[features\][\s\S]*fast_mode = false[\s\S]*multi_agent = true[\s\S]*hooks = true/);
  });
});

describe('parseClaudeAuthStatus', () => {
  it('returns true only when loggedIn is exactly true', () => {
    assert.equal(parseClaudeAuthStatus('{"loggedIn":true,"authMethod":"claude.ai"}'), true);
  });

  it('returns false when loggedIn is false', () => {
    assert.equal(parseClaudeAuthStatus('{"loggedIn":false}'), false);
  });

  it('returns false when loggedIn is missing', () => {
    assert.equal(parseClaudeAuthStatus('{"authMethod":"claude.ai"}'), false);
  });

  it('returns false for truthy-but-not-true loggedIn values', () => {
    assert.equal(parseClaudeAuthStatus('{"loggedIn":"true"}'), false);
    assert.equal(parseClaudeAuthStatus('{"loggedIn":1}'), false);
  });

  it('returns false for non-JSON / empty output', () => {
    assert.equal(parseClaudeAuthStatus(''), false);
    assert.equal(parseClaudeAuthStatus('Not logged in'), false);
    assert.equal(parseClaudeAuthStatus(undefined), false);
  });
});

describe('parseCodexLoginStatus', () => {
  it('returns true for the logged-in message', () => {
    assert.equal(parseCodexLoginStatus('Logged in using ChatGPT\n'), true);
    assert.equal(parseCodexLoginStatus('Logged in using API key\n'), true);
  });

  it('returns false for the not-logged-in message (which also exits 0)', () => {
    assert.equal(parseCodexLoginStatus('Not logged in\n'), false);
  });

  it('does not confuse "Not logged in" via a substring match', () => {
    // "Not logged in" contains the lowercase substring "logged in" — must not match.
    assert.equal(parseCodexLoginStatus('Not logged in'), false);
  });

  it('tolerates leading whitespace / warning-free stdout', () => {
    assert.equal(parseCodexLoginStatus('   Logged in using ChatGPT'), true);
  });

  it('matches the status line even with a leading warning line (stderr combined)', () => {
    // codex writes the status to stderr and may prepend an unrelated warning.
    assert.equal(parseCodexLoginStatus('WARNING: could not update PATH\nLogged in using ChatGPT\n'), true);
    assert.equal(parseCodexLoginStatus('WARNING: could not update PATH\nNot logged in\n'), false);
  });

  it('returns false for empty / undefined / unexpected output', () => {
    assert.equal(parseCodexLoginStatus(''), false);
    assert.equal(parseCodexLoginStatus(undefined), false);
    assert.equal(parseCodexLoginStatus('some unrelated text'), false);
  });
});

describe('classifyCodexLoginStatus', () => {
  it('classifies logged-in output as success', () => {
    assert.equal(classifyCodexLoginStatus('WARNING: could not update PATH\nLogged in using ChatGPT\n'), 'success');
  });

  it('classifies logged-out output as failure', () => {
    assert.equal(classifyCodexLoginStatus('WARNING: could not update PATH\nNot logged in\n'), 'failure');
  });

  it('classifies empty or unexpected output as uncertain', () => {
    assert.equal(classifyCodexLoginStatus(''), 'uncertain');
    assert.equal(classifyCodexLoginStatus(undefined), 'uncertain');
    assert.equal(classifyCodexLoginStatus('some unrelated text'), 'uncertain');
  });
});

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
