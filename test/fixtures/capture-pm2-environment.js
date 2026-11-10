import fs from 'node:fs';

const keys = ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'PATH',
  'SERVICE_SENTINEL', 'ZYLOS_RUN_ID', 'ZYLOS_SESSION_GROUP'];
fs.appendFileSync(process.env.PM2_TEST_CAPTURE, JSON.stringify({
  argv: process.argv.slice(2),
  env: Object.fromEntries(keys.filter(key => Object.hasOwn(process.env, key)).map(key => [key, process.env[key]])),
}) + '\n');
if (process.argv[2] === 'jlist') console.log('[]');
if (process.env.PM2_TEST_FAIL_FIRST_START && process.argv[2] === 'start') {
  const marker = process.env.PM2_TEST_FAIL_FIRST_START;
  if (!fs.existsSync(marker)) {
    fs.writeFileSync(marker, 'failed');
    process.exitCode = 1;
  }
}
