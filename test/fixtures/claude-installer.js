import fs from 'node:fs';
import path from 'node:path';

if (process.env.TEST_INSTALL_FAIL === '1') {
  console.error('isolated installer failed');
  process.exit(23);
}
const executable = path.join(process.env.HOME, '.local/bin/claude');
fs.mkdirSync(path.dirname(executable), { recursive: true });
fs.writeFileSync(executable, `#!${process.execPath}\nconsole.log('Claude Code isolated-new');\n`, { mode: 0o700 });
console.log('isolated installer completed');
