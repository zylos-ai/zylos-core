#!/usr/bin/env node
import fs from 'node:fs';
import { acceptDelivery } from '../src/lib/chat/channel.js';
import { isMainModule } from '../../comm-bridge/scripts/is-main-module.js';

export function runSend({ input = () => fs.readFileSync(0, 'utf8'), env = process.env, stderr = process.stderr } = {}) {
  try {
    acceptDelivery(JSON.parse(input()), { env });
    return 0;
  } catch (error) {
    stderr.write(`Error [${error.code || 'INVALID_DELIVERY'}]: Dashboard delivery unconfirmed.\n`);
    return 1;
  }
}

if (isMainModule(import.meta.url)) process.exitCode = runSend();
