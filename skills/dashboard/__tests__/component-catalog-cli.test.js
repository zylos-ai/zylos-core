import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { runComponents } from '../scripts/components.js';
import { evaluateBeforeSend } from '../scripts/send-hook.js';
import { CONTENT_PREFIX, COMPONENT_DEFINITIONS } from '../../comm-bridge/scripts/c4-content-schema.js';

// Static CLI boundary only: no DB, HTTP, PM2 or tmux. Run on generated catalog
// or CLI output changes; unrelated chat delivery/runtime work may skip.
function call(args, catalog, input) {
  let output = '', error = '';
  const exit = runComponents(args, { catalog, stdout: { write: value => { output += value; } },
    stderr: { write: value => { error += value; } },
    ...(input === undefined ? {} : { readInput: () => input }) });
  return { exit, output, error };
}

// Installed entry: spawns node on the real script with stdin or a file in a
// per-test temporary directory; no DB, HTTP, PM2 or tmux. Run when the CLI
// entry or input handling changes.

test('component CLI validation accepts exactly what the Dashboard send check accepts', () => {
  const fixtures = JSON.parse(fs.readFileSync(new URL('../../../test/fixtures/c4-content-protocol.json', import.meta.url), 'utf8'));
  const wire = content => {
    const input = structuredClone(fixtures.hookInputs.find(row => row.name === 'valid_input').value);
    input.request.content = content;
    return input;
  };
  const choice = () => structuredClone(COMPONENT_DEFINITIONS.find(item => item.key === 'choice@1').example);
  const repeatedOption = choice();
  repeatedOption.blocks[0].data.options[1].id = repeatedOption.blocks[0].data.options[0].id;
  const pendingInView = choice();
  pendingInView.blocks.push({ id: 'later', type: 'markdown', schemaVersion: 1, status: 'pending', fallbackText: 'Loading' });
  pendingInView.metadata = { view: { schemaVersion: 1, root: 'root', nodes: [{ id: 'root', type: 'block', blockId: 'later' }] } };
  const texts = [...fixtures.valid.map(item => item.content), ...fixtures.invalid.map(item => item.content),
    ...COMPONENT_DEFINITIONS.map(item => CONTENT_PREFIX + JSON.stringify(item.example)),
    CONTENT_PREFIX + JSON.stringify(repeatedOption), CONTENT_PREFIX + JSON.stringify(pendingInView)];
  let rejected = 0;
  for (const text of texts.filter(item => item.startsWith(CONTENT_PREFIX))) {
    const sent = evaluateBeforeSend(wire(text));
    const checked = call(['validate'], undefined, text);
    assert.equal(checked.exit === 0, sent.decision === 'continue', text.slice(0, 120));
    if (sent.decision === 'continue') continue;
    rejected++;
    assert.ok(sent.message === 'Invalid Dashboard structured content: ' + checked.error.trimEnd()
      || sent.message === 'Invalid Dashboard view: ' + JSON.parse(call(['validate', '--json'], undefined, text).output).error.code, sent.message);
  }
  assert.equal(rejected, fixtures.invalid.filter(item => item.content.startsWith(CONTENT_PREFIX)).length + 2);
});
