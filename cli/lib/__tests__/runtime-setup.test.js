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

const { renderCodexProjectConfig, renderCodexGlobalConfig, writeCodexProjectConfig } = await import('../runtime/codex/hooks.js');
const { parseClaudeAuthStatus, parseCodexLoginStatus } = await import('../auth-parsers.js');

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
    assert.match(content, /^model = "gpt-6\.2-sol"$/m);
    assert.match(content, /^model_reasoning_effort = "medium"$/m);
    assert.match(content, /\[features\][\s\S]*multi_agent = true[\s\S]*fast_mode = false[\s\S]*hooks = true/);
    assert.match(content, /\[notice\]/);
    assert.match(content, /hide_full_access_warning = true/);
    assert.match(content, /hide_rate_limit_model_nudge = true/);
    assert.match(content, /\[notice\.model_migrations\]/);
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

});

describe('Codex persistent permission defaults', () => {

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

  it('rejects malformed project TOML without overwriting the original', () => {
    const project = path.join(tmpRoot, 'malformed');
    const file = path.join(project, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '[broken');
    assert.throws(() => writeCodexProjectConfig(project));
    assert.equal(fs.readFileSync(file, 'utf8'), '[broken');
  });

});

describe('renderCodexGlobalConfig', () => {
  it('includes trust declaration for the project directory', () => {
    const content = renderCodexGlobalConfig('/home/user/zylos');
    assert.match(content, /\[projects\."\/home\/user\/zylos"\]\ntrust_level = "trusted"/);
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

});

describe('parseClaudeAuthStatus', () => {
  it('returns true only when loggedIn is exactly true', () => {
    assert.equal(parseClaudeAuthStatus('{"loggedIn":true,"authMethod":"claude.ai"}'), true);
  });

});

describe('parseCodexLoginStatus', () => {

  it('does not confuse "Not logged in" via a substring match', () => {
    // "Not logged in" contains the lowercase substring "logged in" — must not match.
    assert.equal(parseCodexLoginStatus('Not logged in'), false);
  });

});
