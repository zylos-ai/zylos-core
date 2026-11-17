// Runs an immutable archived beta.12 package against this case's private DB.
// No runtime module is rewritten and no source is evaluated as a string.
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
const [baseline] = process.argv.slice(2);
assert.ok(baseline.startsWith(path.dirname(process.env.HOME) + path.sep));
assert.equal(JSON.parse(fs.readFileSync(path.join(baseline, 'package.json'))).version, '1.0.0-beta.12');
const load = relative => import(pathToFileURL(path.join(baseline, relative)).href);
const { default: Database } = await load('skills/comm-bridge/scripts/sqlite-driver.js');
const { createStore } = await load('skills/comm-bridge/scripts/c4-v2-store.js');
const { createModeSwitchConverter } = await load('skills/activity-monitor/scripts/mode-switch-convert.js');
const db = new Database(path.join(process.env.ZYLOS_DIR, 'comm-bridge/c4.db'));
try {
  const store = createStore(db);
  const { runId } = store.beginModeTransition('multi', 'single');
  store.setDrainFence('*');
  store.absorbForTransition(runId);
  createModeSwitchConverter({ db: store, zylosDir: process.env.ZYLOS_DIR })(store.getModeTransition());
  let code;
  try { store.setModeTransitionPhase(runId, 'cutover'); } catch (error) { code = error.code; }
  assert.equal(code, 'CHECKPOINT_REGRESSION', 'The actual released code must reproduce the regression');
  assert.equal(store.getModeTransition().phase, 'converting');
  process.stdout.write(JSON.stringify({ code, transition: store.getModeTransition() }) + '\n');
} finally { db.close(); }
