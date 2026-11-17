#!/usr/bin/env node
import fs from 'node:fs';

// Run as the launched runtime, and retain only the identity under test.
const { ZYLOS_RUN_ID, ZYLOS_MODEL_CONFIG, ZYLOS_SESSION_GROUP } = process.env;
fs.writeFileSync(`identity-${ZYLOS_RUN_ID}.json`, JSON.stringify({
  ZYLOS_RUN_ID, ZYLOS_MODEL_CONFIG, ZYLOS_SESSION_GROUP,
}));
setInterval(() => {}, 1000);
