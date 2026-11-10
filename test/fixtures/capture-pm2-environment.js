import fs from 'node:fs';

const keys = ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'PATH',
  'SERVICE_SENTINEL', 'ZYLOS_RUN_ID', 'ZYLOS_SESSION_GROUP'];
fs.appendFileSync(process.env.PM2_TEST_CAPTURE, JSON.stringify({
  argv: process.argv.slice(2),
  env: Object.fromEntries(keys.filter(key => Object.hasOwn(process.env, key)).map(key => [key, process.env[key]])),
}) + '\n');
