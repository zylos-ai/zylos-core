// Deterministic protocol smoke only; deliberately does not implement Memory Sync.
import { createInterface } from 'node:readline';
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.type === 'start') {
    process.stdout.write(JSON.stringify({ type: 'tool_call', id: 'smoke-read', name: 'read_file', arguments: { path: 'memory/identity.md' } }) + '\n');
  } else if (message.type === 'tool_result') {
    if (message.id !== 'smoke-read' || !message.result.ok || !message.result.content.includes('Finch')) process.exitCode = 1;
    process.stdout.write(JSON.stringify({ type: 'final', text: 'Transport-only stub: read completed; no Sync executed.', model: 'deterministic transport stub', modelCalls: 0 }) + '\n');
    lines.close(); break;
  }
}
