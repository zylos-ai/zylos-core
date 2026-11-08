import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createScheduleTz } from '../src/lib/workbench/schedule-tz.js';

// A stand-in for the scheduler's tz.js whose zone the test changes between calls, so the reader's own behaviour is
// checked without an .env file or the scheduler module.
const FAKE_TZ_MODULE = 'data:text/javascript,let zone = "Asia/Shanghai"; export const setZone = next => { zone = next }; '
  + 'export const loadTimezone = () => { if (zone === null) throw new Error("unreadable"); return zone; };';

test('the instance time zone reader asks the scheduler on every call, so a changed zone needs no restart', async t => {
  const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-tz-reader-'));
  t.after(() => fs.rmSync(zylosDir, { recursive: true, force: true }));
  const fake = await import(FAKE_TZ_MODULE);
  t.after(() => fake.setZone('Asia/Shanghai'));
  const scheduleTz = createScheduleTz({ zylosDir, env: { ZYLOS_DIR: zylosDir }, tzModule: FAKE_TZ_MODULE });

  assert.deepEqual(await scheduleTz(), { tz: 'Asia/Shanghai' });
  assert.deepEqual(scheduleTz.current(), { tz: 'Asia/Shanghai' });
  fake.setZone('America/Los_Angeles');
  assert.deepEqual(scheduleTz.current(), { tz: 'America/Los_Angeles' }, 'the synchronous reader follows a changed zone');
  assert.deepEqual(await scheduleTz(), { tz: 'America/Los_Angeles' });
  fake.setZone('Pacific/Kiritimati');
  assert.deepEqual(scheduleTz.current(), { tz: 'Pacific/Kiritimati' });
  fake.setZone(null);
  assert.deepEqual(scheduleTz.current(), { tz: null, reason: 'tz_unavailable' }, 'an unreadable zone is unknown, not the last one read');
});
