import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  CLAUDE_COMPOSIO_DENIED_TOOLS,
  createComposioToolRouterSession,
  deriveComposioUserId,
  resolveComposioMcpUrl,
  syncClaudeComposioMcpJson,
  syncClaudeComposioSettings,
} from '../composio-mcp.js';

const tmpDirs = [];

function mkProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-composio-test-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
  }
});

describe('resolveComposioMcpUrl', () => {
  it('stays inert when COMPOSIO_API_KEY is blank', () => {
    const projectDir = mkProject();
    fs.writeFileSync(path.join(projectDir, '.env'), 'COMPOSIO_API_KEY=\nCOMPOSIO_MCP_URL=\n');

    const result = resolveComposioMcpUrl({
      projectDir,
      createSession: () => {
        throw new Error('should not create a session');
      },
    });

    assert.equal(result.enabled, false);
    assert.equal(result.reason, 'missing_api_key');
  });

  it('creates and persists a Tool Router URL when only the API key is present', () => {
    const projectDir = mkProject();
    const envPath = path.join(projectDir, '.env');
    fs.writeFileSync(envPath, 'COMPOSIO_API_KEY=test-key\nCOMPOSIO_MCP_URL=\n');

    const result = resolveComposioMcpUrl({
      projectDir,
      createSession: (apiKey, opts) => {
        assert.equal(apiKey, 'test-key');
        assert.equal(opts.userId, deriveComposioUserId({ projectDir }));
        return 'https://backend.composio.dev/tool_router/session-123/mcp';
      },
    });

    assert.equal(result.enabled, true);
    assert.equal(result.mcpUrl, 'https://backend.composio.dev/tool_router/session-123/mcp');
    assert.match(fs.readFileSync(envPath, 'utf8'), /^COMPOSIO_MCP_URL=https:\/\/backend\.composio\.dev\/tool_router\/session-123\/mcp$/m);
  });

  it('uses explicit COMPOSIO_USER_ID and atomic .env persistence when minting a URL', () => {
    const projectDir = mkProject();
    const envPath = path.join(projectDir, '.env');
    const writes = [];
    fs.writeFileSync(envPath, [
      'COMPOSIO_API_KEY=test-key',
      'COMPOSIO_MCP_URL=',
      'COMPOSIO_USER_ID=owner-instance',
      '',
    ].join('\n'));

    const result = resolveComposioMcpUrl({
      projectDir,
      createSession: (apiKey, opts) => {
        assert.equal(apiKey, 'test-key');
        assert.equal(opts.userId, 'owner-instance');
        return 'https://backend.composio.dev/tool_router/session-456/mcp';
      },
      writeFileAtomic: (filePath, content, opts) => {
        writes.push({ filePath, content, opts });
        fs.writeFileSync(filePath, content, 'utf8');
      },
    });

    assert.equal(result.enabled, true);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].filePath, envPath);
    assert.equal(writes[0].opts.mode, 0o600);
    assert.match(writes[0].content, /^COMPOSIO_MCP_URL=https:\/\/backend\.composio\.dev\/tool_router\/session-456\/mcp$/m);
  });
});

describe('createComposioToolRouterSession', () => {
  it('sends user_id and disables workbench without exposing the API key in argv', () => {
    const result = createComposioToolRouterSession('secret-key', {
      userId: 'zylos-user',
      execFile: (cmd, args, opts) => {
        assert.equal(cmd, 'curl');
        assert.equal(args.includes('secret-key'), false);
        assert.match(opts.input, /x-api-key: secret-key/);
        const dataIdx = args.indexOf('--data');
        assert.notEqual(dataIdx, -1);
        assert.deepEqual(JSON.parse(args[dataIdx + 1]), {
          user_id: 'zylos-user',
          workbench: {
            enable: false,
          },
        });
        return JSON.stringify({
          mcp: {
            url: 'https://backend.composio.dev/tool_router/session-123/mcp',
          },
          tool_router_tools: [
            'COMPOSIO_SEARCH_TOOLS',
            'COMPOSIO_GET_TOOL_SCHEMAS',
            'COMPOSIO_MULTI_EXECUTE_TOOL',
            'COMPOSIO_MANAGE_CONNECTIONS',
          ],
          config: {
            workbench: {
              enable: false,
            },
          },
        });
      },
    });

    assert.equal(result, 'https://backend.composio.dev/tool_router/session-123/mcp');
  });

  it('rejects session responses that still expose remote code tools', () => {
    assert.throws(() => createComposioToolRouterSession('secret-key', {
      userId: 'zylos-user',
      execFile: () => JSON.stringify({
        mcp: {
          url: 'https://backend.composio.dev/tool_router/session-123/mcp',
        },
        tool_router_tools: [
          'COMPOSIO_REMOTE_BASH_TOOL',
          'COMPOSIO_REMOTE_WORKBENCH',
        ],
      }),
    }), /still exposes remote code tools/);
  });
});

