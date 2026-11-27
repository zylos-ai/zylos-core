#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const names = new Set(['edit_memory', 'read_memory', 'grep_memory', 'glob_memory']);
function readsStepOutput(file, { conversationId, artifactDirectoryPath }, brain) {
  if (typeof file !== 'string' || !brain || typeof conversationId !== 'string'
    || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(conversationId)) return false;
  const directory = path.join(brain, conversationId);
  const prefix = path.join(directory, '.system_generated', 'steps') + path.sep;
  if (artifactDirectoryPath !== directory || !file.startsWith(prefix)) return false;
  const [step, basename, extra] = file.slice(prefix.length).split(path.sep);
  if (!step || /\D/.test(step) || basename !== 'output.txt' || extra !== undefined) return false;
  return fs.realpathSync(file) === file && fs.lstatSync(file).isFile();
}

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
  const event = JSON.parse(payload);
  const tool = event?.toolCall;
  const memoryMode = process.argv[2] === 'memory';
  const descriptions = process.argv[3];
  const usesMemory = tool?.name === 'call_mcp_tool'
    && tool.args?.ServerName === 'dream' && names.has(tool.args.ToolName);
  const readsDescription = tool?.name === 'read_file' && descriptions
    && [...names].some(name => tool.args?.Path === path.join(descriptions, `${name}.json`));
  const readsOutput = memoryMode && tool?.name === 'read_file'
    && readsStepOutput(tool.args?.Path, event, process.argv[4]);
  if (tool?.name === 'finish' || (memoryMode && (usesMemory || readsDescription || readsOutput))) {
    process.stdout.write('{"decision":"allow"}\n');
  } else reject();
} catch {
  reject();
} finally { clearTimeout(timeout); }
