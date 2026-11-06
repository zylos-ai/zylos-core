import fs from 'node:fs';
import { spawn } from 'node:child_process';

const [mode, argument] = process.argv.slice(2);
if (mode === 'leaf') {
  fs.writeFileSync(argument, String(process.pid));
  process.send?.('ready');
  setInterval(() => {}, 1000);
} else if (mode === 'normal') {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  process.stderr.write('private stderr must not be exposed');
  process.stdout.write(JSON.stringify({ input, argv: process.argv.slice(2) }));
} else if (mode === 'nonzero') {
  process.stdout.write('{"decision":"continue"}');
  process.exitCode = 7;
} else if (mode === 'signal') {
  process.kill(process.pid, 'SIGTERM');
} else if (mode === 'delay') {
  setTimeout(() => process.stdout.write('finished'), Number(argument));
} else if (mode === 'stdout' || mode === 'stdout-delay') {
  // Multibyte output makes the limit distinguish UTF-8 bytes from characters.
  const size = Number(argument);
  const output = Buffer.from('é'.repeat(Math.floor(size / 2)) + (size % 2 ? 'x' : ''));
  const write = () => process.stdout.write(output);
  if (mode === 'stdout-delay') setTimeout(write, 100);
  else write();
} else if (mode === 'stderr') {
  process.stderr.write(Buffer.alloc(2 * 1024 * 1024, 'x'), () => process.stdout.write('finished'));
} else if (mode === 'inherited' || mode === 'orphan') {
  fs.writeFileSync(`${argument}.leader`, String(process.pid));
  const child = spawn(process.execPath, [new URL(import.meta.url).pathname, 'leaf', argument], {
    stdio: ['ignore', mode === 'inherited' ? 'inherit' : 'ignore', mode === 'inherited' ? 'inherit' : 'ignore', 'ipc'],
  });
  child.once('message', () => {
    process.stdout.write(`child=${child.pid}`);
    if (mode === 'orphan') process.exit(0);
    else setInterval(() => {}, 1000);
  });
}
