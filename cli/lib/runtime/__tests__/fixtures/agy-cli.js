import fs from 'node:fs';
import path from 'node:path';

process.title = 'agy';
fs.writeFileSync(path.resolve('agy-launch.json'), JSON.stringify({
  args: process.argv.slice(2), home: process.env.HOME, root: process.env.ZYLOS_DIR,
  apiKeyPresent: process.env.GEMINI_API_KEY === 'isolated-fake-key',
  proxy: process.env.HTTPS_PROXY, autoUpdate: process.env.AGY_CLI_DISABLE_AUTO_UPDATE,
  runId: process.env.ZYLOS_RUN_ID, group: process.env.ZYLOS_SESSION_GROUP,
}));
process.stdin.setRawMode(true);
process.stdout.write('\x1b[?2004h\n────────────────────\n> \n────────────────────\n');
let received = '';
process.stdin.on('data', chunk => {
  received += chunk.toString();
  fs.writeFileSync(path.resolve('agy-input.txt'), received);
});
