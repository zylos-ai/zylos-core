import fs from 'node:fs';
import path from 'node:path';
import { UNSUPPORTED } from '../contract.js';

export const dream = Object.freeze({
  decodeOutput: UNSUPPORTED,
  defaultModel: 'gpt-6.1-terra',
  defaultEffort: 'medium',
  prepare({ instructions, input, tools, cwd, env, server, serverEnv, schema, model, effort }) {
    const answer = path.join(cwd, 'answer.json');
    const args = ['-a', 'never', 'exec', '-m', model, '-c', `model_reasoning_effort=${JSON.stringify(effort)}`,
      '--sandbox', 'read-only', '--ignore-rules', '--skip-git-repo-check',
      '--ephemeral', '--disable', 'shell_tool', '--disable', 'unified_exec', '--disable', 'hooks',
      '--disable', 'apps', '--disable', 'multi_agent', '-c', 'web_search="disabled"',
      '-c', 'mcp_servers={}', '-c', 'notify=[]', '-c', `developer_instructions=${JSON.stringify(instructions)}`,
      '--output-last-message', answer];
    if (schema) {
      const file = path.join(cwd, 'output-schema.json');
      fs.writeFileSync(file, JSON.stringify(schema), { mode: 0o600 });
      args.push('--output-schema', file);
    }
    if (tools) {
      args.push('-c', `mcp_servers.dream.command=${JSON.stringify(process.execPath)}`,
        '-c', `mcp_servers.dream.args=${JSON.stringify([server])}`,
        '-c', 'mcp_servers.dream.default_tools_approval_mode="approve"');
      for (const [key, value] of Object.entries(serverEnv)) args.push('-c', `mcp_servers.dream.env.${key}=${JSON.stringify(value)}`);
    }
    // Large prompts exceed the OS per-argument limit. Write once and close stdin.
    return { args: [...args, '-'], env, stdin: input, answer };
  },
});
