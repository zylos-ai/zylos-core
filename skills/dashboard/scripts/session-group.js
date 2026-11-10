#!/usr/bin/env node
import { validateGroupName } from '../../comm-bridge/scripts/c4-session-group.js';
import { isMainModule } from '../../comm-bridge/scripts/is-main-module.js';

export function runSessionGroup(args = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    if (args.length !== 1) throw new Error('Expected one Dashboard conversation address.');
    const [endpoint] = args;
    if (endpoint === 'origin') throw new Error('Dashboard origin is a fixed Core address.');
    validateGroupName(endpoint);
    stdout.write(`${endpoint}\n`);
    return 0;
  } catch (error) {
    stderr.write(`${error.message}\n`);
    return 1;
  }
}

if (isMainModule(import.meta.url)) process.exitCode = runSessionGroup();
