import test from 'node:test';
import assert from 'node:assert/strict';
import { runConversationPollBrowser } from './helpers/conversation-poll-browser.js';

// Real Chrome DOM/controller/fetch against a bounded loopback API fixture.
// Run for conversation polling/sending changes; unrelated UI can skip. Requires
// explicit integration gate and installed browser; never starts agent/PM2/tmux.
// Runner-isolated HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR and private socket/DB
// targets are read back before use; HTTP/browser/profile teardown is owned here.
test('slow first send keeps delivery status and replies updating without manual refresh in a browser', {
  skip: process.env.ZYLOS_CHAT_INTEGRATION !== '1' || !process.env.ZYLOS_CHAT_BROWSER_BIN,
  timeout: 60000,
}, async t => {
  const result = await runConversationPollBrowser(t);
  assert.equal(result.sendCount, 1, 'only the user send is posted');
  assert.ok(result.sendDurationMs >= 3000, 'the first send really waits three seconds');
  assert.ok(result.afterReads >= 2, 'automatic history reads continue after send');
  assert.ok(result.statusReads >= 1, 'pending delivery is automatically reconciled');
  assert.equal(result.delivered, true, 'the real message DOM shows authoritative delivered state');
  assert.equal(result.reply, true, 'the real message DOM shows the later AI reply');
  assert.equal(result.manualRefreshClicks, 0);
  assert.equal(result.browserErrors.length, 0);
  assert.equal(result.externalRequests.length, 0);
});
