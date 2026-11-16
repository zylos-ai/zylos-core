import fs from 'node:fs';
process.title = 'codex';
process.stdin.setRawMode(true);
process.stdout.write('\x1b[2J\x1b[H❯ ');
process.stdin.on('data', bytes => {
  fs.appendFileSync(process.env.SINGLETON_TERMINAL_RECEIPT, bytes);
  if (bytes.includes(13)) process.stdout.write('\x1b[2J\x1b[H❯ ');
});
