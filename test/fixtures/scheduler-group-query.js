import fs from 'node:fs';
const config = JSON.parse(fs.readFileSync('query.json', 'utf8'));
const endpoint = process.argv[2];
fs.appendFileSync(config.calls, JSON.stringify({ endpoint, cwd: process.cwd(), HOME: process.env.HOME,
  ZYLOS_DIR: process.env.ZYLOS_DIR, PM2_HOME: process.env.PM2_HOME, TMPDIR: process.env.TMPDIR }) + '\n');
const answer = config.answers[endpoint] ?? config.default ?? { output: '' };
if (answer.stderr) process.stderr.write(answer.stderr);
if (answer.exit) process.exit(answer.exit);
process.stdout.write(answer.output ?? '');
