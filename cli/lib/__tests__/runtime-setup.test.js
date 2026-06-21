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

const { writeCodexConfig, renderCodexProjectConfig, renderCodexGlobalConfig } = await import('../runtime-setup.js');
const { parseClaudeAuthStatus, parseCodexLoginStatus, classifyCodexLoginStatus } = await import('../auth-parsers.js');
const { renderCodexComposioMarker } = await import('../composio-mcp.js');

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
    assert.match(content, /\[features\][\s\S]*multi_agent = true[\s\S]*fast_mode = false/);
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

  it('includes Composio HTTP MCP config when a Tool Router URL is available', () => {
    const content = renderCodexProjectConfig('', {
      composioMcpUrl: 'https://backend.composio.dev/tool_router/session-123/mcp',
    });

    assert.match(content, /\[mcp_servers\.composio\]/);
    assert.match(content, /url = "https:\/\/backend\.composio\.dev\/tool_router\/session-123\/mcp"/);
    assert.match(content, /bearer_token_env_var = "COMPOSIO_API_KEY"/);
    assert.match(content, /disabled_tools = \[\s*"COMPOSIO_REMOTE_BASH_TOOL",\s*"COMPOSIO_REMOTE_WORKBENCH"\s*\]/);
  });

  it('removes marked zylos-managed Composio MCP config when no URL is available', () => {
    const existing = [
      '[mcp_servers.composio]',
      'url = "https://backend.composio.dev/tool_router/session-123/mcp"',
      'bearer_token_env_var = "COMPOSIO_API_KEY"',
      '',
      '[mcp_servers.user_server]',
      'url = "https://example.com/mcp"',
      '',
    ].join('\n');

    const content = renderCodexProjectConfig(existing, {
      codexComposioMarker: JSON.parse(renderCodexComposioMarker('https://backend.composio.dev/tool_router/session-123/mcp')),
    });

    assert.doesNotMatch(content, /\[mcp_servers\.composio\]/);
    assert.match(content, /\[mcp_servers\.user_server\]/);
  });

  it('preserves unmarked user-owned Composio MCP config when no URL is available', () => {
    const existing = [
      '[mcp_servers.composio]',
      'url = "https://backend.composio.dev/tool_router/user-owned/mcp"',
      'bearer_token_env_var = "COMPOSIO_API_KEY"',
      '',
      '[mcp_servers.user_server]',
      'url = "https://example.com/mcp"',
      '',
    ].join('\n');

    const content = renderCodexProjectConfig(existing);

    assert.match(content, /\[mcp_servers\.composio\]/);
    assert.match(content, /url = "https:\/\/backend\.composio\.dev\/tool_router\/user-owned\/mcp"/);
    assert.match(content, /\[mcp_servers\.user_server\]/);
  });

  it('does not overwrite unmarked user-owned Composio MCP config when URL is available', () => {
    const existing = [
      '[mcp_servers.composio]',
      'url = "https://example.com/user-owned/mcp"',
      'bearer_token_env_var = "USER_COMPOSIO_API_KEY"',
      '',
    ].join('\n');

    const content = renderCodexProjectConfig(existing, {
      composioMcpUrl: 'https://backend.composio.dev/tool_router/generated/mcp',
    });

    assert.match(content, /\[mcp_servers\.composio\]/);
    assert.match(content, /url = "https:\/\/example\.com\/user-owned\/mcp"/);
    assert.doesNotMatch(content, /generated/);
  });

  it('does not promote unmarked Codex Composio config even when it matches the generated shape', () => {
    const existing = [
      '[mcp_servers.composio]',
      'url = "https://backend.composio.dev/tool_router/generated/mcp"',
      'bearer_token_env_var = "COMPOSIO_API_KEY"',
      'disabled_tools = ["COMPOSIO_REMOTE_BASH_TOOL", "COMPOSIO_REMOTE_WORKBENCH"]',
      'startup_timeout_sec = 20',
      '',
    ].join('\n');

    const content = renderCodexProjectConfig(existing, {
      composioMcpUrl: 'https://backend.composio.dev/tool_router/generated/mcp',
    });

    assert.match(content, /\[mcp_servers\.composio\]/);
    assert.match(content, /url = "https:\/\/backend\.composio\.dev\/tool_router\/generated\/mcp"/);
    assert.match(content, /startup_timeout_sec = 20/);
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
    assert.match(content, /\[features\][\s\S]*fast_mode = false[\s\S]*multi_agent = true[\s\S]*custom_feature = true/);
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
    const projectMode = fs.statSync(projectConfigPath).mode & 0o777;
    assert.match(projectContent, /\[features\]\nmulti_agent = true/);
    assert.match(projectContent, /\[notice\]/);
    assert.match(projectContent, /check_for_update_on_startup = false/);
    assert.doesNotMatch(projectContent, /\[projects\./);
    assert.equal(projectMode, 0o600);

    // Global config has trust only
    const globalContent = fs.readFileSync(globalConfigPath, 'utf8');
    const globalMode = fs.statSync(globalConfigPath).mode & 0o777;
    assert.match(
      globalContent,
      new RegExp(`\\[projects\\."${escapeRegExp(path.resolve(projectDir))}"\\]\\ntrust_level = "trusted"`)
    );
    assert.doesNotMatch(globalContent, /\[features\]/);
    assert.doesNotMatch(globalContent, /\[notice\]/);
    assert.equal(globalMode, 0o600);
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
    assert.match(projectContent, /\[features\][\s\S]*fast_mode = false[\s\S]*multi_agent = true/);
  });

  it('keeps Composio inert when .env has no API key', () => {
    const projectDir = path.join(fakeZylosDir, 'workspace', 'project-composio-blank');
    const projectConfigPath = path.join(path.resolve(projectDir), '.codex', 'config.toml');

    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.env'), 'COMPOSIO_API_KEY=\nCOMPOSIO_MCP_URL=\n');

    assert.equal(writeCodexConfig(projectDir), true);

    const projectContent = fs.readFileSync(projectConfigPath, 'utf8');
    assert.doesNotMatch(projectContent, /\[mcp_servers\.composio\]/);
    assert.equal(fs.existsSync(path.join(projectDir, '.mcp.json')), false);
  });

  it('writes a Codex Composio marker when generated config is installed', () => {
    const projectDir = path.join(fakeZylosDir, 'workspace', 'project-composio-enabled');
    const projectConfigPath = path.join(path.resolve(projectDir), '.codex', 'config.toml');
    const markerPath = path.join(path.resolve(projectDir), '.codex', 'composio.zylos.json');

    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.env'), [
      'COMPOSIO_API_KEY=test-key',
      'COMPOSIO_MCP_URL=https://backend.composio.dev/tool_router/generated/mcp',
      '',
    ].join('\n'));

    assert.equal(writeCodexConfig(projectDir), true);

    const projectContent = fs.readFileSync(projectConfigPath, 'utf8');
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    const mode = fs.statSync(markerPath).mode & 0o777;
    assert.match(projectContent, /\[mcp_servers\.composio\]/);
    assert.equal(marker.managedMcpServers.composio.url, 'https://backend.composio.dev/tool_router/generated/mcp');
    assert.equal(mode, 0o600);
  });

  it('does not delete unmarked user-owned Codex Composio config when disabled', () => {
    const projectDir = path.join(fakeZylosDir, 'workspace', 'project-composio-user-owned');
    const projectConfigPath = path.join(path.resolve(projectDir), '.codex', 'config.toml');
    const markerPath = path.join(path.resolve(projectDir), '.codex', 'composio.zylos.json');

    fs.mkdirSync(path.dirname(projectConfigPath), { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.env'), 'COMPOSIO_API_KEY=\nCOMPOSIO_MCP_URL=\n');
    fs.writeFileSync(projectConfigPath, [
      '[mcp_servers.composio]',
      'url = "https://backend.composio.dev/tool_router/user-owned/mcp"',
      'bearer_token_env_var = "COMPOSIO_API_KEY"',
      '',
    ].join('\n'));

    assert.equal(writeCodexConfig(projectDir), true);

    const projectContent = fs.readFileSync(projectConfigPath, 'utf8');
    assert.match(projectContent, /\[mcp_servers\.composio\]/);
    assert.match(projectContent, /user-owned/);
    assert.equal(fs.existsSync(markerPath), false);
  });

  it('does not mark an existing unmarked Codex Composio config as generated', () => {
    const projectDir = path.join(fakeZylosDir, 'workspace', 'project-composio-user-owned-enabled');
    const projectConfigPath = path.join(path.resolve(projectDir), '.codex', 'config.toml');
    const markerPath = path.join(path.resolve(projectDir), '.codex', 'composio.zylos.json');

    fs.mkdirSync(path.dirname(projectConfigPath), { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.env'), [
      'COMPOSIO_API_KEY=test-key',
      'COMPOSIO_MCP_URL=https://backend.composio.dev/tool_router/user-owned/mcp',
      '',
    ].join('\n'));
    fs.writeFileSync(projectConfigPath, [
      '[mcp_servers.composio]',
      'url = "https://backend.composio.dev/tool_router/user-owned/mcp"',
      'bearer_token_env_var = "COMPOSIO_API_KEY"',
      'disabled_tools = ["COMPOSIO_REMOTE_BASH_TOOL", "COMPOSIO_REMOTE_WORKBENCH"]',
      'startup_timeout_sec = 20',
      '',
    ].join('\n'));

    assert.equal(writeCodexConfig(projectDir), true);

    const projectContent = fs.readFileSync(projectConfigPath, 'utf8');
    assert.match(projectContent, /startup_timeout_sec = 20/);
    assert.equal(fs.existsSync(markerPath), false);
  });

  it('removes marked Codex Composio config when disabled', () => {
    const projectDir = path.join(fakeZylosDir, 'workspace', 'project-composio-disable');
    const projectConfigPath = path.join(path.resolve(projectDir), '.codex', 'config.toml');
    const markerPath = path.join(path.resolve(projectDir), '.codex', 'composio.zylos.json');

    fs.mkdirSync(path.dirname(projectConfigPath), { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.env'), 'COMPOSIO_API_KEY=\nCOMPOSIO_MCP_URL=\n');
    fs.writeFileSync(projectConfigPath, [
      '[mcp_servers.composio]',
      'url = "https://backend.composio.dev/tool_router/generated/mcp"',
      'bearer_token_env_var = "COMPOSIO_API_KEY"',
      'disabled_tools = ["COMPOSIO_REMOTE_BASH_TOOL", "COMPOSIO_REMOTE_WORKBENCH"]',
      '',
      '[mcp_servers.user_server]',
      'url = "https://example.com/mcp"',
      '',
    ].join('\n'));
    fs.writeFileSync(markerPath, renderCodexComposioMarker('https://backend.composio.dev/tool_router/generated/mcp'));

    assert.equal(writeCodexConfig(projectDir), true);

    const projectContent = fs.readFileSync(projectConfigPath, 'utf8');
    assert.doesNotMatch(projectContent, /\[mcp_servers\.composio\]/);
    assert.match(projectContent, /\[mcp_servers\.user_server\]/);
    assert.equal(fs.existsSync(markerPath), false);
  });

  it('preserves malformed project-level Codex config without overwriting it', () => {
    const globalConfigPath = path.join(fakeHome, '.codex', 'config.toml');
    const projectDir = path.join(fakeZylosDir, 'workspace', 'project-codex-malformed-project');
    const projectConfigPath = path.join(path.resolve(projectDir), '.codex', 'config.toml');
    const malformedProject = '<malformed [mcp_servers.composio>\nurl = "https://user.example/mcp"\n';

    fs.mkdirSync(path.dirname(projectConfigPath), { recursive: true });
    fs.mkdirSync(path.dirname(globalConfigPath), { recursive: true });
    fs.writeFileSync(projectConfigPath, malformedProject);
    fs.writeFileSync(globalConfigPath, '');

    assert.equal(writeCodexConfig(projectDir), false);
    assert.equal(fs.readFileSync(projectConfigPath, 'utf8'), malformedProject);
  });

  it('preserves malformed global Codex config without overwriting it', () => {
    const globalConfigPath = path.join(fakeHome, '.codex', 'config.toml');
    const projectDir = path.join(fakeZylosDir, 'workspace', 'project-codex-malformed-global');
    const projectConfigPath = path.join(path.resolve(projectDir), '.codex', 'config.toml');
    const existingProject = 'user_added = "keep"\n';
    const malformedGlobal = '<malformed [projects."/tmp/example">\ntrust_level = "trusted"\n';

    fs.mkdirSync(path.dirname(projectConfigPath), { recursive: true });
    fs.mkdirSync(path.dirname(globalConfigPath), { recursive: true });
    fs.writeFileSync(projectConfigPath, existingProject);
    fs.writeFileSync(globalConfigPath, malformedGlobal);

    try {
      assert.equal(writeCodexConfig(projectDir), false);
      assert.equal(fs.readFileSync(projectConfigPath, 'utf8'), existingProject);
      assert.equal(fs.readFileSync(globalConfigPath, 'utf8'), malformedGlobal);
    } finally {
      fs.writeFileSync(globalConfigPath, '');
    }
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
