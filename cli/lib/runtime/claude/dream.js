import { UNSUPPORTED } from '../contract.js';

export const dream = Object.freeze({
  decodeOutput: UNSUPPORTED,
  defaultModel: 'claude-sonnet-5-5',
  defaultEffort: 'medium',
  prepare({ instructions, input, tools, env, server, serverEnv, model, effort }) {
    const childEnv = { ...env, DISABLE_AUTOUPDATER: '1', FORCE_PROMPT_CACHING_5M: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
    const args = ['--print', '--model', model, '--effort', effort,
      '--setting-sources', '', '--system-prompt', instructions, '--no-session-persistence',
      '--tools', '', '--strict-mcp-config'];
    if (tools) {
      const mcpServers = { dream: { command: process.execPath, args: [server], env: serverEnv } };
      args.push('--mcp-config', JSON.stringify({ mcpServers }), '--allowedTools',
        'mcp__dream__read_memory,mcp__dream__grep_memory,mcp__dream__glob_memory,mcp__dream__edit_memory');
    }
    return { args, env: childEnv, stdin: input };
  },
});
