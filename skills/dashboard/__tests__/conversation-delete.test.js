import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createConversationDeletion } from '../public/js/wb/conversation-delete.js';

const item = { id: 'g:ABC', sessionGroup: 'dashboard:example' };
const boundary = { cutoffId: 4 };

const labels = JSON.parse(fs.readFileSync(new URL('../public/i18n/wb.en.json', import.meta.url), 'utf8'));
function fixture(options = {}) {
  const calls = [], confirmations = [], removed = [];
  const controller = createConversationDeletion({
    available: () => true, t: (key, args) => /^chat\.delete\.(messages|attachments)(One)?$/.test(key)
      ? labels[key].replace('{count}', String(args.count)) : JSON.stringify({ key, ...args }),
    request: async (path, options = {}) => { calls.push({ path, ...options }); return options.method
      ? { ok: true, counts: { messages: 4, attachments: 2 } }
      : { ...boundary, ok: true, operationId: 'operation-one', messages: 4, attachments: 2, draft: false }; },
    confirm: async (...args) => { confirmations.push(args); return true; },
    onDeleted: async id => removed.push(id), ...options,
  });
  return { controller, calls, confirmations, removed };
}

test('cancelled confirmation never starts deletion', async () => {
  const f = fixture({ confirm: async () => false }); await f.controller.remove(item);
  assert.equal(f.calls.length, 1); assert.deepEqual(f.removed, []);
});
