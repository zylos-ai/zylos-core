import fs from 'node:fs';
const args = process.argv.slice(2);
fs.writeFileSync(process.env.GROUP_NAME_FIXTURE_RECORD, JSON.stringify({
  args, root: process.env.ZYLOS_DIR, inheritedGroup: process.env.ZYLOS_SESSION_GROUP ?? null,
}));
if (process.env.GROUP_NAME_FIXTURE_FAIL === '1') process.exitCode = 1;
else {
  const rows = JSON.parse(fs.readFileSync(process.env.GROUP_NAME_FIXTURE_ROWS, 'utf8'));
  process.stdout.write(JSON.stringify({ ok: true, data: args.includes('--active-since') ? { groups: rows, hasOlder: false } : rows }) + '\n');
}
