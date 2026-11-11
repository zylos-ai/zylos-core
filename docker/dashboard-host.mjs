#!/usr/bin/env node
// Lets the published Dashboard port reach Dashboard inside the container: sets `host` to 0.0.0.0 in
// components/dashboard/config.json when the file has no `host` of its own. An owner's value is kept,
// a missing or unreadable file is left alone but reported (exit 1, so the entrypoint warns that the
// published port may not reach Dashboard), and the file keeps its permissions.
import fs from 'node:fs';
import path from 'node:path';

const file = process.argv[2];
if (!file) {
  console.error('usage: dashboard-host.mjs <components/dashboard/config.json>');
  process.exit(2);
}
let text;
try { text = fs.readFileSync(file, 'utf8'); } catch (error) {
  if (error.code === 'ENOENT') {
    console.error('Dashboard config not found; host unchanged');
    process.exit(1);
  }
  console.error(`Dashboard config unreadable (${error.code ?? error.message}); host unchanged`);
  process.exit(1);
}
let config;
try { config = JSON.parse(text); } catch {
  console.error('Dashboard config is not valid JSON; host unchanged');
  process.exit(1);
}
if (!config || typeof config !== 'object' || Array.isArray(config)) {
  console.error('Dashboard config is not a JSON object; host unchanged');
  process.exit(1);
}
if (Object.hasOwn(config, 'host')) {
  console.log(`Dashboard host kept: ${config.host}`);
  process.exit(0);
}
config.host = '0.0.0.0';
const mode = fs.statSync(file).mode & 0o777;
const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
try {
  fs.writeFileSync(temporary, JSON.stringify(config, null, 2) + '\n', { mode, flag: 'wx' });
  fs.chmodSync(temporary, mode);
  fs.renameSync(temporary, file);
} catch (error) {
  try { fs.unlinkSync(temporary); } catch { /* already gone */ }
  console.error(`Dashboard config not written (${error.code ?? error.message}); host unchanged`);
  process.exit(1);
}
console.log('Dashboard listens on 0.0.0.0 inside the container');
