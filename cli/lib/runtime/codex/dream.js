import fs from 'node:fs';
import path from 'node:path';

export const dream = Object.freeze({
  prepare({ instructions, input, tools, cwd, env, server, serverEnv, schema }) {
    const answer = path.join(cwd, 'answer.json');
    const args = ['-a', 'never', 'exec', '-m', 'gpt-6.1-terra', '-c', 'model_reasoning_effort="medium"',
      '--sandbox', 'read-only', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check',
      '--ephemeral', '--disable', 'shell_tool', '--disable', 'unified_exec', '--disable', 'hooks',
      '--disable', 'apps', '--disable', 'multi_agent', '-c', 'web_search="disabled"',
      '-c', 'mcp_servers={}', '-c', `developer_instructions=${JSON.stringify(instructions)}`,
      '--output-last-message', answer];
    if (schema) {
      const file = path.join(cwd, 'output-schema.json');
      fs.writeFileSync(file, JSON.stringify(schema), { mode: 0o600 });
      args.push('--output-schema', file);
    }
    if (tools) {
      args.push('-c', `mcp_servers.dream.command=${JSON.stringify(process.execPath)}`,
        '-c', `mcp_servers.dream.args=${JSON.stringify([server])}`);
      for (const [key, value] of Object.entries(serverEnv)) args.push('-c', `mcp_servers.dream.env.${key}=${JSON.stringify(value)}`);
    }
    // Large prompts exceed the OS per-argument limit. Write once and close stdin.
    return { args: [...args, '-'], env, stdin: input, answer };
  },
});
