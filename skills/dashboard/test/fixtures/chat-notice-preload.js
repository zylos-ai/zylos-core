// The real server imports the real receive function. Only its notice deadline
// is shortened; record the actual post-commit error before Dashboard projects it.
import fs from 'node:fs';
import { mock } from 'node:test';
import * as notice from '../../../comm-bridge/scripts/status-notice.js';
import * as db from '../../../comm-bridge/scripts/c4-db.js';
import { VersionChecker } from '../../src/lib/version-checker.js';

mock.method(VersionChecker.prototype, 'start', () => {});
db.ensureChannelNamespace('dashboard');
db.close();
mock.module(new URL('../../../comm-bridge/scripts/status-notice.js', import.meta.url).href, {
  namedExports: { ...notice,
    sendStatusNotice: (claim, message, route) => notice.sendStatusNotice(claim, message, route, { timeoutMs: 1200 }),
  },
});
const receiver = await import('../../../comm-bridge/scripts/c4-receive.js');
mock.module(new URL('../../../comm-bridge/scripts/c4-receive.js', import.meta.url).href, {
  namedExports: { ...receiver, receive: async args => {
    try { return await receiver.receive(args); }
    catch (error) {
      fs.writeFileSync(process.env.CHAT_RECEIVE_ERROR, JSON.stringify({
        code: error.code, persisted: error.persisted, id: error.id,
      }));
      throw error;
    }
  } },
});
