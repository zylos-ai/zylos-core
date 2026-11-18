// Stand-in hook target for the hook entry tests: records that it ran, with the
// argv it saw and the stdin payload it received.
import fs from 'node:fs';

let input = '';
for await (const chunk of process.stdin) input += chunk;
fs.appendFileSync(process.env.HOOK_ENTRY_TARGET_MARK, `${JSON.stringify({ argv: process.argv.slice(1), input })}\n`);
process.stdout.write('target output\n');
