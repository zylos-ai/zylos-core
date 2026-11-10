import nodeTest from 'node:test';
const test = (name, fn) => nodeTest(name, { timeout: 2000 }, fn);
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { CONTENT_PREFIX } from '../../comm-bridge/scripts/c4-content-schema.js';
import { savedAnswerCases } from './fixtures/saved-answers.js';
const schemaPath = new URL('../public/chat-schema.js', import.meta.url).pathname;
const sourceSchema = new URL('../../comm-bridge/scripts/c4-content-schema.js', import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL && new URL(specifier, context.parentURL).pathname === schemaPath) return next(sourceSchema, context);
    return next(specifier, context);
  }
});
const {
  createConversationState
} = await import('../public/js/wb/conversation-state.js');
// Pure controller only: runner-owned paths, fake clock and request functions; no DB/HTTP/PM2/tmux.
for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) assert.ok(path.isAbsolute(process.env[key]), `${key} must be absolute`);
const runnerRoot = path.dirname(process.env.HOME);
assert.match(path.basename(runnerRoot), /^zylos-tests-/);
assert.equal(process.env.ZYLOS_DIR, path.join(process.env.HOME, 'zylos'));
assert.equal(process.env.PM2_HOME, path.join(process.env.HOME, '.pm2'));
assert.equal(process.env.TMPDIR, path.join(runnerRoot, 'tmp'));
console.info('conversation controller isolation', JSON.stringify(Object.fromEntries(['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR'].map(k => [k, process.env[k]]))), 'DB/HTTP/PM2/tmux unused');
const flush = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return {
    promise,
    resolve,
    reject
  };
};
function clock() {
  let time = 1000,
    id = 0;
  const tasks = new Map();
  return {
    now: () => time,
    setTimeout(fn, ms) {
      const token = ++id;
      tasks.set(token, {
        fn,
        at: time + ms
      });
      return token;
    },
    clearTimeout(token) {
      tasks.delete(token);
    },
    async advance(ms) {
      assert.ok(Number.isFinite(ms) && ms >= 0, 'clock advance must be finite and nonnegative');
      const target = time + ms;
      let steps = 0;
      for (;;) {
        const next = [...tasks].filter(([, v]) => v.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        assert.ok(++steps <= 1000, 'clock advance exceeded 1000 timer callbacks');
        time = next[1].at;
        tasks.delete(next[0]);
        next[1].fn();
        await flush();
      }
      time = target;
      await flush();
    },
    count: () => tasks.size
  };
}
function fixture(extra = () => undefined, t = key => key) {
  const calls = [],
    timer = clock(),
    listeners = new Set();
  let name = 'local';
  const document = {
    hidden: false,
    visibilityState: 'visible',
    addEventListener(type, fn) {
      listeners.add(fn);
    },
    removeEventListener(type, fn) {
      listeners.delete(fn);
    }
  };
  const state = createConversationState({
    document,
    t,
    identity: () => name,
    ...timer,
    request: async (p, options) => {
      const u = new URL(p, 'http://fixture');
      assert.ok(calls.length < 500, 'controller request log exceeded 500 calls');
      calls.push({
        path: p,
        options,
        time: timer.now()
      });
      const value = extra(u, options);
      if (value !== undefined) return value;
      if (p === '/api/session-mode') return {
        data: {
          sessionMode: 'multi'
        }
      };
      if (u.pathname === '/api/chat/conversations') return {
        items: [{
          id: 'g:A',
          stamp: 1
        }, {
          id: 'g:B',
          stamp: 0
        }],
        nextCursor: null
      };
      if (u.pathname.endsWith('/messages')) return {
        items: u.searchParams.get('direction') === 'before' ? [{
          id: 10,
          direction: 'out',
          status: 'delivered',
          content: 'before'
        }] : [],
        nextCursor: null,
        afterCursor: 'after10'
      };
      if (u.pathname.endsWith('/questions')) return {
        items: [],
        nextCursor: null
      };
      if (u.pathname.endsWith('/status')) return {
        items: []
      };
      const id = decodeURIComponent(u.pathname.split('/').at(-1));
      return {
        conversation: {
          id,
          state: 'active'
        },
        conversationId: id,
        stored: false
      };
    }
  });
  return {
    state,
    calls,
    timer,
    document,
    setIdentity: v => name = v,
    async visible(v) {
      document.hidden = !v;
      document.visibilityState = v ? 'visible' : 'hidden';
      for (const fn of listeners) fn();
      await flush();
    },
    reads: () => calls.filter(c => c.path.includes('/messages?') && c.path.includes('direction=after'))
  };
}
async function selected(extra) {
  const f = fixture(extra);
  await f.state.open();
  await f.state.select('g:A');
  return f;
}
test('visible polling waits five seconds and leaves quiet controls loaded', async () => {
  const f = await selected();
  await f.timer.advance(4999);
  assert.equal(f.reads().length, 0);
  await f.timer.advance(1);
  assert.equal(f.reads().length, 1);
  assert.equal(f.state.snapshot().loading, false);
  assert.equal(f.state.snapshot().updateError, null);
  f.state.destroy();
  assert.equal(f.timer.count(), 0);
});
test('hidden page pauses and foreground catches up immediately', async () => {
  const f = await selected();
  await f.visible(false);
  await f.timer.advance(60000);
  assert.equal(f.reads().length, 0);
  await f.visible(true);
  assert.equal(f.reads().length, 1);
  f.state.destroy();
});
test('close and destroy cancel timers; stale responses cannot restore content after identity changes', async () => {
  const wait = deferred();
  const f = await selected(u => u.pathname.endsWith('/messages') && u.searchParams.get('direction') === 'after' ? wait.promise : undefined);
  await f.timer.advance(5000);
  f.state.close();
  f.setIdentity('remote');
  await f.state.open();
  wait.resolve({
    items: [{
      id: 99,
      content: 'old secret'
    }],
    afterCursor: 'stale'
  });
  await flush();
  assert.equal(f.state.snapshot().selectedId, null);
  assert.equal(f.state.snapshot().messages.length, 0);
  await f.timer.advance(5000);
  assert.equal(f.state.snapshot().messages.length, 0);
  f.state.destroy();
});
test('in-flight polling does not overlap and is resumed after completion', async () => {
  const wait = deferred();
  let polls = 0;
  const f = await selected(u => u.pathname.endsWith('/messages') && u.searchParams.get('direction') === 'after' ? ++polls === 1 ? wait.promise : {
    items: [],
    afterCursor: 'a'
  } : undefined);
  await f.timer.advance(5000);
  await f.timer.advance(20000);
  assert.equal(polls, 1);
  wait.resolve({
    items: [],
    afterCursor: 'a'
  });
  await flush();
  await f.timer.advance(5000);
  assert.equal(polls, 2);
  f.state.destroy();
});
test('drafts never poll message history', async () => {
  const f = fixture();
  await f.state.open();
  await f.state.select('d:empty');
  await f.timer.advance(90000);
  assert.equal(f.calls.filter(c => c.path.includes('/messages?')).length, 0);
  f.state.destroy();
});
test('send accelerates to two seconds and first new outbound restores the usual interval', async () => {
  let count = 0;
  const f = await selected((u, o) => u.pathname.endsWith('/send') ? {
    stored: true,
    conversationId: 'g:A',
    deliveryState: 'pending'
  } : u.pathname.endsWith('/messages') && u.searchParams.get('direction') === 'after' ? {
    items: ++count === 2 ? [{
      id: 11,
      direction: 'out',
      status: 'delivered',
      content: 'reply'
    }] : [],
    afterCursor: 'a'
  } : undefined);
  f.state.setInput('hello');
  await f.state.send();
  const before = f.reads().length;
  await f.timer.advance(1999);
  assert.equal(f.reads().length, before);
  await f.timer.advance(1);
  assert.equal(f.reads().length, before + 1);
  await f.timer.advance(4999);
  assert.equal(f.reads().length, before + 1);
  await f.timer.advance(1);
  assert.equal(f.reads().length, before + 2);
  f.state.destroy();
});
test('accelerated reads expire after two minutes even without an outbound reply', async () => {
  const f = await selected(u => u.pathname.endsWith('/send') ? {
    stored: true,
    conversationId: 'g:A'
  } : undefined);
  f.state.setInput('hello');
  await f.state.send();
  await f.timer.advance(120000);
  const n = f.reads().length;
  await f.timer.advance(4999);
  assert.equal(f.reads().length, n);
  await f.timer.advance(1);
  assert.equal(f.reads().length, n + 1);
  f.state.destroy();
});
test('automatic read failure keeps rows and uses bounded exponential backoff without alert error', async () => {
  let fail = true;
  const f = await selected(u => u.pathname.endsWith('/messages') && u.searchParams.get('direction') === 'after' ? fail ? Promise.reject({
    code: 'temporary'
  }) : {
    items: [],
    afterCursor: 'a'
  } : undefined);
  await f.timer.advance(5000);
  assert.equal(f.state.snapshot().error, null);
  assert.equal(f.state.snapshot().updateError, 'temporary');
  assert.equal(f.state.snapshot().messages[0].id, 10);
  for (const wait of [5000, 10000, 20000, 40000, 60000, 60000]) {
    const n = f.reads().length;
    await f.timer.advance(wait - 1);
    assert.equal(f.reads().length, n);
    await f.timer.advance(1);
    assert.equal(f.reads().length, n + 1);
  }
  fail = false;
  await f.timer.advance(60000);
  assert.equal(f.state.snapshot().updateError, null);
  const n = f.reads().length;
  await f.timer.advance(5000);
  assert.equal(f.reads().length, n + 1);
  f.state.destroy();
});
test('list refresh merges the first page without discarding later pages or their cursor', async () => {
  let lists = 0;
  const f = fixture(u => u.pathname === '/api/chat/conversations' ? u.searchParams.get('cursor') ? {
    items: [{
      id: 'g:C',
      stamp: 0
    }],
    nextCursor: 'deep'
  } : ++lists === 1 ? {
    items: [{
      id: 'g:A',
      stamp: 1
    }],
    nextCursor: 'second'
  } : {
    items: [{
      id: 'g:A',
      stamp: 3
    }, {
      id: 'g:B',
      stamp: 2
    }],
    nextCursor: 'new-second'
  } : undefined);
  await f.state.open();
  await f.state.loadMore();
  await f.timer.advance(30000);
  assert.equal(f.state.snapshot().items.length, 3);
  assert.equal(f.state.snapshot().nextCursor, 'deep');
  assert.equal(f.state.snapshot().loading, false);
  f.state.destroy();
});
test('new rows merge and update only current preview while question state refresh preserves forms and all loaded pages', async () => {
  let refreshed = false;
  const q1 = {
      interruptId: 'one',
      c4Id: 10,
      status: 'paused'
    },
    q2 = {
      interruptId: 'two',
      c4Id: 9,
      status: 'paused'
    };
  const f = await selected(u => u.pathname.endsWith('/questions') ? {
    items: u.searchParams.get('cursor') ? [{
      ...q2,
      status: refreshed ? 'stopped' : 'paused'
    }] : [q1],
    nextCursor: u.searchParams.get('cursor') ? null : 'q2'
  } : u.pathname.endsWith('/messages') && u.searchParams.get('direction') === 'after' ? {
    items: [{
      id: 11,
      direction: 'out',
      status: 'delivered',
      content: 'readable new text',
      timestamp: '2026-11-08T00:00:00Z'
    }],
    afterCursor: 'a'
  } : undefined);
  await f.state.loadMoreQuestions();
  const forms = f.state.snapshot().questionForms;
  forms.set('10:one', {
    text: 'keep typed value'
  });
  const before = f.calls.filter(c => c.path.includes('/questions?')).length;
  refreshed = true;
  await f.timer.advance(5000);
  assert.equal(f.calls.filter(c => c.path.includes('/questions?')).length, before + 2);
  assert.equal(f.state.snapshot().questions.length, 2);
  assert.equal(forms.get('10:one').text, 'keep typed value');
  assert.equal(f.state.snapshot().questions.find(q => q.interruptId === 'two').status, 'stopped');
  assert.equal(f.state.snapshot().items[0].preview, 'readable new text');
  await f.timer.advance(5000);
  assert.equal(f.state.snapshot().messages.length, 2);
  f.state.destroy();
});
test('polling without new rows does not reconcile questions and queries only unresolved inbound statuses', async () => {
  const rows = [{
    id: 1,
    direction: 'in',
    status: 'pending'
  }, {
    id: 2,
    direction: 'in',
    status: 'delivered'
  }, {
    id: 3,
    direction: 'out',
    status: 'delivered'
  }];
  const f = await selected(u => u.pathname.endsWith('/messages') && u.searchParams.get('direction') === 'before' ? {
    items: rows,
    afterCursor: 'a'
  } : u.pathname.endsWith('/status') ? {
    items: [{
      id: 1,
      direction: 'in',
      status: 'delivered'
    }]
  } : undefined);
  const questions = f.calls.filter(c => c.path.includes('/questions?')).length;
  await f.timer.advance(5000);
  const statuses = f.calls.filter(c => c.path.includes('/status?'));
  assert.equal(statuses.length, 1);
  assert.match(statuses[0].path, /ids=1(?:&|$)/);
  await f.timer.advance(5000);
  assert.equal(f.calls.filter(c => c.path.includes('/status?')).length, 1);
  assert.equal(f.calls.filter(c => c.path.includes('/questions?')).length, questions);
  f.state.destroy();
});
test('remote closure clears lists and cached drafts before a fresh selection', async () => {
  let disabled = true;
  const f = await selected(u => u.pathname.endsWith('/messages') && u.searchParams.get('direction') === 'after' && disabled ? Promise.reject({
    code: 'remote_chat_disabled'
  }) : undefined);
  f.state.setInput('private cached draft');
  const previousForms = f.state.snapshot().questionForms;
  previousForms.set('10:private', {
    input: 'private answer'
  });
  assert.ok(f.state.snapshot().items.length > 0);
  await f.timer.advance(5000);
  assert.equal(f.state.snapshot().blocked, true);
  assert.equal(f.state.snapshot().items.length, 0);
  assert.equal(f.state.snapshot().nextCursor, null);
  assert.equal(f.state.snapshot().selectedId, null);
  assert.equal(f.state.snapshot().messages.length, 0);
  const n = f.calls.length;
  await f.timer.advance(90000);
  assert.equal(f.calls.length, n);
  disabled = false;
  await f.state.refresh();
  await f.state.select('g:A');
  assert.equal(f.state.snapshot().input, '');
  assert.notEqual(f.state.snapshot().questionForms, previousForms);
  assert.equal(f.state.snapshot().questionForms.size, 0);
  f.state.destroy();
});
test('external pending inbound history polls but never queries questions or delivery status', async () => {
  const f = fixture(u => u.pathname.endsWith('/messages') && u.searchParams.get('direction') === 'before' ? {
    items: [{
      id: 10,
      direction: 'in',
      status: 'pending'
    }],
    afterCursor: 'after10',
    nextCursor: null
  } : undefined);
  await f.state.open();
  await f.state.setTab('external');
  await f.state.select('g:outside');
  assert.equal(f.state.snapshot().messages[0].status, 'pending');
  const n = f.calls.length;
  await f.timer.advance(5000);
  assert.ok(f.calls.slice(n).some(c => c.path.includes('direction=after')));
  assert.ok(f.calls.every(c => !c.path.includes('/questions?') && !c.path.includes('/status?')));
  assert.equal(f.state.snapshot().canWrite, false);
  f.state.destroy();
});
test('cursor restart preserves shown rows, exposes a gap, and fills it by before pages with deduplication', async () => {
  let initial = true;
  const f = await selected(u => {
    if (!u.pathname.endsWith('/messages')) return;
    const direction = u.searchParams.get('direction'),
      cursor = u.searchParams.get('cursor');
    if (direction === 'after') throw {
      code: 'invalid_chat_cursor'
    };
    if (!cursor) {
      if (initial) {
        initial = false;
        return {
          items: [{
            id: 10,
            direction: 'out',
            content: 'old'
          }],
          afterCursor: 'expired'
        };
      }
      return {
        items: [{
          id: 30,
          direction: 'out',
          content: 'new'
        }],
        afterCursor: 'fresh',
        nextCursor: 'b30'
      };
    }
    if (cursor === 'b30') return {
      items: [{
        id: 20,
        direction: 'out',
        content: 'middle'
      }],
      nextCursor: 'b20'
    };
    if (cursor === 'b20') return {
      items: [{
        id: 10,
        direction: 'out',
        content: 'old'
      }, {
        id: 15,
        direction: 'out',
        content: 'between'
      }],
      nextCursor: 'b10'
    };
  });
  await f.timer.advance(5000);
  assert.deepEqual(f.state.snapshot().messages.map(r => r.id), [10, 30]);
  assert.equal(f.state.snapshot().gap.afterId, 10);
  await f.state.loadGap();
  assert.equal(f.state.snapshot().gap, null);
  assert.deepEqual(f.state.snapshot().messages.map(r => r.id), [10, 15, 20, 30]);
  f.state.destroy();
});
test('load older follows a renewed chain through already shown pages until genuinely older rows arrive', async () => {
  let first = true,
    expired = true;
  const f = await selected(u => {
    if (!u.pathname.endsWith('/messages')) return;
    const cursor = u.searchParams.get('cursor');
    if (u.searchParams.get('direction') === 'after' && expired) {
      expired = false;
      throw {
        code: 'invalid_chat_cursor'
      };
    }
    if (u.searchParams.get('direction') === 'after') return {
      items: [],
      afterCursor: 'a'
    };
    if (!cursor) {
      if (first) {
        first = false;
        return {
          items: [{
            id: 10
          }],
          afterCursor: 'expired',
          nextCursor: 'old'
        };
      }
      return {
        items: [{
          id: 30
        }],
        afterCursor: 'a',
        nextCursor: 'fresh30'
      };
    }
    if (cursor === 'fresh30') return {
      items: [{
        id: 20
      }],
      nextCursor: 'fresh20'
    };
    if (cursor === 'fresh20') return {
      items: [{
        id: 10
      }],
      nextCursor: 'fresh10'
    };
    if (cursor === 'fresh10') return {
      items: [{
        id: 1
      }],
      nextCursor: null
    };
  });
  await f.timer.advance(5000);
  await f.state.loadOlder();
  assert.deepEqual(f.state.snapshot().messages.map(r => r.id), [1, 10, 20, 30]);
  assert.equal(f.state.snapshot().messageCursor, null);
  f.state.destroy();
});
test('unknown send retains input and rejects an automatic duplicate attempt', async () => {
  let sends = 0;
  const f = await selected(u => u.pathname.endsWith('/send') ? (sends++, {
    stored: null,
    retryAllowed: false,
    preserveInput: true
  }) : undefined);
  f.state.setInput('keep');
  await f.state.send();
  await f.state.send();
  assert.equal(sends, 1);
  assert.equal(f.state.snapshot().input, 'keep');
  assert.equal(f.state.snapshot().retryRequired, true);
  f.state.destroy();
});
test('new question rows received during send refresh their authoritative state immediately', async () => {
  let sent = false,
    questionReads = 0;
  const f = await selected(u => {
    if (u.pathname.endsWith('/send')) {
      sent = true;
      return {
        stored: true,
        conversationId: 'g:A'
      };
    }
    if (u.pathname.endsWith('/questions')) {
      questionReads++;
      return {
        items: sent ? [{
          interruptId: 'new-question',
          c4Id: 11,
          status: 'paused'
        }] : [],
        nextCursor: null
      };
    }
    if (u.pathname.endsWith('/messages') && u.searchParams.get('direction') === 'after') return {
      items: sent ? [{
        id: 11,
        direction: 'out',
        status: 'delivered',
        content: 'question'
      }] : [],
      afterCursor: 'a11'
    };
  });
  const before = questionReads;
  f.state.setInput('ask');
  await f.state.send();
  assert.equal(questionReads, before + 1);
  assert.equal(f.state.snapshot().questions[0].interruptId, 'new-question');
  f.state.destroy();
});
test('SQL UTC timestamps retain the correct list ordering independently of the browser timezone', async () => {
  const previous = process.env.TZ;
  process.env.TZ = 'Asia/Shanghai';
  try {
    const f = await selected(u => u.pathname === '/api/chat/conversations' ? {
      items: [{
        id: 'g:B',
        stamp: 2461253
      }, {
        id: 'g:A',
        stamp: 1
      }],
      nextCursor: null
    } : u.pathname.endsWith('/messages') && u.searchParams.get('direction') === 'after' ? {
      items: [{
        id: 11,
        direction: 'out',
        content: 'new',
        timestamp: '2026-11-08 12:00:00'
      }],
      afterCursor: 'a'
    } : undefined);
    await f.timer.advance(5000);
    const row = f.state.snapshot().items.find(r => r.id === 'g:A');
    assert.equal(row.stamp, Date.parse('2026-11-08T12:00:00Z') / 86400000 + 2440587.5);
    assert.equal(f.state.snapshot().items[0].id, 'g:A');
    f.state.destroy();
  } finally {
    if (previous === undefined) delete process.env.TZ;else process.env.TZ = previous;
  }
});
test('gap backfill rejects a repeating cursor instead of looping indefinitely', async () => {
  let first = true;
  const f = await selected(u => {
    if (!u.pathname.endsWith('/messages')) return;
    if (u.searchParams.get('direction') === 'after') throw {
      code: 'invalid_chat_cursor'
    };
    const cursor = u.searchParams.get('cursor');
    if (!cursor) {
      if (first) {
        first = false;
        return {
          items: [{
            id: 10
          }],
          afterCursor: 'old'
        };
      }
      return {
        items: [{
          id: 30
        }],
        afterCursor: 'new',
        nextCursor: 'same'
      };
    }
    return {
      items: [{
        id: 20
      }],
      nextCursor: 'same'
    };
  });
  await f.timer.advance(5000);
  const n = f.calls.length;
  await f.state.loadGap();
  assert.equal(f.calls.length, n + 1);
  assert.equal(f.state.snapshot().error, 'chat_invalid_response');
  f.state.destroy();
});
test('navigating away stops a gap chain before requesting another page', async () => {
  let first = true;
  const wait = deferred();
  const f = await selected(u => {
    if (!u.pathname.includes('g%3AA/messages')) return;
    if (u.searchParams.get('direction') === 'after') throw {
      code: 'invalid_chat_cursor'
    };
    if (!u.searchParams.get('cursor')) {
      if (first) {
        first = false;
        return {
          items: [{
            id: 10
          }],
          afterCursor: 'old'
        };
      }
      return {
        items: [{
          id: 30
        }],
        afterCursor: 'new',
        nextCursor: 'b30'
      };
    }
    return wait.promise;
  });
  await f.timer.advance(5000);
  const backfill = f.state.loadGap();
  await f.state.select('g:B');
  const n = f.calls.length;
  wait.resolve({
    items: [{
      id: 20
    }],
    nextCursor: 'b20'
  });
  await backfill;
  assert.equal(f.calls.length, n);
  assert.equal(f.state.snapshot().selectedId, 'g:B');
  f.state.destroy();
});
test('accepted question answers accelerate reading while preserving their stable action receipt', async () => {
  const action = {
    id: 'stable-answer',
    payload: {
      selected: ['a']
    }
  };
  const f = await selected(u => u.pathname.endsWith('/questions') ? {
    items: [{
      interruptId: 'one',
      c4Id: 10,
      status: 'paused'
    }],
    nextCursor: null
  } : u.pathname.endsWith('/answers') ? {
    answer: {
      answerId: action.id
    },
    delivery: {
      stored: true,
      deliveryState: 'pending'
    }
  } : undefined);
  f.state.snapshot().questionForms.set('10:one', {});
  await f.state.answer('one', action, {
    conversationId: 'g:A',
    questionC4Id: 10
  });
  assert.equal(f.state.snapshot().questionForms.get('10:one').action.id, action.id);
  const before = f.reads().length;
  await f.timer.advance(1999);
  assert.equal(f.reads().length, before);
  await f.timer.advance(1);
  assert.equal(f.reads().length, before + 1);
  f.state.destroy();
});
test('refreshing loaded question pages follows the new first-page cursor after insertions', async () => {
  let inserted = false;
  const q = id => ({
    interruptId: id,
    c4Id: id === 'new-between' ? 11 : 10,
    status: 'paused'
  });
  const f = await selected(u => {
    if (u.pathname.endsWith('/questions')) {
      const cursor = u.searchParams.get('cursor');
      if (!cursor) return {
        items: [q('first')],
        nextCursor: inserted ? 'fresh-boundary' : 'old-boundary'
      };
      if (cursor === 'fresh-boundary') return {
        items: [q('new-between')],
        nextCursor: 'fresh-third'
      };
      return {
        items: [q('old-later')],
        nextCursor: null
      };
    }
    if (u.pathname.endsWith('/messages') && u.searchParams.get('direction') === 'after') return {
      items: [{
        id: 11,
        direction: 'out',
        status: 'delivered',
        content: 'new question'
      }],
      afterCursor: 'a11'
    };
  });
  await f.state.loadMoreQuestions();
  f.state.snapshot().questionForms.set('10:first', {
    input: 'preserve'
  });
  const before = f.calls.length;
  inserted = true;
  await f.timer.advance(5000);
  const refreshed = f.calls.slice(before).filter(c => c.path.includes('/questions?'));
  assert.equal(refreshed.length, 2);
  assert.match(refreshed[1].path, /cursor=fresh-boundary/);
  assert.ok(f.state.snapshot().questions.some(q => q.interruptId === 'new-between'));
  assert.ok(f.state.snapshot().questions.some(q => q.interruptId === 'old-later'));
  assert.equal(f.state.snapshot().questionForms.get('10:first').input, 'preserve');
  assert.equal(f.state.snapshot().questionCursor, 'fresh-third');
  f.state.destroy();
});
test('question refresh stays pending when status reading fails after consuming a new batch', async () => {
  let after = 0,
    statuses = 0,
    questionReads = 0;
  const f = await selected(u => {
    if (u.pathname.endsWith('/messages')) return {
      items: u.searchParams.get('direction') === 'before' ? [{
        id: 10,
        direction: 'in',
        status: 'pending'
      }] : ++after === 1 ? [{
        id: 11,
        direction: 'out',
        status: 'delivered'
      }] : [],
      afterCursor: 'a11'
    };
    if (u.pathname.endsWith('/status')) {
      if (++statuses === 1) throw {
        code: 'status_temporary'
      };
      return {
        items: [{
          id: 10,
          direction: 'in',
          status: 'delivered'
        }]
      };
    }
    if (u.pathname.endsWith('/questions')) return {
      items: [{
        interruptId: 'one',
        c4Id: 10,
        status: ++questionReads === 1 ? 'paused' : 'stopped'
      }],
      nextCursor: null
    };
  });
  f.state.snapshot().questionForms.set('10:one', {
    input: 'keep'
  });
  await f.timer.advance(5000);
  assert.equal(f.state.snapshot().updateError, 'status_temporary');
  assert.equal(f.state.snapshot().pendingQuestionRefresh, true);
  assert.equal(questionReads, 1);
  await f.timer.advance(5000);
  assert.equal(questionReads, 2);
  assert.equal(f.state.snapshot().questions[0].status, 'stopped');
  assert.equal(f.state.snapshot().questionForms.get('10:one').input, 'keep');
  assert.equal(f.state.snapshot().pendingQuestionRefresh, false);
  assert.equal(f.state.snapshot().updateError, null);
  await f.timer.advance(5000);
  assert.equal(questionReads, 2);
  f.state.destroy();
});
test('question refresh retries after its own failure even when the next message page is empty', async () => {
  let after = 0,
    questionReads = 0;
  const f = await selected(u => {
    if (u.pathname.endsWith('/messages') && u.searchParams.get('direction') === 'after') return {
      items: ++after === 1 ? [{
        id: 11,
        direction: 'out',
        status: 'delivered'
      }] : [],
      afterCursor: 'a11'
    };
    if (u.pathname.endsWith('/questions')) {
      if (++questionReads === 2) throw {
        code: 'question_temporary'
      };
      return {
        items: [{
          interruptId: 'one',
          c4Id: 10,
          status: questionReads === 1 ? 'paused' : 'stopped'
        }],
        nextCursor: null
      };
    }
  });
  f.state.snapshot().questionForms.set('10:one', {
    input: 'keep'
  });
  await f.timer.advance(5000);
  assert.equal(f.state.snapshot().pendingQuestionRefresh, true);
  assert.equal(f.state.snapshot().updateError, 'question_temporary');
  await f.timer.advance(5000);
  assert.equal(questionReads, 3);
  assert.equal(f.state.snapshot().questions[0].status, 'stopped');
  assert.equal(f.state.snapshot().questionForms.get('10:one').input, 'keep');
  assert.equal(f.state.snapshot().pendingQuestionRefresh, false);
  assert.equal(f.state.snapshot().updateError, null);
  f.state.destroy();
});
test('loading historical outbound rows preserves two-second reads through empty after pages', async () => {
  const f = await selected(u => {
    if (u.pathname.endsWith('/send')) return {
      stored: true,
      conversationId: 'g:A'
    };
    if (!u.pathname.endsWith('/messages')) return;
    if (u.searchParams.get('direction') === 'after') return {
      items: [],
      afterCursor: 'a10'
    };
    return u.searchParams.get('cursor') ? {
      items: [{
        id: 9,
        direction: 'out',
        status: 'delivered'
      }],
      nextCursor: null
    } : {
      items: [{
        id: 10,
        direction: 'out',
        status: 'delivered'
      }],
      nextCursor: 'older',
      afterCursor: 'a10'
    };
  });
  f.state.setInput('hello');
  await f.state.send();
  await f.state.loadOlder();
  const n = f.reads().length;
  await f.timer.advance(1999);
  assert.equal(f.reads().length, n);
  await f.timer.advance(1);
  assert.equal(f.reads().length, n + 1);
  await f.timer.advance(1999);
  assert.equal(f.reads().length, n + 1);
  await f.timer.advance(1);
  assert.equal(f.reads().length, n + 2);
  f.state.destroy();
});
test('read failure after an authoritative stored send does not relabel that send as unknown', async () => {
  let fail = true;
  const f = await selected(u => {
    if (u.pathname.endsWith('/send')) return {
      stored: true,
      conversationId: 'g:A',
      deliveryState: 'pending'
    };
    if (u.pathname.endsWith('/messages') && u.searchParams.get('direction') === 'after') return {
      items: [{
        id: 11,
        direction: 'in',
        status: 'pending'
      }],
      afterCursor: 'a11'
    };
    if (u.pathname.endsWith('/status') && fail) throw {
      code: 'status_temporary'
    };
  });
  f.state.setInput('stored text');
  await f.state.send();
  assert.equal(f.state.snapshot().receipt.stored, true);
  assert.equal(f.state.snapshot().retryRequired, false);
  assert.equal(f.state.snapshot().input, '');
  assert.equal(f.state.snapshot().updateError, 'status_temporary');
  fail = false;
  await f.timer.advance(5000);
  assert.equal(f.state.snapshot().updateError, null);
  f.state.destroy();
});
test('manual delivery check reconciles an uncertain question answer without needing a new message', async () => {
  let questionReads = 0;
  const f = await selected(u => {
    if (u.pathname.endsWith('/questions')) {
      questionReads++;
      return {
        items: [{
          interruptId: 'one',
          c4Id: 10,
          status: 'paused'
        }],
        nextCursor: null
      };
    }
    if (u.pathname.endsWith('/answers')) throw {
      code: 'network_lost'
    };
  });
  f.state.snapshot().questionForms.set('10:one', {
    input: 'keep editable'
  });
  await f.state.answer('one', {
    id: 'uncertain-answer',
    payload: {
      selected: ['a']
    }
  }, {
    conversationId: 'g:A',
    questionC4Id: 10
  });
  assert.equal(f.state.snapshot().questionForms.get('10:one').locked, true);
  await f.state.refreshStatus();
  assert.equal(questionReads, 2);
  assert.equal(f.state.snapshot().questionForms.get('10:one').locked, false);
  assert.equal(f.state.snapshot().questionForms.get('10:one').input, 'keep editable');
  assert.equal(f.reads().length, 0);
  f.state.destroy();
});
test('incremental list updates use the server human preview rather than attachment storage annotations', async () => {
  const f = await selected(u => u.pathname.endsWith('/messages') && u.searchParams.get('direction') === 'after' ? {
    items: [{
      id: 11,
      direction: 'out',
      content: 'Readable text\n/private/managed/report.pdf',
      preview: 'Readable text\n[文件] report.pdf'
    }],
    afterCursor: 'after11'
  } : undefined);
  await f.timer.advance(5000);
  const preview = f.state.snapshot().items.find(item => item.id === 'g:A').preview;
  assert.equal(preview, 'Readable text\n[文件] report.pdf');
  assert.equal(preview.includes('/private/'), false);
  f.state.destroy();
});
// Pure controller with fake requests/clock; validates the actual frontend preview
// projection from complete saved envelopes, without HTTP/DB/runtime resources.
test('incremental answer previews strip only the exact envelope prefix instead of displaying the server protocol preview', async () => {
  for (const example of savedAnswerCases) {
    const f = await selected(u => u.pathname.endsWith('/messages') && u.searchParams.get('direction') === 'after' ? {
      items: [{ id: 11, direction: 'in', content: CONTENT_PREFIX + JSON.stringify(example.envelope), preview: example.envelope.fallbackText }], afterCursor: 'after11'
    } : undefined);
    await f.timer.advance(5000);
    assert.equal(f.state.snapshot().items.find(item => item.id === 'g:A').preview, example.preview, example.name);
    f.state.destroy();
  }
});
test('conversation read failure immediately after storing a send cannot make delivery uncertain', async () => {
  let sent = false;
  const f = await selected((u, options) => {
    if (u.pathname.endsWith('/send')) {
      sent = true;
      return {
        stored: true,
        conversationId: 'g:A',
        deliveryState: 'pending'
      };
    }
    if (sent && u.pathname === '/api/chat/conversations/g%3AA' && !options?.method) {
      throw {
        code: 'network_lost'
      };
    }
  });
  f.state.setInput('already stored');
  await f.state.send();
  const s = f.state.snapshot();
  assert.equal(s.receipt.stored, true);
  assert.equal(s.receipt.deliveryState, 'pending');
  assert.equal(s.retryRequired, false);
  assert.equal(s.canRetry, false);
  assert.equal(s.input, '');
  assert.equal(s.error, 'network_lost');
  assert.equal(f.calls.filter(c => c.path.endsWith('/send')).length, 1);
  f.state.destroy();
});
test('creating a draft ignores duplicate clicks while the original request is pending', { timeout: 2000 }, async () => {
  const pending = deferred();
  let creates = 0;
  const f = fixture(u => u.pathname === '/api/chat/drafts' ? (creates++, pending.promise) : undefined);
  await f.state.open();
  const first = f.state.createDraft('Named conversation');
  assert.equal(f.state.snapshot().creatingDraft, true);
  void f.state.createDraft('Duplicate');
  assert.equal(creates, 1);
  pending.resolve({
    conversation: {
      id: 'd:new',
      state: 'draft'
    }
  });
  await first;
  assert.equal(f.state.snapshot().creatingDraft, false);
  assert.equal(f.state.snapshot().selectedId, 'd:new');
  f.state.destroy();
});
test('draft creation failure resets the guard so an explicit later attempt can run', async () => {
  let creates = 0;
  const f = fixture(u => {
    if (u.pathname === '/api/chat/drafts') {
      if (++creates === 1) throw {
        code: 'draft_unavailable'
      };
      return {
        conversation: {
          id: 'd:new',
          state: 'draft'
        }
      };
    }
  });
  await f.state.open();
  await f.state.createDraft();
  assert.equal(f.state.snapshot().creatingDraft, false);
  await f.state.createDraft();
  assert.equal(creates, 2);
  assert.equal(f.state.snapshot().selectedId, 'd:new');
  f.state.destroy();
});
test('unparseable incremental previews use the injected locale fallback', async () => {
  const f = fixture(u => u.pathname.endsWith('/messages') && u.searchParams.get('direction') === 'after' ? {
    items: [{
      id: 11,
      direction: 'out',
      content: '[C4-JSON]\n{invalid'
    }],
    afterCursor: 'a11'
  } : undefined, key => key === 'chat.invalidContent' ? 'Localized unavailable message' : key);
  await f.state.open();
  await f.state.select('g:A');
  await f.timer.advance(5000);
  assert.equal(f.state.snapshot().items.find(item => item.id === 'g:A').preview, 'Localized unavailable message');
  f.state.destroy();
});
test('invalid incremental previews preserve qualified fallback as literal text', async () => {
  const fallbackText = '<img onerror="alert(1)"> **literal** [link](https://example.com)';
  const f = fixture(u => u.pathname.endsWith('/messages') && u.searchParams.get('direction') === 'after' ? {
    items: [{ id: 11, direction: 'out', content: '[C4-JSON]\n' + JSON.stringify({ version: 99, fallbackText }) }],
    afterCursor: 'a11'
  } : undefined);
  try {
    await f.state.open();
    await f.state.select('g:A');
    await f.timer.advance(5000);
    assert.equal(f.state.snapshot().items.find(item => item.id === 'g:A').preview, fallbackText);
  } finally { f.state.destroy(); }
});
function groupFixture(readGroup, extra = () => undefined) {
  return fixture((u, options) => {
    const value = extra(u, options);
    if (value !== undefined) return value;
    if (u.pathname === '/api/chat/conversations/g%3AA') return {
      conversation: {
        id: 'g:A',
        sessionGroup: 'dashboard:a',
        state: 'active'
      },
      stored: false
    };
    if (u.pathname === '/api/workbench/groups') return readGroup(options);
  });
}
const groupSnapshot = (presence, extra = {}) => ({
  listKnown: true,
  rows: [{
    sessionGroup: 'dashboard:a',
    presence
  }],
  sources: {
    status: {
      ok: true,
      readAt: 1000
    }
  },
  ...extra
});
for (const health of ['rate_limited', 'recovering']) {
  test(`sending into an empty ${health} queue refreshes wait before the polling interval`, { timeout: 2000 }, async t => {
    let stored = false;
    const wait = { kind: 'rate_wait', runtime: 'claude' };
    const f = groupFixture(() => groupSnapshot('running', {
      rows: [{ sessionGroup: 'dashboard:a', presence: 'running', target: { runtime: 'claude' }, wait: stored ? wait : null }],
      instance: { runtimeHealth: { claude: { health } } }
    }), u => {
      if (u.pathname.endsWith('/send')) { stored = true; return { stored: true, conversationId: 'g:A' }; }
    });
    t.after(() => f.state.destroy());
    await f.state.open(); await f.state.select('g:A');
    assert.equal(f.state.snapshot().groupWait, null);
    const before = f.timer.now();
    f.state.setInput('new message'); await f.state.send(); await flush();
    assert.equal(f.state.snapshot().receipt.stored, true);
    assert.equal(f.state.snapshot().groupWait, wait);
    assert.equal(f.timer.now(), before, 'no poll or timeout was needed');
    assert.equal(f.calls.filter(call => call.path === '/api/workbench/groups').length, 2);
  });
}
test('a stored message replaces an older pending group read', { timeout: 2000 }, async t => {
  const pending = deferred();
  const wait = { kind: 'rate_wait', runtime: 'claude' };
  let reads = 0;
  const response = wait => groupSnapshot('running', {
    rows: [{ sessionGroup: 'dashboard:a', presence: 'running', target: { runtime: 'claude' }, wait }],
    instance: { runtimeHealth: { claude: { health: 'rate_limited' } } }
  });
  const f = groupFixture(() => ++reads === 1 ? pending.promise : response(wait), u =>
    u.pathname.endsWith('/send') ? { stored: true, conversationId: 'g:A' } : undefined);
  t.after(() => f.state.destroy());
  await f.state.open(); await f.state.select('g:A');
  const oldRead = f.calls.find(call => call.path === '/api/workbench/groups');
  f.state.setInput('new message'); await f.state.send(); await flush();
  assert.equal(reads, 2);
  assert.equal(oldRead.options.signal.aborted, true);
  assert.equal(f.state.snapshot().groupWait, wait);
  pending.resolve(response(null)); await flush();
  assert.equal(f.state.snapshot().groupWait, wait, 'pre-storage results cannot erase the fresh wait');
});
test('a send completed after navigation preserves the selected group read', { timeout: 2000 }, async t => {
  const send = deferred(), pending = deferred();
  let reads = 0;
  const f = groupFixture(() => ++reads === 1 ? groupSnapshot('running') : pending.promise, u => {
    if (u.pathname.endsWith('/send')) return send.promise;
    if (u.pathname === '/api/chat/conversations/g%3AB') return {
      conversation: { id: 'g:B', sessionGroup: 'dashboard:b', state: 'active' }, stored: false
    };
  });
  t.after(() => f.state.destroy());
  await f.state.open(); await f.state.select('g:A');
  f.state.setInput('new message'); const sending = f.state.send();
  await f.state.select('g:B');
  const selectedRead = f.calls.filter(call => call.path === '/api/workbench/groups').at(-1);
  send.resolve({ stored: true, conversationId: 'g:A' }); await sending; await flush();
  assert.equal(reads, 2);
  assert.equal(selectedRead.options.signal.aborted, false);
  assert.equal(f.state.snapshot().selectedId, 'g:B');
  pending.resolve(groupSnapshot('running', {
    rows: [{ sessionGroup: 'dashboard:b', presence: 'running', target: { runtime: 'codex' }, wait: null }],
    instance: { runtimeHealth: { codex: { health: 'ok' } } }
  })); await flush();
  assert.equal(f.state.snapshot().groupHealth, 'ok');
});
for (const stored of [false, null]) {
  test(`a send with stored=${stored} does not refresh group status`, { timeout: 2000 }, async t => {
    const f = groupFixture(() => groupSnapshot('running'), u =>
      u.pathname.endsWith('/send') ? { stored, conversationId: 'g:A' } : undefined);
    t.after(() => f.state.destroy());
    await f.state.open(); await f.state.select('g:A');
    f.state.setInput('new message'); await f.state.send(); await flush();
    assert.equal(f.calls.filter(call => call.path === '/api/workbench/groups').length, 1);
  });
}
test('returning to a conversation clears its previous wait before metadata arrives', { timeout: 2000 }, async t => {
  const metadata = deferred(), status = deferred();
  const wait = { kind: 'rate_wait', runtime: 'claude' };
  let returning = false;
  const f = groupFixture(() => returning ? status.promise : groupSnapshot('running', {
    rows: [{ sessionGroup: 'dashboard:a', presence: 'running', target: { runtime: 'claude' }, wait }],
    instance: { runtimeHealth: { claude: { health: 'recovering' } } }
  }), u => returning && u.pathname === '/api/chat/conversations/g%3AA' ? metadata.promise : undefined);
  t.after(() => f.state.destroy());
  await f.state.open(); await f.state.select('g:A');
  assert.equal(f.state.snapshot().groupWait, wait);
  await f.state.select('g:B');
  returning = true;
  const selecting = f.state.select('g:A');
  assert.equal(f.state.snapshot().selectedId, 'g:A');
  assert.equal(f.state.snapshot().groupWait, null, 'cached wait clears synchronously on reentry');
  assert.equal(f.state.snapshot().groupHealth, null);
  metadata.resolve({ conversation: { id: 'g:A', sessionGroup: 'dashboard:a', state: 'active' }, stored: false });
  await selecting;
  assert.equal(f.state.snapshot().groupWait, null, 'wait stays cleared while the replacement read is pending');
  status.resolve(groupSnapshot('running')); await flush();
  assert.equal(f.state.snapshot().groupWait, null);
});
for (const failure of ['unreadable source', 'request failure']) test(`conversation health clears a stale restriction after ${failure}`, { timeout: 2000 }, async t => {
  let readable = true;
  const wait = { kind: 'rate_wait', runtime: 'claude', cooldownUntil: 2000 };
  const f = groupFixture(() => {
    if (!readable && failure === 'request failure') throw { code: 'status_unavailable' };
    return groupSnapshot('running', {
      rows: [{ sessionGroup: 'dashboard:a', presence: 'running', target: { runtime: 'claude' }, wait }],
      instance: { runtimeHealth: { claude: { health: 'rate_limited' }, codex: { health: 'ok' } } },
      sources: { status: { ok: readable, readAt: 1000 } }
    });
  });
  t.after(() => f.state.destroy());
  await f.state.open();
  await f.state.select('g:A');
  assert.equal(f.state.snapshot().groupHealth, 'rate_limited');
  assert.equal(f.state.snapshot().groupWait, wait);
  readable = false;
  await f.timer.advance(30000);
  assert.equal(f.state.snapshot().groupHealth, null);
  assert.equal(f.state.snapshot().groupWait, null);
  assert.equal(f.state.snapshot().groupPresence, null);
  assert.equal(f.state.snapshot().groupPresenceReadAt, null);
});

for (const runtime of ['claude', 'codex']) {
  for (const [health, wait] of [
    ['rate_limited', null], ['ok', { kind: 'rate_wait', runtime }],
    ['recovering', { kind: 'rate_wait', runtime, cooldownUntil: 2000 }],
    ['auth_failed', { kind: 'auth_wait', runtime }], ['unavailable', { kind: 'unknown', health: 'unavailable', reason: 'no_rule' }]
  ]) {
    test(`conversation state preserves server wait for ${runtime} ${health}`, { timeout: 2000 }, async t => {
      const f = groupFixture(() => groupSnapshot('running', {
        rows: [{ sessionGroup: 'dashboard:other', presence: 'running', target: { runtime: 'other' }, wait: { kind: 'rate_wait' } },
          { sessionGroup: 'dashboard:a', presence: 'running', target: { runtime }, wait }],
        instance: { runtimeHealth: { claude: { health: 'auth_failed' }, codex: { health: 'down' }, [runtime]: { health } } }
      }));
      t.after(() => f.state.destroy());
      await f.state.open(); await f.state.select('g:A');
      assert.equal(f.state.snapshot().groupHealth, health);
      assert.equal(f.state.snapshot().groupWait, wait, 'the matching row wait remains the server authority');
    });
  }
  test(`conversation state preserves server health for a missing ${runtime} file without borrowing another runtime`, { timeout: 2000 }, async t => {
    const f = groupFixture(() => groupSnapshot('running', {
      rows: [{ sessionGroup: 'dashboard:a', presence: 'running', target: { runtime }, wait: null }],
      instance: { runtimeHealth: { claude: { health: 'rate_limited' }, codex: { health: 'auth_failed' },
        [runtime]: { source: 'missing', health: 'ok', publicHealth: 'ok', cooldownUntil: null, updatedAt: null } } }
    }));
    t.after(() => f.state.destroy());
    await f.state.open(); await f.state.select('g:A');
    assert.equal(f.state.snapshot().groupHealth, 'ok');
    assert.equal(f.state.snapshot().groupWait, null);
  });
}

test('conversation state clears wait when navigating to a group without a target runtime', { timeout: 2000 }, async t => {
  const wait = { kind: 'rate_wait', runtime: 'claude' };
  const f = groupFixture(() => groupSnapshot('running', {
    rows: [{ sessionGroup: 'dashboard:a', presence: 'running', target: { runtime: 'claude' }, wait },
      { sessionGroup: 'dashboard:b', presence: 'running', target: { runtime: null }, wait: null }],
    instance: { runtimeHealth: { claude: { health: 'rate_limited' }, codex: { health: 'ok' } } }
  }), u => u.pathname === '/api/chat/conversations/g%3AB' ? {
    conversation: { id: 'g:B', sessionGroup: 'dashboard:b', state: 'active' }, stored: false
  } : undefined);
  t.after(() => f.state.destroy());
  await f.state.open(); await f.state.select('g:A');
  assert.equal(f.state.snapshot().groupWait, wait);
  await f.state.select('g:B');
  assert.equal(f.state.snapshot().groupWait, null);
  assert.equal(f.state.snapshot().groupHealth, null);
});

test('a late wait response cannot restore restriction after navigation', { timeout: 2000 }, async t => {
  const pending = deferred();
  const wait = { kind: 'rate_wait', runtime: 'claude' };
  let reads = 0;
  const response = () => groupSnapshot('running', {
    rows: [{ sessionGroup: 'dashboard:a', presence: 'running', target: { runtime: 'claude' }, wait }],
    instance: { runtimeHealth: { claude: { health: 'recovering' } } }
  });
  const f = groupFixture(() => ++reads === 1 ? response() : pending.promise);
  t.after(() => f.state.destroy());
  await f.state.open(); await f.state.select('g:A');
  assert.equal(f.state.snapshot().groupWait, wait);
  await f.timer.advance(30000);
  await f.state.select('g:B');
  assert.equal(f.state.snapshot().groupWait, null);
  pending.resolve(response()); await flush();
  assert.equal(f.state.snapshot().selectedId, 'g:B');
  assert.equal(f.state.snapshot().groupWait, null);
  assert.equal(f.state.snapshot().groupHealth, null);
});

for (const failure of ['unknown list', 'missing row']) {
  test(`conversation state clears wait after ${failure}`, { timeout: 2000 }, async t => {
    let readable = true;
    const wait = { kind: 'rate_wait', runtime: 'claude' };
    const f = groupFixture(() => groupSnapshot('running', {
      listKnown: readable || failure !== 'unknown list',
      rows: !readable && failure === 'missing row' ? [] : [
        { sessionGroup: 'dashboard:a', presence: 'running', target: { runtime: 'claude' }, wait }
      ], instance: { runtimeHealth: { claude: { health: 'recovering' } } }
    }));
    t.after(() => f.state.destroy());
    await f.state.open(); await f.state.select('g:A');
    assert.equal(f.state.snapshot().groupWait, wait);
    readable = false; await f.timer.advance(30000);
    assert.equal(f.state.snapshot().groupWait, null);
    assert.equal(f.state.snapshot().groupHealth, null);
  });
}
test('running marker uses the exact group and clears after an unreadable workbench response', async () => {
  let fail = false;
  const f = groupFixture(() => {
    if (fail) throw {
      code: 'status_unavailable'
    };
    return groupSnapshot('running');
  });
  await f.state.open();
  await f.state.select('g:A');
  assert.equal(f.state.snapshot().groupPresence, true);
  assert.equal(f.state.snapshot().groupPresenceReadAt, 1000);
  fail = true;
  await f.timer.advance(30000);
  assert.equal(f.state.snapshot().groupPresence, null);
  assert.equal(f.state.snapshot().groupPresenceReadAt, null);
  assert.equal(f.state.snapshot().updateError, null);
  f.state.destroy();
});
test('running marker fails closed for unknown lists, failed sources, different groups or unknown presence', async () => {
  for (const response of [groupSnapshot('running', {
    listKnown: false
  }), groupSnapshot('running', {
    sources: {
      status: {
        ok: false,
        readAt: 1000
      }
    }
  }), groupSnapshot('running', {
    rows: [{
      sessionGroup: 'dashboard:other',
      presence: 'running'
    }]
  }), groupSnapshot('starting'), groupSnapshot('unknown')]) {
    const f = groupFixture(() => response);
    await f.state.open();
    await f.state.select('g:A');
    assert.equal(f.state.snapshot().groupPresence, null);
    f.state.destroy();
  }
});
test('non-running group status is authoritative and stale identity responses cannot restore a running marker', async () => {
  const pending = deferred();
  let reads = 0;
  const f = groupFixture(() => ++reads === 1 ? groupSnapshot('not_running') : pending.promise);
  await f.state.open();
  await f.state.select('g:A');
  assert.equal(f.state.snapshot().groupPresence, false);
  await f.timer.advance(30000);
  f.state.close();
  f.setIdentity('another');
  await f.state.open();
  pending.resolve(groupSnapshot('running'));
  await flush();
  assert.equal(f.state.snapshot().groupPresence, null);
  assert.equal(f.state.snapshot().items.some(item => item.id === 'g:A'), true);
  assert.equal(f.state.snapshot().selectedId, null);
  f.state.destroy();
});


test('a hanging group status request cannot block selection or five-second message reads', { timeout: 2000 }, async () => {
  let signal;
  const pending = deferred();
  const f = fixture((u, options) => {
    if (u.pathname === '/api/chat/conversations/g%3AA') return { conversation: { id: 'g:A', sessionGroup: 'dashboard:a', state: 'active' }, stored: false };
    if (u.pathname === '/api/workbench/groups') {
      signal = options.signal;
      signal.addEventListener('abort', () => pending.reject({ code: 'aborted' }), { once: true });
      return pending.promise;
    }
    if (u.pathname.endsWith('/messages') && u.searchParams.get('direction') === 'after') {
      return { items: [{ id: 11, direction: 'out', status: 'delivered', content: 'New reply despite hung group status' }], afterCursor: 'a11' };
    }
  });
  try {
    await f.state.open();
    await f.state.select('g:A');
    assert.equal(f.state.snapshot().messages.length, 1);
    assert.equal(f.state.snapshot().groupPresence, null);
    await f.timer.advance(4999);
    assert.equal(f.reads().length, 0);
    await f.timer.advance(1);
    assert.equal(f.reads().length, 1);
    assert.equal(f.state.snapshot().messages.at(-1).id, 11);
    assert.equal(f.calls.filter(c => c.path === '/api/workbench/groups').length, 1);
  } finally {
    f.state.destroy();
    assert.equal(signal.aborted, true);
    await flush();
    assert.equal(f.timer.count(), 0);
  }
});

for (const health of ['ok', 'rate_limited']) test(`sending with ${health} health preserves the group refresh cadence`, { timeout: 2000 }, async () => {
  const f = fixture(u => {
    if (u.pathname === '/api/chat/conversations/g%3AA') return { conversation: { id: 'g:A', sessionGroup: 'dashboard:a', state: 'active' }, stored: false };
    if (u.pathname === '/api/workbench/groups') return groupSnapshot('running', {
      rows: [{ sessionGroup: 'dashboard:a', presence: 'running', target: { runtime: 'claude' }, wait: null }],
      instance: { runtimeHealth: { claude: { health } } }
    });
    if (u.pathname.endsWith('/send')) return { stored: true, conversationId: 'g:A' };
  });
  try {
    await f.state.open();
    await f.state.select('g:A');
    assert.equal(f.state.snapshot().groupHealth, health);
    const groupReads = () => f.calls.filter(c => c.path === '/api/workbench/groups').length;
    assert.equal(groupReads(), 1);
    f.state.setInput('hello');
    await f.state.send();
    const afterSendReads = health === 'ok' ? 1 : 2;
    assert.equal(groupReads(), afterSendReads);
    const initialReads = f.reads().length;
    await f.timer.advance(12000);
    assert.equal(f.reads().length, initialReads + 6);
    assert.equal(groupReads(), afterSendReads);
    await f.timer.advance(18000);
    assert.equal(groupReads(), afterSendReads + 1);
    await f.timer.advance(30000);
    assert.equal(groupReads(), afterSendReads + 2);
  } finally {
    f.state.destroy();
  }
});

test('thirty-second list refresh deduplicates a pending optional group status read', { timeout: 2000 }, async () => {
  const pending = deferred();
  let reads = 0;
  const f = groupFixture(() => ++reads === 1 ? pending.promise : groupSnapshot('running'));
  try {
    await f.state.open();
    await f.state.select('g:A');
    await f.timer.advance(60000);
    assert.equal(reads, 1);
    assert.equal(f.reads().length, 12);
    pending.resolve(groupSnapshot('running'));
    await flush();
    await f.timer.advance(30000);
    assert.equal(reads, 2);
    assert.equal(f.state.snapshot().groupPresence, true);
  } finally {
    pending.resolve(groupSnapshot('unknown'));
    f.state.destroy();
  }
});

test('a running marker remains visible throughout a pending group status refresh', async () => {
  const pending = deferred();
  let reads = 0;
  const f = groupFixture(() => ++reads === 1 ? groupSnapshot('running') : pending.promise);
  const observed = [];
  try {
    await f.state.open();
    await f.state.select('g:A');
    assert.equal(f.state.snapshot().groupPresence, true);
    const unsubscribe = f.state.subscribe(snapshot => observed.push(snapshot.groupPresence));
    await f.timer.advance(30000);
    assert.equal(reads, 2);
    await f.timer.advance(4000);
    assert.equal(f.state.snapshot().groupPresence, true);
    assert.equal(f.state.snapshot().groupPresenceReadAt, 1000);
    assert.ok(observed.length > 0);
    assert.ok(observed.every(value => value === true));
    unsubscribe();
    pending.resolve(groupSnapshot('not_running', { sources: { status: { ok: true, readAt: 35000 } } }));
    await flush();
    assert.equal(f.state.snapshot().groupPresence, false);
    assert.equal(f.state.snapshot().groupPresenceReadAt, 35000);
  } finally {
    pending.resolve(groupSnapshot('unknown'));
    f.state.destroy();
    await flush();
  }
});

test('switching conversations aborts a pending group read and reads the new group immediately', async () => {
  const pending = deferred();
  let reads = 0, oldSignal;
  const f = fixture((u, options) => {
    if (['/api/chat/conversations/g%3AA', '/api/chat/conversations/g%3AB'].includes(u.pathname)) {
      const id = decodeURIComponent(u.pathname.split('/').at(-1));
      return { conversation: { id, sessionGroup: id === 'g:A' ? 'dashboard:a' : 'dashboard:b', state: 'active' }, stored: false };
    }
    if (u.pathname === '/api/workbench/groups') {
      reads++;
      if (reads === 1) {
        oldSignal = options.signal;
        // The old transport deliberately ignores abort: it must not hold the
        // new selection hostage or overwrite the replacement read later.
        return pending.promise;
      }
      return groupSnapshot('running', { rows: [{ sessionGroup: 'dashboard:b', presence: 'running' }] });
    }
  });
  try {
    await f.state.open();
    await f.state.select('g:A');
    assert.equal(reads, 1);
    assert.equal(oldSignal.aborted, false);
    await f.state.select('g:B');
    assert.equal(oldSignal.aborted, true);
    assert.equal(reads, 2);
    assert.equal(f.timer.now(), 1000);
    assert.equal(f.state.snapshot().selectedId, 'g:B');
    assert.equal(f.state.snapshot().groupPresence, true);
    pending.resolve(groupSnapshot('not_running'));
    await flush();
    assert.equal(f.state.snapshot().groupPresence, true);
    await f.timer.advance(30000);
    assert.equal(reads, 3);
  } finally {
    pending.resolve(groupSnapshot('unknown'));
    f.state.destroy();
    await flush();
  }
});

test('closing the page aborts its pending optional group request', async () => {
  const pending = deferred();
  let signal;
  const f = groupFixture(options => {
    signal = options.signal;
    return pending.promise;
  });
  try {
    await f.state.open();
    await f.state.select('g:A');
    assert.equal(signal.aborted, false);
    f.state.close();
    assert.equal(signal.aborted, true);
    assert.equal(f.timer.count(), 0);
    pending.resolve(groupSnapshot('running'));
    await flush();
    assert.equal(f.state.snapshot().groupPresence, null);
  } finally {
    pending.resolve(groupSnapshot('unknown'));
    f.state.destroy();
    await flush();
  }
});

test('opening another identity aborts the old identity group request', async () => {
  const pending = deferred();
  let signal;
  const f = groupFixture(options => {
    signal = options.signal;
    return pending.promise;
  });
  try {
    await f.state.open();
    await f.state.select('g:A');
    assert.equal(signal.aborted, false);
    f.setIdentity('another');
    await f.state.open();
    assert.equal(signal.aborted, true);
    pending.resolve(groupSnapshot('running'));
    await flush();
    assert.equal(f.state.snapshot().selectedId, null);
    assert.equal(f.state.snapshot().groupPresence, null);
  } finally {
    pending.resolve(groupSnapshot('unknown'));
    f.state.destroy();
    await flush();
  }
});

test('remote chat closure aborts the pending optional group request', async () => {
  const pending = deferred();
  let signal;
  const f = groupFixture(options => {
    signal = options.signal;
    return pending.promise;
  }, u => u.pathname.endsWith('/messages') && u.searchParams.get('direction') === 'after'
    ? Promise.reject({ code: 'remote_chat_disabled' }) : undefined);
  try {
    await f.state.open();
    await f.state.select('g:A');
    assert.equal(signal.aborted, false);
    await f.timer.advance(5000);
    assert.equal(signal.aborted, true);
    assert.equal(f.state.snapshot().blocked, true);
    assert.equal(f.timer.count(), 0);
    pending.resolve(groupSnapshot('running'));
    await flush();
    assert.equal(f.state.snapshot().selectedId, null);
    assert.equal(f.state.snapshot().groupPresence, null);
  } finally {
    pending.resolve(groupSnapshot('unknown'));
    f.state.destroy();
    await flush();
  }
});

test('external selection outside the first page preserves supplied group metadata without a detail request', async () => {
  const f = fixture();
  await f.state.open();
  await f.state.setTab('external');
  const metadata = { id: 'g:74656C656772616D3AE8BF90E7BBB4E7BEA42DE6B58BE8AF95', session_group: 'telegram:运维群-测试', channel: 'telegram' };
  await f.state.select(metadata.id, metadata);
  assert.equal(f.state.snapshot().tab, 'external');
  assert.equal(f.state.snapshot().selectedId, metadata.id);
  assert.equal(f.state.snapshot().conversation.session_group, metadata.session_group);
  assert.equal(f.state.snapshot().conversation.channel, 'telegram');
  assert.equal(f.calls.some(c => c.path === '/api/chat/conversations/' + metadata.id), false);
  assert.equal(f.calls.some(c => c.options?.method), false);
  f.state.destroy();
});


test('conversation list and incremental reads request previews in the current page language', async () => {
  const f = fixture();
  f.document.documentElement = { lang: 'en' };
  await f.state.open(); await f.state.select('g:A');
  await f.timer.advance(5000);
  const reads = f.calls.filter(call => /^\/api\/chat\/conversations(?:\?|\/[^/]+\/messages\?)/.test(call.path));
  assert.ok(reads.length >= 3);
  for (const call of reads) {
    assert.equal(new URL(call.path, 'http://fixture').searchParams.has('locale'), false);
    assert.equal(call.options.headers['X-Zylos-Locale'], 'en');
  }
  f.document.documentElement.lang = 'zh';
  await f.timer.advance(30000);
  assert.equal(f.calls.filter(call => call.path.includes('/messages?')).at(-1).options.headers['X-Zylos-Locale'], 'zh');
  f.state.destroy(); assert.equal(f.timer.count(), 0);
});
test('a settling round keeps the two-second refresh and is read again; once settled the refresh is five seconds again', async () => {
  let settling = true;
  const f = await selected(u => {
    if (u.pathname.endsWith('/messages')) return { items: u.searchParams.get('direction') === 'before'
      ? [{ id: 1, direction: 'in', status: 'delivered', content: 'hi' }, { id: 2, direction: 'out', status: 'delivered', content: 'done' }] : [],
    nextCursor: null, afterCursor: 'after2' };
    if (u.pathname.endsWith('/activity')) return { now: 1000, items: [{ id: 1, state: 'round', round: '1' }],
      rounds: [{ key: '1', messageIds: [1], start: 0, end: 500, state: 'done', ...(settling ? { settling: true } : {}), segments: [] }] };
  });
  const activityReads = () => f.calls.filter(c => c.path.includes('/activity?')).length;
  const first = activityReads();
  assert.ok(first >= 1);
  await f.timer.advance(2000);
  assert.equal(f.reads().length, 1, 'quick refresh while the round settles');
  assert.equal(activityReads(), first + 1, 'and the settling round is read again');
  settling = false;
  await f.timer.advance(2000);
  assert.equal(f.reads().length, 2);
  const settled = activityReads();
  await f.timer.advance(4999);
  assert.equal(f.reads().length, 2, 'settled: back to the five-second refresh');
  await f.timer.advance(1);
  assert.equal(f.reads().length, 3);
  assert.equal(activityReads(), settled, 'a settled round is not read again');
  f.state.destroy();
});

for (const restoreBeforeSend of [false, true]) {
  test(restoreBeforeSend
    ? 'foregrounding without a selection then a slow first send keeps delivery and replies updating'
    : 'a three second first send resumes reads within two seconds and continues for a minute', async t => {
    const pending = deferred();
    let sent = false;
    const inbound = { id: 20, direction: 'in', status: 'pending', content: 'slow first message' };
    const f = fixture((u, options) => {
      if (u.pathname.endsWith('/send')) {
        assert.equal(options.method, 'POST');
        return pending.promise;
      }
      if (u.pathname.endsWith('/messages')) return {
        items: u.searchParams.get('direction') === 'before' ? [inbound]
          : sent && f.timer.now() >= 13000 ? [{ id: 21, direction: 'out', status: 'delivered', content: 'automatic reply' }] : [],
        afterCursor: 'after20', nextCursor: null
      };
      if (u.pathname.endsWith('/status')) return {
        items: sent && f.timer.now() >= 10000 ? [{ ...inbound, status: 'delivered' }] : []
      };
    });
    t.after(() => f.state.destroy());
    await f.state.open();
    if (restoreBeforeSend) {
      await f.visible(false);
      await f.timer.advance(100);
      await f.visible(true);
      assert.equal(f.reads().length, 0);
    }
    await f.state.select('d:first');
    f.state.setInput('slow first message');
    const sending = f.state.send();
    await f.timer.advance(3000);
    assert.equal(f.state.snapshot().sending, true);
    assert.equal(f.reads().length, 0, 'draft has no message cursor during the empty accelerated pass');
    sent = true;
    pending.resolve({ stored: true, conversationId: 'g:A', deliveryState: 'pending' });
    await sending;
    assert.equal(f.state.snapshot().messages[0].status, 'pending');
    const readsAfterSend = f.reads().length;
    await f.timer.advance(1999);
    assert.equal(f.reads().length, readsAfterSend);
    await f.timer.advance(1);
    assert.equal(f.reads().length, readsAfterSend + 1, 'first automatic read is due two seconds after the slow send returns');
    await f.timer.advance(33000);
    assert.equal(f.state.snapshot().messages.find(row => row.id === 20).status, 'delivered');
    assert.equal(f.state.snapshot().messages.find(row => row.id === 21).content, 'automatic reply');
    assert.ok(f.reads().length > readsAfterSend);
    const continued = f.reads().length;
    await f.timer.advance(25000);
    assert.ok(f.reads().length > continued, 'automatic reads continue across the first minute');
    assert.equal(f.calls.filter(call => call.path.endsWith('/send')).length, 1, 'polling never retries a send');
    assert.equal(f.timer.count(), 1);
  });
}

test('empty foreground passes keep the thirty second list refresh alive', async t => {
  const f = fixture();
  t.after(() => f.state.destroy());
  await f.state.open();
  for (let i = 0; i < 3; i++) {
    await f.visible(false);
    await f.visible(true);
  }
  assert.equal(f.state.snapshot().selectedId, null);
  const lists = () => f.calls.filter(call => new URL(call.path, 'http://fixture').pathname === '/api/chat/conversations');
  assert.equal(lists().length, 1);
  await f.timer.advance(29999);
  assert.equal(lists().length, 1);
  await f.timer.advance(1);
  assert.equal(lists().length, 2);
  await f.timer.advance(60000);
  assert.equal(lists().length, 4);
  assert.equal(f.timer.count(), 1);
  assert.equal(f.reads().length, 0);
});

test('an in-flight pass retains single flight across visibility changes and close then reopen', async t => {
  const pending = deferred();
  let attempts = 0, concurrent = 0, maximum = 0;
  const f = await selected(u => {
    if (!u.pathname.endsWith('/messages') || u.searchParams.get('direction') !== 'after') return undefined;
    attempts++;
    concurrent++;
    maximum = Math.max(maximum, concurrent);
    return (async () => {
      try {
        return attempts === 1 ? await pending.promise : { items: [], afterCursor: 'next' };
      } finally { concurrent--; }
    })();
  });
  t.after(() => f.state.destroy());
  await f.timer.advance(5000);
  assert.equal(attempts, 1);
  await f.visible(false);
  await f.visible(true);
  f.state.close();
  await f.state.open();
  await f.timer.advance(10000);
  await f.visible(false);
  await f.visible(true);
  assert.equal(attempts, 1);
  pending.resolve({ items: [{ id: 99, direction: 'out', content: 'stale epoch reply' }], afterCursor: 'stale' });
  await flush();
  assert.equal(f.state.snapshot().messages.some(row => row.id === 99), false);
  await f.timer.advance(5000);
  assert.equal(attempts, 2);
  await f.timer.advance(10000);
  assert.equal(attempts, 4);
  assert.equal(maximum, 1);
  assert.equal(f.timer.count(), 1);
});

test('a synchronous request error after an empty pass backs off and recovers automatic list refresh', async t => {
  let fail = true, lists = 0;
  const f = fixture(u => {
    if (u.pathname !== '/api/chat/conversations') return;
    if (++lists === 1) return { items: [], nextCursor: null };
    if (fail) throw { code: 'temporary_list_failure' };
    return { items: [], nextCursor: null };
  });
  t.after(() => f.state.destroy());
  await f.state.open();
  await f.visible(false);
  await f.visible(true);
  await f.timer.advance(30000);
  assert.equal(f.state.snapshot().updateError, 'temporary_list_failure');
  const failed = lists;
  await f.timer.advance(4999);
  assert.equal(lists, failed);
  await f.timer.advance(1);
  assert.equal(lists, failed + 1);
  fail = false;
  await f.timer.advance(10000);
  assert.equal(f.state.snapshot().updateError, null);
  const recovered = lists;
  await f.timer.advance(30000);
  assert.equal(lists, recovered + 1);
});

test('closing before a queued foreground pass starts permits a fresh open to keep polling', async t => {
  const f = fixture();
  t.after(() => f.state.destroy());
  await f.state.open();
  await f.visible(false);
  const restoring = f.visible(true);
  f.state.close();
  await restoring;
  const closedCalls = f.calls.length;
  await f.timer.advance(60000);
  assert.equal(f.calls.length, closedCalls);
  assert.equal(f.timer.count(), 0);
  await f.state.open();
  const reopenedCalls = f.calls.length;
  await f.timer.advance(30000);
  assert.ok(f.calls.length > reopenedCalls);
  assert.equal(f.timer.count(), 1);
});

test('foreground events cannot overlap a slow automatic list poll', async t => {
  const pending = deferred();
  let lists = 0, concurrent = 0, maximum = 0;
  const f = fixture(u => {
    if (u.pathname !== '/api/chat/conversations') return;
    lists++;
    concurrent++;
    maximum = Math.max(maximum, concurrent);
    return (async () => {
      try { return lists === 2 ? await pending.promise : { items: [], nextCursor: null }; }
      finally { concurrent--; }
    })();
  });
  t.after(() => f.state.destroy());
  await f.state.open();
  await f.timer.advance(30000);
  assert.equal(lists, 2);
  for (let i = 0; i < 3; i++) {
    await f.visible(false);
    await f.visible(true);
  }
  await f.timer.advance(60000);
  assert.equal(lists, 2);
  pending.resolve({ items: [], nextCursor: null });
  await flush();
  await f.timer.advance(30000);
  assert.equal(lists, 3);
  assert.equal(maximum, 1);
  assert.equal(f.timer.count(), 1);
});

test('clock advancement rejects a timer that endlessly reschedules without delay', async () => {
  const timer = clock();
  const repeat = () => timer.setTimeout(repeat, 0);
  repeat();
  await assert.rejects(timer.advance(1), /clock advance exceeded 1000 timer callbacks/);
});

test('a continuing send retains the accelerated deadline installed when sending starts', async t => {
  const pending = deferred();
  const f = await selected(url => url.pathname.endsWith('/send') ? pending.promise : undefined);
  t.after(() => f.state.destroy());
  assert.equal(f.state.snapshot().afterCursor, 'after10');
  const started = f.timer.now();
  f.state.setInput('continuing message'); const sending = f.state.send();
  await f.timer.advance(1000);
  pending.resolve({ stored: true, conversationId: 'g:A', deliveryState: 'pending' });
  await sending;
  assert.equal(f.timer.now(), started + 1000);
  const afterReturn = f.reads().length;
  assert.equal(afterReturn, 1, 'send completion synchronizes current history immediately');
  await f.timer.advance(999);
  assert.equal(f.reads().length, afterReturn);
  await f.timer.advance(1);
  assert.equal(f.reads().length, afterReturn + 1, 'scheduled read remains at send start plus two seconds');
  assert.equal(f.reads().at(-1).time, started + 2000);
  await f.timer.advance(1000);
  assert.equal(f.reads().length, afterReturn + 1, 'return plus two seconds does not create an extra deadline');
  await f.timer.advance(1000);
  assert.equal(f.reads().at(-1).time, started + 4000);
});

test('internal rows stay out of delivery activity and list previews', async t => {
  const external = { id: 1, channel: 'dashboard', direction: 'in', status: 'pending', content: 'External preview', timestamp: '2026-01-01T00:00:00Z' };
  const internal = { id: 2, channel: 'internal', direction: 'in', status: 'pending', content: 'Internal secret', timestamp: '2026-01-02T00:00:00Z' };
  const f = await selected(u => u.pathname.endsWith('/messages') && u.searchParams.get('direction') === 'before'
    ? { items: [external, internal], afterCursor: 'after2' }
    : u.pathname.endsWith('/activity') ? { items: [], rounds: [] } : undefined);
  t.after(() => f.state.destroy());
  await flush();
  const listed = f.state.snapshot().items.find(row => row.id === 'g:A');
  assert.equal(listed.preview, 'External preview');
  assert.equal(listed.previewDirection, 'in');
  assert.equal(listed.stamp, new Date(external.timestamp).getTime() / 86400000 + 2440587.5);
  assert.equal(f.state.snapshot().messages.length, 2, 'the internal row remains visible in selected history');
  await f.timer.advance(5000);
  for (const suffix of ['/status', '/activity']) {
    const reads = f.calls.filter(call => new URL(call.path, 'http://fixture').pathname.endsWith(suffix));
    assert.ok(reads.length > 0, `${suffix} has the external positive control`);
    for (const read of reads) assert.equal(new URL(read.path, 'http://fixture').searchParams.get('ids'), '1');
  }
});

test('an internal outbound relay preserves accelerated waiting and avoids question refresh', async t => {
  let afterReads = 0;
  const f = await selected(u => u.pathname.endsWith('/send') ? { stored: true, conversationId: 'g:A', deliveryState: 'pending' }
    : u.pathname.endsWith('/messages') && u.searchParams.get('direction') === 'after'
      ? { items: ++afterReads === 2 ? [{ id: 11, channel: 'internal', direction: 'out', status: 'delivered', content: 'Relay' }] : [], afterCursor: 'after' }
      : undefined);
  t.after(() => f.state.destroy());
  f.state.setInput('hello'); await f.state.send();
  const before = f.reads().length, questions = f.calls.filter(call => call.path.includes('/questions?')).length;
  await f.timer.advance(2000);
  assert.equal(f.reads().length, before + 1);
  assert.equal(f.calls.filter(call => call.path.includes('/questions?')).length, questions);
  await f.timer.advance(1999);
  assert.equal(f.reads().length, before + 1);
  await f.timer.advance(1);
  assert.equal(f.reads().length, before + 2, 'relay does not masquerade as the awaited external reply');
});
