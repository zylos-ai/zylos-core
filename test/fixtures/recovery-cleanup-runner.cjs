'use strict';

// Dependency fault injection around the unchanged product recovery runner.
// Every path comes from this private test transaction, never an owner deployment.
const fs = require('node:fs');
const path = require('node:path');
const index = process.argv.indexOf('--transaction-dir');
if (index < 0 || !process.argv[index + 1]) throw Error('fixture transaction directory required');
const dir = path.resolve(process.argv[index + 1]);
const code = path.join(dir, 'code');
const remove = fs.rmSync;
fs.rmSync = function (file, options) {
  if (path.resolve(file) === code) throw Object.assign(Error('EACCES: fixture code removal denied'), {code:'EACCES'});
  return remove.call(this, file, options);
};
try {
  const out = require('./product-runner.cjs').resume(dir);
  process.stdout.write(JSON.stringify(out) + '\n');
  if (out.recovery_required) process.exitCode = 1;
} catch (error) {
  process.stdout.write(JSON.stringify({recovery_required:true, code:error.code, error:error.message}) + '\n');
  process.exitCode = 1;
} finally {
  fs.rmSync = remove;
}
