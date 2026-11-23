import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CONTENT_PREFIX, COMPONENT_DEFINITIONS, parseC4Content, findC4ContentError } from '../c4-content-schema.js';

// Pure schema checks: no files besides the shared fixture, no DB, HTTP, PM2 or tmux.
const fixtures = JSON.parse(fs.readFileSync(new URL('../../../../test/fixtures/c4-content-protocol.json', import.meta.url), 'utf8'));
const content = envelope => CONTENT_PREFIX + JSON.stringify(envelope);

// Send-time consistency checks: stored history still parses, new sends are
// rejected at the inconsistent member.

test('error lookup agrees with the send-time parser on every protocol fixture and component example', () => {
  const texts = [...fixtures.valid.map(item => item.content), ...fixtures.invalid.map(item => item.content),
    ...COMPONENT_DEFINITIONS.map(item => content(item.example))];
  let accepted = 0;
  for (const text of texts) {
    const sent = parseC4Content(text, { submission: true }).kind === 'envelope';
    assert.equal(findC4ContentError(text) === null, sent);
    accepted += sent;
  }
  assert.equal(accepted, fixtures.valid.length + COMPONENT_DEFINITIONS.length);
});
