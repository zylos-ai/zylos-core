import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
const repo = process.argv[2];
const load = name => import(pathToFileURL(path.join(repo, name)).href);
const { VersionChecker } = await load('skills/dashboard/src/lib/version-checker.js');
VersionChecker.prototype.start = () => {};
const listen = http.Server.prototype.listen;
http.Server.prototype.listen = function (...args) {
  args[0] = 0; // Production config defaults reject port 0; bind only an ephemeral fixture port.
  this.once('listening', () => console.log(`ACCEPTANCE_PORT=${this.address().port}`));
  return listen.apply(this, args);
};
process.env.pm_exec_path = path.join(repo, 'skills/dashboard/src/index.js');
await load('skills/dashboard/src/index.js');
