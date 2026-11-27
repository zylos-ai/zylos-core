import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { agyConfigurationPaths } from './hooks.js';

const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const toolGuard = fileURLToPath(new URL('./dream-tool-guard.js', import.meta.url));

export const dream = Object.freeze({
  decodeOutput(stdout) {
    // A single input turn produces one terminal result after the step updates.
    const output = stdout.trimEnd();
    const terminal = JSON.parse(output.slice(output.lastIndexOf('\n') + 1));
    if (terminal?.event !== 'result' || terminal.result?.status !== 'SUCCESS') {
      throw new Error('Antigravity did not return a successful dream model result');
    }
    const answer = terminal.result.structured_output ?? terminal.result.response;
    return typeof answer === 'string' ? answer : JSON.stringify(answer ?? null);
  },
  prepare({ instructions, input, tools, cwd, env, server, serverEnv, schema }) {
    const home = path.join(cwd, 'home');
    const config = agyConfigurationPaths(home);
    function write(file, value) {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
    }
    write(path.join(cwd, 'AGENTS.md'), instructions);
    const settings = { modelProvider: 'gemini', trustedWorkspaces: [cwd] };
    if (tools) settings.permissions = { allow: ['mcp(dream/*)'] };
    const descriptions = path.join(path.dirname(config.settings), 'mcp', 'dream');
    write(config.settings, { ...settings, userDataCollectionForceDisabled: true });
    write(config.onboarding, { consumerOnboardingComplete: true, onboardingComplete: true });
    write(config.hooks, { dreaming: { PreToolUse: [{ matcher: '.*', hooks: [{
      type: 'command', command: [process.execPath, toolGuard, ...(tools ? ['memory', descriptions] : [])].map(quote).join(' '), timeout: 5,
    }] }] } });
    write(config.mcp, { mcpServers: tools ? { dream: { command: process.execPath, args: [server], env: serverEnv } } : {} });
    const args = ['--settings', JSON.stringify(settings), '--model', 'Gemini 4 Hydrogen (Medium)',
      '--disable-slash-commands', '--sandbox', '--output-format', 'stream-json'];
    if (schema) {
      const file = path.join(cwd, 'output-schema.json');
      write(file, schema);
      args.push('--json-schema', file);
    }
    return {
      args: [...args, '--input-format', 'stream-json', '-p', ''],
      env: { ...env, HOME: home, AGY_CLI_DISABLE_AUTO_UPDATE: 'true' },
      stdin: JSON.stringify({ event: 'user', message: { role: 'user', content: input } }) + '\n',
    };
  },
});
