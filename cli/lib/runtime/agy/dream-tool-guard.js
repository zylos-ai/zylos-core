#!/usr/bin/env node
import path from 'node:path';

const names = new Set(['edit_memory', 'read_memory', 'grep_memory', 'glob_memory']);
let payload = '';
let replied = false;
const reject = () => {
  if (replied) return;
  replied = true;
  process.stdout.write('{"decision":"deny","reason":"This dream call cannot use that tool."}\n');
};
const timeout = setTimeout(() => { reject(); process.stdin.destroy(); }, 1000);
process.stdin.setEncoding('utf8');
try {
  for await (const chunk of process.stdin) {
    payload += chunk;
    if (payload.length > 256 * 1024) throw new Error('Tool input is too large');
  }
  const tool = JSON.parse(payload)?.toolCall;
  const memoryMode = process.argv[2] === 'memory';
  const descriptions = process.argv[3];
  const usesMemory = tool?.name === 'call_mcp_tool'
    && tool.args?.ServerName === 'dream' && names.has(tool.args.ToolName);
  const readsDescription = tool?.name === 'read_file' && descriptions
    && [...names].some(name => tool.args?.Path === path.join(descriptions, `${name}.json`));
  if (tool?.name === 'finish' || (memoryMode && (usesMemory || readsDescription))) {
    process.stdout.write('{"decision":"allow"}\n');
  } else reject();
} catch {
  reject();
} finally { clearTimeout(timeout); }
