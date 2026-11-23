import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SKILLS_DIR } from '../c4-config.js';
import { receive } from '../c4-receive.js';

// Exercise the production receiver with fake route/database/diagnostic
// boundaries. There is no service, sender, socket or database opened here.
function fixture(t) {
  const channelDir = path.join(SKILLS_DIR, 'telegram');
  assert.ok(channelDir.startsWith(process.env.ZYLOS_DIR + path.sep));
  assert.ok(!fs.existsSync(channelDir));
  fs.mkdirSync(channelDir, { recursive: true });
  t.after(() => fs.rmdirSync(channelDir));
  const f = { clock: 1_800_000_000_987, events: [], inserted: 0, clocks: 0 };
  f.dependencies = {
    now: () => { f.clocks++; return f.clock; },
    db: {
      getChannelNamespace: () => ({ namespace: 'telegram' }),
      getSessionHost: () => null,
      insertConversation: (direction, channel, endpoint, content, options) => {
        f.inserted++;
        assert.equal(direction, 'in');
        assert.equal(options.status, 'pending');
        return { id: 42, direction, channel, endpoint_id: endpoint,
          session_group: 'telegram:queue', content, status: options.status };
      },
    },
    queryRoute: async request => {
      f.request = request;
      f.clock += 1234;
      return { decision: 'pending', runtime: 'claude' };
    },
    appendEntryEvent: async event => { f.events.push(event); return true; },
    reserveStatusNotice: () => assert.fail('queued receive must not reserve a status notice'),
    sendStatusNotice: () => assert.fail('queued receive must not send a status notice'),
  };
  return f;
}

test('unreadable mode keeps inbound on the route-query persistence path', async t => {
  const f = fixture(t); f.dependencies.readSessionMode = () => { throw Error('config unreadable'); };
  const result = await receive(['--channel', 'telegram', '--endpoint', 'chat-1', '--content', 'queued'], f.dependencies);
  assert.equal(result.action, 'queued'); assert.equal(f.inserted, 1);
});
