import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import path from 'node:path';

const schemaPath = new URL('../public/chat-schema.js', import.meta.url).pathname;
const sourceSchema = new URL('../../comm-bridge/scripts/c4-content-schema.js', import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL && new URL(specifier, context.parentURL).pathname === schemaPath) return next(sourceSchema, context);
    return next(specifier, context);
  }
});
const { createConversationState } = await import('../public/js/wb/conversation-state.js');

// Pure controller tests: official runner owns these paths. No HTTP, database,
// PM2 or tmux is used, and scheduled polling belongs only to this fake clock.
for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) assert.ok(path.isAbsolute(process.env[key]), key);
const runnerRoot = path.dirname(process.env.HOME);
assert.match(path.basename(runnerRoot), /^zylos-tests-/);
assert.equal(process.env.ZYLOS_DIR, path.join(process.env.HOME, 'zylos'));
assert.equal(process.env.PM2_HOME, path.join(process.env.HOME, '.pm2'));
assert.equal(process.env.TMPDIR, path.join(runnerRoot, 'tmp'));
console.info('conversation state isolation', JSON.stringify(Object.fromEntries(['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR'].map(key => [key, process.env[key]]))), 'no HTTP/DB/PM2/tmux');
const controllers = new Set(), scheduled = new Map();
let timerId = 0;
const timers = {
  document: { hidden: false, visibilityState: 'visible' },
  now: () => 1000,
  setTimeout(fn, ms) { const id = ++timerId; scheduled.set(id, { fn, ms }); return id; },
  clearTimeout(id) { scheduled.delete(id); }
};
afterEach(() => {
  for (const state of controllers) state.destroy();
  controllers.clear();
  assert.equal(scheduled.size, 0, 'controller timers are reclaimed on every test outcome');
});

function fixture(extra = () => undefined, { identity } = {}) {
  const calls = [];
  const state = createConversationState({ ...timers, identity, request: async (path, options) => {
    calls.push({path,options}); const result = extra(path,options); if (result !== undefined) return result;
    if (path === '/api/instance') return { session_mode: { sessionMode: 'multi' } };
    if (path.includes('/messages?')) return {items:[],nextCursor:null,afterCursor:'after'};
    if (path.includes('?')) return {items:[],nextCursor:null};
    const id = decodeURIComponent(path.split('/').at(-1)); return {conversation:{id,state:'active'},conversationId:id,stored:false};
  }});
  controllers.add(state);
  return {state,calls};
}
test('unknown send preserves edited input and needs deliberate retry', async () => {
  const {state,calls}=fixture((path,options)=>options?.method==='POST'?{stored:null,needsReconciliation:true,preserveInput:true,retryAllowed:true}:undefined);
  await state.open(); await state.select('g:A'); state.setInput('first'); await state.send(); state.setInput('edited'); await state.send();
  assert.equal(calls.filter(x=>x.options?.method==='POST').length,1); assert.equal(state.snapshot().input,'edited');
  await state.send({retry:true}); assert.equal(calls.filter(x=>x.options?.method==='POST').at(-1).options.body.retry,true); state.destroy();
});
