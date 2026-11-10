'use strict';

// A standalone subprocess fixture. It never loads or rewrites product source.
const fs = require('node:fs');
const path = require('node:path');
const index = process.argv.indexOf('--transaction-dir');
if (index < 0 || !process.argv[index + 1]) throw Error('fixture transaction directory required');
const dir = path.resolve(process.argv[index + 1]);
const settings = JSON.parse(fs.readFileSync(path.join(dir, 'fixture.json'), 'utf8'));
fs.writeFileSync(path.resolve(dir, '../../../fixture-child.json'), JSON.stringify({pid:process.pid, ppid:process.ppid}));
if (settings.mode === 'crash') {
  process.stderr.write('fixture recovery child crashed before returning a result\n');
  process.exit(23);
}
if (settings.mode === 'invalid') {
  process.stdout.write('not a recovery result\n');
  process.exit(0);
}
if (settings.mode === 'cleanup-warning') {
  process.stdout.write(JSON.stringify({completed:false, complete:false, recovery_required:false,
    warnings:['Code cleanup pending: EACCES: fixture code removal denied']}) + '\n');
  process.exit(0);
}
if (settings.mode === 'clean') {
  const marker = path.resolve(dir, '../../../.zylos/upgrade/active.json');
  fs.unlinkSync(marker);
  fs.rmSync(dir, {recursive:true});
}
process.stdout.write(JSON.stringify({completed:false, recovery_required:false}) + '\n');
