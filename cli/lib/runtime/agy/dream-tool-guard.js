#!/usr/bin/env node
const names = new Set(['edit_memory', 'read_memory', 'grep_memory', 'glob_memory']
  .flatMap(name => [name, `mcp__dream__${name}`]));
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
  if (process.argv[2] === 'memory' && names.has(JSON.parse(payload)?.toolCall?.name)) {
    process.stdout.write('{"decision":"allow"}\n');
  } else reject();
} catch {
  reject();
} finally { clearTimeout(timeout); }
