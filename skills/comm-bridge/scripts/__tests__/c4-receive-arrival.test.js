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

for (const noReply of [false, true]) {
  test(`receive diagnostic preserves millisecond arrival through routing with no-reply ${noReply}`, async t => {
    const f = fixture(t), arrival = f.clock;
    const result = await receive(['--channel', 'telegram', '--endpoint', 'chat-1',
      '--content', 'queued message', ...(noReply ? ['--no-reply'] : [])], f.dependencies);
    assert.equal(result.action, 'queued');
    assert.equal(f.inserted, 1);
    assert.equal(f.clocks, 1);
    assert.equal(f.request.receivedAt, arrival);
    assert.equal(f.events.length, 1);
    const event = f.events[0];
    assert.equal(event.event, 'message_received');
    assert.equal(event.conversation_id, 42);
    assert.equal(event.received_at_ms, arrival);
    assert.equal(event.received_at_ms % 1000, 987);
    assert.equal(event.channel, 'telegram');
    assert.equal(event.endpoint, noReply ? '' : 'chat-1');
    assert.equal(event.session_group, 'telegram:queue');
    assert.equal(event.reason_code, 'pending');
    assert.equal(event.runtime, 'claude');
    assert.equal(Object.hasOwn(event, 'content'), false);
  });
}

test('arrival diagnostic failure cannot change a committed queued receive', async t => {
  const f = fixture(t);
  f.dependencies.appendEntryEvent = async () => { throw Error('diagnostic unavailable'); };
  const result = await receive(['--channel', 'telegram', '--endpoint', 'chat-1', '--content', 'queued'], f.dependencies);
  assert.equal(result.action, 'queued');
  assert.equal(result.id, 42);
  assert.equal(f.inserted, 1);
});

test('arrival evidence is not reported as committed when inserting the message fails', async t => {
  const f = fixture(t);
  f.dependencies.db.insertConversation = () => { throw Error('database unavailable'); };
  await assert.rejects(receive(['--channel', 'telegram', '--endpoint', 'chat-1', '--content', 'queued'], f.dependencies),
    { code: 'INTERNAL_ERROR' });
  assert.equal(f.events.length, 0);
});
