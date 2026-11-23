import { seedHistoricalAbsorption } from './fixtures/historical-absorption.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixture } from './c4-v2-test-helpers.js';
import { readAbsorbedReply, sendExternal } from '../c4-send-external.js';

function setup(t, endpoint = 'route', options = { groupName: 'room' }) {
  const result = fixture(t, {}, true);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'absorbed-reply-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'demo', 'scripts', 'send.js');
  const output = path.join(dir, 'argv.json');
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify(process.argv.slice(2)))`);
  const row = result.store.insertConversation('in', 'demo', endpoint, 'original', options);
  const { runId } = result.store.beginModeTransition('single', 'multi');
  result.store.setDrainFence('*');
  seedHistoricalAbsorption(result.db, runId, [row.id]);
  const api = { ...result.store, getDb: () => result.db,
    getConversationsByRange: (a, b) => result.db.prepare('SELECT * FROM conversations WHERE id>=? AND id<=? ORDER BY id').all(a, b) };
  return { ...result, dir, script, output, row, runId, api };
}

test('real component receives exact absorbed route bytes and null endpoint is omitted', async t => {
  for (const endpoint of [null, 'a\'"$`\\\nroute', 'x'.repeat(131071)]) {
    const { api, db, runId, row, dir, output } = setup(t, endpoint);
    const request = readAbsorbedReply(runId, String(row.id), api);
    await sendExternal(request, 'response', { api, skillsDir: dir });
    assert.deepEqual(JSON.parse(fs.readFileSync(output)), endpoint === null ? ['response'] : [endpoint, 'response']);
    assert.equal(db.prepare("SELECT endpoint_id FROM conversations WHERE direction='out'").get().endpoint_id, endpoint);
    assert.equal(db.prepare('SELECT status FROM conversations WHERE id=?').get(row.id).status, 'switch_absorbed');
  }
});
