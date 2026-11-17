import fs from 'node:fs';

const output = process.env.FAILURE_RECEIPT_CAPTURE;
if (!output) throw new Error('Missing test capture path');
let body = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  body += chunk;
  if (Buffer.byteLength(body) > 8192) process.exit(2);
});
process.stdin.on('end', () => {
  fs.appendFileSync(output, JSON.stringify({ argv: process.argv.slice(2), body }) + '\n');
});
