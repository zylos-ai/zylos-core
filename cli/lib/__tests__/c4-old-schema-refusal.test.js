import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from '../../../skills/comm-bridge/scripts/sqlite-driver.js';
import { SUPPORTED_SCHEMA_VERSION } from '../../../skills/comm-bridge/scripts/c4-schema.js';
import { openReadStore } from '../c4-read-store.js';
import { readSessionModeStatus } from '../session-mode-status.js';
import { readOriginFacts } from '../origin-presence.js';
import { createGroupDeletion } from '../group-delete.js';

// Ordinary C4 openers only check the schema. An older database is refused with
// an actionable error and stays byte-identical; migration belongs to the upgrade.
const v1 = fileURLToPath(new URL('../../../skills/comm-bridge/scripts/__tests__/fixtures/migration-history/c4-v0.9.0-v1.sql', import.meta.url));

function oldInstance(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-old-schema-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const zylosDir = path.join(home, 'zylos'), file = path.join(zylosDir, 'comm-bridge', 'c4.db');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.mkdirSync(path.join(zylosDir, '.zylos'));
  fs.writeFileSync(path.join(zylosDir, '.zylos', 'config.json'), JSON.stringify({ session_mode: 'multi' }));
  const db = new Database(file); db.exec(fs.readFileSync(v1, 'utf8')); db.close();
  const before = fs.readFileSync(file);
  const unchanged = () => {
    assert.ok(fs.readFileSync(file).equals(before), `${file} changed`);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['c4.db']);
  };
  return { home, zylosDir, file, unchanged };
}

const upgradeRequired = file => error => {
  assert.equal(error.code, 'SCHEMA_UPGRADE_REQUIRED');
  assert.equal(error.schemaVersion, 1);
  assert.equal(error.supportedVersion, SUPPORTED_SCHEMA_VERSION);
  assert.ok(error.message.startsWith(`${file}: schema version 1 is older than supported ${SUPPORTED_SCHEMA_VERSION}`), error.message);
  assert.match(error.message, /and was not migrated; run "zylos upgrade --self" to migrate it\./);
  return true;
};

test('read store refuses an older C4 database instead of reading a partial layout', async t => {
  const f = oldInstance(t);
  await assert.rejects(openReadStore(f.zylosDir), upgradeRequired(f.file));
  f.unchanged();
});

test('session-mode status surfaces the refusal to its caller', async t => {
  const f = oldInstance(t);
  await assert.rejects(readSessionModeStatus({ zylosDir: f.zylosDir, readMode: () => ({ mode: 'multi' }) }), upgradeRequired(f.file));
  f.unchanged();
});

test('origin presence reports the refusal as an unreadable need, not as absence', async t => {
  const f = oldInstance(t);
  const facts = await readOriginFacts({ zylosDir: f.zylosDir });
  assert.equal(facts.originNeed.error.code, 'READ_FAILED');
  assert.match(facts.originNeed.error.message, /schema version 1 is older than supported .*run "zylos upgrade --self"/);
  assert.equal(facts.transitionOpen, null);
  f.unchanged();
});

test('group deletion refuses an older C4 database without changing it', async t => {
  const f = oldInstance(t);
  const service = createGroupDeletion({ zylosDir: f.zylosDir, homeDir: f.home, requestStop: async () => assert.fail('must not request a stop') });
  t.after(() => service.close());
  await assert.rejects(service.preview({ sessionGroup: 'group-a' }), upgradeRequired(fs.realpathSync(f.file)));
  f.unchanged();
});
