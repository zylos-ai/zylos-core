#!/usr/bin/env node

/**
 * Post-install self-upgrade finalizer.
 *
 * The parent upgrader process runs steps 1-4 using the currently loaded code,
 * installs the new package, then invokes this script from the newly installed
 * package so steps 5-13 use the new implementation.
 */

import fs from 'node:fs';
import { runSelfUpgradeFinalize } from './self-upgrade.js';

const statePath = process.argv[2];

if (!statePath) {
  console.error('Usage: node self-upgrade-finalize.js <state-file>');
  process.exit(1);
}

try {
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const result = runSelfUpgradeFinalize(state);
  console.log(JSON.stringify(result));
  process.exit(result.success ? 0 : 1);
} catch (err) {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
}
