import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { UNSUPPORTED } from '../contract.js';
import { runtimeExecutable } from '../session-command.js';

function listMcpServerNames(env, cwd) {
  let output;
  try {
    output = execFileSync(runtimeExecutable('codex', env), ['mcp', 'list', '--json'], {
      cwd, env, encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (error) {
    const reason = error.code ?? error.signal ?? `exit status ${error.status}`;
    throw new Error(`Codex MCP list query failed (${reason})`);
  }

  let servers;
  try {
    servers = JSON.parse(output);
  } catch {
    throw new Error('Codex MCP list query failed: invalid JSON');
  }
  if (!Array.isArray(servers)) throw new Error('Codex MCP list query failed: expected an array');
  const names = new Set();
  for (const server of servers) {
    const name = server?.name;
    if (typeof name !== 'string' || !name) {
      throw new Error('Codex MCP list query failed: invalid server name');
    }
    names.add(name);
  }
  return names;
}

export const dream = Object.freeze({
  decodeOutput: UNSUPPORTED,
  defaultModel: 'gpt-6.1-terra',
  defaultEffort: 'medium',
  prepare({ instructions, input, tools, cwd, env, server, serverEnv, schema, model, effort }) {
    const serverNames = listMcpServerNames(env, cwd);
    const answer = path.join(cwd, 'answer.json');
    const args = ['-a', 'never', 'exec', '-m', model, '-c', `model_reasoning_effort=${JSON.stringify(effort)}`,
      '--sandbox', 'read-only', '--ignore-rules', '--skip-git-repo-check',
      '--ephemeral', '--disable', 'shell_tool', '--disable', 'unified_exec', '--disable', 'hooks',
      '--disable', 'apps', '--disable', 'multi_agent', '--disable', 'plugins', '-c', 'web_search="disabled"',
      '-c', 'notify=[]', '-c', `developer_instructions=${JSON.stringify(instructions)}`,
      '--output-last-message', answer];
    if (schema) {
      const file = path.join(cwd, 'output-schema.json');
      fs.writeFileSync(file, JSON.stringify(schema), { mode: 0o600 });
      args.push('--output-schema', file);
    }
    if (serverNames.size > 0) {
      // Quoted TOML keys preserve names that Codex would split in a dotted CLI key.
      const disabled = [...serverNames].map(name => {
        const key = JSON.stringify(name).replaceAll('\x7f', '\\u007F');
        return `${key}={enabled=false}`;
      });
      args.push('-c', `mcp_servers={${disabled.join(',')}}`);
    }
    if (tools) {
      let name = 'dream';
      for (let suffix = 1; serverNames.has(name); suffix++) name = `dream-${suffix}`;
      const key = `mcp_servers.${name}`;
      args.push('-c', `${key}.command=${JSON.stringify(process.execPath)}`,
        '-c', `${key}.args=${JSON.stringify([server])}`,
        '-c', `${key}.default_tools_approval_mode="approve"`);
      for (const [envKey, value] of Object.entries(serverEnv)) {
        args.push('-c', `${key}.env.${envKey}=${JSON.stringify(value)}`);
      }
      args.push('-c', `${key}.enabled=true`);
    }
    // Large prompts exceed the OS per-argument limit. Write once and close stdin.
    return { args: [...args, '-'], env, stdin: input, answer };
  },
});
