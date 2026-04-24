import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-runtime-setup-test-'));
const fakeHome = path.join(tmpRoot, 'home');
const fakeZylosDir = path.join(tmpRoot, 'zylos');

const originalHome = process.env.HOME;
const originalZylosDir = process.env.ZYLOS_DIR;

process.env.HOME = fakeHome;
process.env.ZYLOS_DIR = fakeZylosDir;

fs.mkdirSync(fakeHome, { recursive: true });
fs.mkdirSync(fakeZylosDir, { recursive: true });

const {
  writeCodexConfig,
  renderCodexProjectConfig,
  renderCodexGlobalConfig,
  renderCodexHooksConfig,
} = await import('../runtime-setup.js');

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
    assert.match(content, /\[features\]\nmulti_agent = true/);
    assert.match(content, /\[features\]\nmulti_agent = true\ncodex_hooks = true/);
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
});

describe('renderCodexHooksConfig', () => {
  it('registers the path guard for Bash tool hooks', () => {
    const content = renderCodexHooksConfig({ guardScriptPath: '/opt/zylos/cli/lib/codex-path-guard.js' });
    const parsed = JSON.parse(content);

    assert.equal(parsed.hooks.PreToolUse[0].matcher, 'Bash');
    assert.equal(parsed.hooks.PermissionRequest[0].matcher, 'Bash');
    assert.match(parsed.hooks.PreToolUse[0].hooks[0].command, /codex-path-guard\.js/);
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

  it('does not include headless settings or features', () => {
    const content = renderCodexGlobalConfig('/home/user/zylos');
    assert.doesNotMatch(content, /\[features\]/);
    assert.doesNotMatch(content, /\[notice\]/);
    assert.doesNotMatch(content, /check_for_update_on_startup/);
  });

  it('includes openai_base_url when provided', () => {
    const content = renderCodexGlobalConfig('/home/user/zylos', '', { openaiBaseUrl: 'https://proxy.example.com/v1' });
    assert.match(content, /openai_base_url = "https:\/\/proxy\.example\.com\/v1"/);
  });
});

describe('writeCodexConfig', () => {
  it('writes project-level config and global config to separate locations', () => {
    const globalConfigPath = path.join(fakeHome, '.codex', 'config.toml');
    const projectDir = path.join(fakeZylosDir, 'workspace', 'project-a');
    const projectConfigPath = path.join(path.resolve(projectDir), '.codex', 'config.toml');
    const projectHooksPath = path.join(path.resolve(projectDir), '.codex', 'hooks.json');

    fs.mkdirSync(projectDir, { recursive: true });

    assert.equal(writeCodexConfig(projectDir), true);

    // Project-level config has headless settings
    const projectContent = fs.readFileSync(projectConfigPath, 'utf8');
    assert.match(projectContent, /\[features\]\nmulti_agent = true/);
    assert.match(projectContent, /codex_hooks = true/);
    assert.match(projectContent, /\[notice\]/);
    assert.match(projectContent, /check_for_update_on_startup = false/);
    assert.doesNotMatch(projectContent, /\[projects\./);
    assert.equal(JSON.parse(fs.readFileSync(projectHooksPath, 'utf8')).hooks.PreToolUse[0].matcher, 'Bash');

    // Global config has trust only
    const globalContent = fs.readFileSync(globalConfigPath, 'utf8');
    assert.match(
      globalContent,
      new RegExp(`\\[projects\\."${escapeRegExp(path.resolve(projectDir))}"\\]\\ntrust_level = "trusted"`)
    );
    assert.doesNotMatch(globalContent, /\[features\]/);
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
});

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
