import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import fs from 'node:fs';
import { evaluateBeforeSend } from '../scripts/send-hook.js';
import { runComponents } from '../scripts/components.js';

import { CONTENT_PREFIX, parseC4Content } from '../../comm-bridge/scripts/c4-content-schema.js';

const shared = new URL('../../comm-bridge/scripts/c4-content-schema.js', import.meta.url).href;
const browserDescriptors = new URL('../public/runtime-descriptors.js', import.meta.url).pathname;
const sourceDescriptors = new URL('../../../cli/lib/runtime/descriptors.js', import.meta.url).href;
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL && new URL(specifier, context.parentURL).pathname === browserDescriptors) return next(sourceDescriptors, context);
  if (context.parentURL && new URL(specifier, context.parentURL).pathname.endsWith('/public/chat-schema.js')) return next(shared, context);
  return next(specifier, context);
} });

const encode = envelope => CONTENT_PREFIX + JSON.stringify(envelope);
const block = (id, type, data, fallbackText = `${id} fallback`) => ({ id, type, schemaVersion: 1, data, fallbackText });
const future = () => ({ ...block('future', 'future_widget', {
  attachmentId: 'HIDDEN_ATTACHMENT', nameSnapshot: 'HIDDEN_FILE.png', action: { target: 'HIDDEN_ACTION' }, title: 'HIDDEN_TITLE'
}, '**literal** <img onerror=evil()> [link](javascript:evil())\nFuture fallback'),
  metadata: { citations: [{ label: 'HIDDEN_CITATION', url: 'https://example.test/private' }] } });
const message = blocks => ({ version: 1, kind: 'message', messageId: 'mixed-message', fallbackText: 'Whole-message words\nSecond line', blocks });

// Real browser modules and an injected in-memory DOM. Run for unknown-block
// renderer/parser changes; skip unrelated transport work. No runtime or storage.

// Pure reader functions only: no ChatHistory construction, database connection,
// file reads or external sends. Run for unknown parsing or text output changes.

// Direct acceptance functions only: valid non-attachment messages never open
// storage, and unknown content is rejected before attachment resolution.
test('BeforeSend and the component CLI keep the same unknown content unsendable', () => {
  const fixtures = JSON.parse(fs.readFileSync(new URL('../../../test/fixtures/c4-content-protocol.json', import.meta.url), 'utf8'));
  const source = message([future()]);
  const known = message([block('future', 'markdown', { text: 'Known text' })]);
  for (const [envelope, accepted] of [[source, false], [known, true]]) {
    const content = encode(envelope);
    assert.equal(parseC4Content(content).kind, 'envelope');
    const input = structuredClone(fixtures.hookInputs.find(row => row.name === 'valid_input').value);
    input.request.content = content;
    const result = evaluateBeforeSend(input);
    assert.equal(result.decision, accepted ? 'continue' : 'abort');
    let output = '';
    const exit = runComponents(['validate', '-', '--json'], {
      readInput: () => content, stdout: { write(value) { output += value; } },
      stderr: { write() { assert.fail('JSON validation emits its result to stdout'); } }
    });
    assert.equal(exit, accepted ? 0 : 1);
    assert.equal(JSON.parse(output).ok, accepted);
    if (!accepted) assert.equal(JSON.parse(output).error.code, 'enum');
  }
});
