#!/usr/bin/env node

/**
 * Post-install self-upgrade finalizer.
 *
 * Diagnostic entry for protected target-version state. The normal target entry
 * calls the installed finalizer in process while retaining transaction ownership.
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
  const result = await runSelfUpgradeFinalize(state);
  console.log(JSON.stringify(result));
  process.exit(result.success ? 0 : 1);
} catch (err) {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
}
