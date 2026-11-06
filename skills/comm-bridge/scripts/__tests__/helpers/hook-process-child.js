import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { runHookProcess } from '../../c4-hook-process.js';

const [mode, argument] = process.argv.slice(2);
if (mode === 'leaf' || mode === 'leaf-noipc') {
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
} else if (mode === 'early-abort') {
  process.stdout.write('{"version":1,"decision":"abort","message":"too large"}');
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
} else if (mode === 'infinite-stdout') {
  fs.writeFileSync(`${argument}.leader`, String(process.pid));
  const chunk = Buffer.alloc(64 * 1024, 'x');
  const write = () => { while (process.stdout.write(chunk)) { /* Backpressure bounds queued bytes. */ } };
  process.stdout.on('drain', write);
  write();
} else if (mode === 'orphan-inherited') {
  fs.writeFileSync(`${argument}.leader`, String(process.pid));
  const child = spawn(process.execPath, [new URL(import.meta.url).pathname, 'leaf-noipc', argument], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  child.unref();
  for (let i = 0; !fs.existsSync(argument); i++) {
    if (i >= 500) throw new Error('Leaf startup exceeded fixture bound');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  process.stdout.write('{"version":1,"decision":"continue"}');
} else if (mode === 'supervise') {
  const pending = runHookProcess({ command: process.execPath,
    args: [new URL(import.meta.url).pathname, 'inherited', argument], input: '', timeoutMs: 60000 });
  process.on('message', message => { if (message === 'exit') process.exit(23); });
  for (let i = 0; !fs.existsSync(argument); i++) {
    if (i >= 500) throw new Error('Hook startup exceeded fixture bound');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  process.send?.('ready');
  await pending;
  throw new Error('Supervised parent unexpectedly returned from its hook');
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
