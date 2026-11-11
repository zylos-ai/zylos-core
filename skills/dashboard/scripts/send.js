#!/usr/bin/env node
import fs from 'node:fs';
import { acceptDelivery } from '../src/lib/chat/channel.js';
import { isMainModule } from '../../comm-bridge/scripts/is-main-module.js';

export function runSend({ input = () => fs.readFileSync(0, 'utf8'), env = process.env, stderr = process.stderr } = {}) {
  try {
    acceptDelivery(JSON.parse(input()), { env });
    return 0;
  } catch (error) {
    const stored = error.storedControlFailure === true || error.storedAttachmentFailure === true
      || error.code?.startsWith('QUESTION_') || error.code === 'INVALID_CONTENT';
    const message = stored
      ? `${error.message} Message is already stored in C4 and visible read-only in Dashboard. Do not resend.`
      : 'Dashboard delivery unconfirmed.';
    stderr.write(`Error [${error.code || 'INVALID_DELIVERY'}]: ${message}\n`);
    return 1;
  }
}

if (isMainModule(import.meta.url)) process.exitCode = runSend();
