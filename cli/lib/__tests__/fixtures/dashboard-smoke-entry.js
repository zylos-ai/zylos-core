import { mock } from 'node:test';
import * as childProcess from 'node:child_process';
import { promisify } from 'node:util';

// Exercise the real Dashboard entry guard without querying host services or
// the version registry. The Store still opens its isolated fixture database.
const execFile = (...args) => {
  const callback = args.at(-1);
  queueMicrotask(() => callback(null, '[]', ''));
  return { kill() {} };
};
execFile[promisify.custom] = async () => ({ stdout: '[]', stderr: '' });
mock.module('node:child_process', { namedExports: {
  ...childProcess, execFile, execFileSync: () => '1.0.0',
} });
const dashboard = new URL('../../../../skills/dashboard/src/index.js', import.meta.url);
mock.module(new URL('./lib/version-checker.js', dashboard).href, { namedExports: {
  VersionChecker: class { start() {} getLatest() { return {}; } },
} });
await import(dashboard.href);