describe('syncClaudeComposioMcpJson', () => {
  it('does not create .mcp.json when the integration is disabled', () => {
    const projectDir = mkProject();
    fs.writeFileSync(path.join(projectDir, '.env'), 'COMPOSIO_API_KEY=\n');

    const result = syncClaudeComposioMcpJson({ projectDir });

    assert.equal(result.enabled, false);
    assert.equal(result.changed, false);
    assert.equal(fs.existsSync(path.join(projectDir, '.mcp.json')), false);
  });

  it('writes a resolved local .mcp.json and is idempotent', () => {
    const projectDir = mkProject();
    fs.writeFileSync(path.join(projectDir, '.env'), [
      'COMPOSIO_API_KEY=test-key',
      'COMPOSIO_MCP_URL=https://backend.composio.dev/tool_router/session-123/mcp',
      '',
    ].join('\n'));

    const first = syncClaudeComposioMcpJson({ projectDir });
    const second = syncClaudeComposioMcpJson({ projectDir });
    const mcpPath = path.join(projectDir, '.mcp.json');
    const parsed = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
    const marker = JSON.parse(fs.readFileSync(path.join(projectDir, '.mcp.zylos.json'), 'utf8'));
    const mode = fs.statSync(mcpPath).mode & 0o777;
    const markerMode = fs.statSync(path.join(projectDir, '.mcp.zylos.json')).mode & 0o777;

    assert.equal(first.changed, true);
    assert.equal(second.changed, false);
    assert.equal(parsed.mcpServers.composio.type, 'http');
    assert.equal(parsed.mcpServers.composio.url, 'https://backend.composio.dev/tool_router/session-123/mcp');
    assert.equal(parsed.mcpServers.composio.headers['x-api-key'], 'test-key');
    assert.equal(marker.managedMcpServers.composio.source, 'zylos-core');
    assert.equal(marker.managedMcpServers.composio.url, 'https://backend.composio.dev/tool_router/session-123/mcp');
    assert.equal(marker.managedMcpServers.composio.apiKeyEnv, 'COMPOSIO_API_KEY');
    assert.equal(mode, 0o600);
    assert.equal(markerMode, 0o600);
  });

  it('removes marked generated Composio config when disabled without dropping unrelated entries', () => {
    const projectDir = mkProject();
    const mcpPath = path.join(projectDir, '.mcp.json');
    const markerPath = path.join(projectDir, '.mcp.zylos.json');
    fs.writeFileSync(path.join(projectDir, '.env'), 'COMPOSIO_API_KEY=\n');
    fs.writeFileSync(mcpPath, JSON.stringify({
      mcpServers: {
        composio: {
          type: 'http',
          url: 'https://backend.composio.dev/tool_router/session-123/mcp',
          headers: {
            'x-api-key': 'old-key',
          },
        },
        user_server: {
          type: 'http',
          url: 'https://example.com/mcp',
        },
      },
    }, null, 2));
    fs.writeFileSync(markerPath, JSON.stringify({
      version: 1,
      managedMcpServers: {
        composio: {
          source: 'zylos-core',
          url: 'https://backend.composio.dev/tool_router/session-123/mcp',
          apiKeyEnv: 'COMPOSIO_API_KEY',
        },
      },
    }, null, 2));

    const result = syncClaudeComposioMcpJson({ projectDir });
    const parsed = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));

    assert.equal(result.changed, true);
    assert.equal(parsed.mcpServers.composio, undefined);
    assert.equal(parsed.mcpServers.user_server.url, 'https://example.com/mcp');
    assert.equal(fs.existsSync(markerPath), false);
  });

  it('preserves unmarked user-owned Composio config with an API-key header when disabled', () => {
    const projectDir = mkProject();
    const mcpPath = path.join(projectDir, '.mcp.json');
    fs.writeFileSync(path.join(projectDir, '.env'), 'COMPOSIO_API_KEY=\n');
    fs.writeFileSync(mcpPath, JSON.stringify({
      mcpServers: {
        composio: {
          type: 'http',
          url: 'https://example.com/composio/mcp',
          headers: {
            'x-api-key': 'user-owned-key',
          },
        },
      },
    }, null, 2));

    const result = syncClaudeComposioMcpJson({ projectDir });
    const parsed = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));

    assert.equal(result.changed, false);
    assert.equal(parsed.mcpServers.composio.headers['x-api-key'], 'user-owned-key');
  });

  it('preserves unmarked user-owned Composio config even when it uses a Tool Router URL', () => {
    const projectDir = mkProject();
    const mcpPath = path.join(projectDir, '.mcp.json');
    fs.writeFileSync(path.join(projectDir, '.env'), 'COMPOSIO_API_KEY=\n');
    fs.writeFileSync(mcpPath, JSON.stringify({
      mcpServers: {
        composio: {
          type: 'http',
          url: 'https://backend.composio.dev/tool_router/user-owned/mcp',
          headers: {
            'x-api-key': 'user-owned-key',
          },
        },
      },
    }, null, 2));

    const result = syncClaudeComposioMcpJson({ projectDir });
    const parsed = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));

    assert.equal(result.changed, false);
    assert.equal(parsed.mcpServers.composio.url, 'https://backend.composio.dev/tool_router/user-owned/mcp');
  });

  it('does not overwrite an unmarked user-owned Composio config when enabling', () => {
    const projectDir = mkProject();
    const mcpPath = path.join(projectDir, '.mcp.json');
    const logs = [];
    fs.writeFileSync(path.join(projectDir, '.env'), [
      'COMPOSIO_API_KEY=test-key',
      'COMPOSIO_MCP_URL=https://backend.composio.dev/tool_router/generated/mcp',
      '',
    ].join('\n'));
    fs.writeFileSync(mcpPath, JSON.stringify({
      mcpServers: {
        composio: {
          type: 'http',
          url: 'https://example.com/composio/mcp',
          headers: {
            'x-api-key': 'user-owned-key',
          },
        },
      },
    }, null, 2));

    const result = syncClaudeComposioMcpJson({ projectDir, log: (line) => logs.push(line) });
    const parsed = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));

    assert.equal(result.changed, false);
    assert.equal(result.enabled, false);
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'user_owned_collision');
    assert.equal(parsed.mcpServers.composio.url, 'https://example.com/composio/mcp');
    assert.equal(fs.existsSync(path.join(projectDir, '.mcp.zylos.json')), false);
    assert.ok(logs.some(line => line.includes('unmarked Composio MCP server')));
  });
});

describe('syncClaudeComposioSettings', () => {
  it('merges server approval and remote code-exec denies without dropping user settings', () => {
    const settings = {
      enabledMcpjsonServers: ['existing'],
      permissions: {
        allow: ['Bash(git:*)'],
        deny: ['Read(/secret/**)'],
      },
    };

    const result = syncClaudeComposioSettings(settings);

    assert.equal(result.changed, true);
    assert.deepEqual(settings.enabledMcpjsonServers, ['existing', 'composio']);
    assert.ok(settings.permissions.allow.includes('Bash(git:*)'));
    assert.ok(settings.permissions.allow.includes('mcp__composio__COMPOSIO_SEARCH_TOOLS'));
    for (const deny of CLAUDE_COMPOSIO_DENIED_TOOLS) {
      assert.ok(settings.permissions.deny.includes(deny));
    }
  });
});
