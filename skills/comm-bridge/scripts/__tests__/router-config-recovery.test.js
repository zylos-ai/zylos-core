import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { readConfigStrict } from '../../../../cli/lib/config-store.js';
import { CONFIG_FILE, readSessionMode, readZylosConfigStrict } from '../../../../cli/lib/config.js';
import { routerFixture } from './helpers/router-fixture.js';

const validConfig = JSON.stringify({ runtime: 'claude', session_mode: 'multi' });
const badConfigs = [
  ['invalid JSON', '{'],
  ['unsupported runtime', JSON.stringify({ runtime: 'unsupported', session_mode: 'multi' })],
  ['invalid session mode', JSON.stringify({ runtime: 'claude', session_mode: 'unsupported' })],
];

// Covers Router's real activation, C4 configuration validation and SQLite state
// after an already initialized Router encounters a damaged instance config.
// Run for configuration diagnostics or activation/retry changes; skip unrelated UI
// changes. The official runner isolates HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR;
// this fixture owns its config and in-memory SQLite. Runtime and scene adapters
// are injected, so no tmux socket, PM2 process, network or model is invoked.
// Router.stop() and the Store fixture close all work and SQLite at teardown.
for (const [name, source] of badConfigs) {
  test(`${name} blocks inbound and continuation activation until config repair`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'router-config-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const filename = path.join(root, 'config.json');
    fs.writeFileSync(filename, validConfig);
    const f = routerFixture(t, { poolSize: 2 });
    f.dependencies.readConfig = () => readConfigStrict(filename);
    const origin = f.add('system');
    const inbound = f.add('inbound');
    const previous = f.add('continuation');
    f.sqlite.prepare("UPDATE conversations SET status='delivered' WHERE id=?").run(previous.id);
    f.db.recordRunEnd('continuation', { runId: 'old-run', reason: 'unexpected' });
    await f.create().initialize();
    fs.writeFileSync(filename, source);
    await f.rounds(2);
    f.advance(5000);
    await f.rounds(4);
    assert.equal(f.calls.filter(row => row[0] === 'launch').length, 0);
    assert.equal(f.row(origin.id).status, 'pending');
    assert.equal(f.row(inbound.id).status, 'pending');
    assert.equal(f.db.listRunEndings(['continuation'])[0].continuationPending, 1);
    for (const group of ['origin', 'inbound', 'continuation']) {
      assert.ok(f.events.some(event => event.event === 'activate_failed' &&
        event.session_group === group && event.reason === 'CONFIG_UNREADABLE'), group);
    }
    assert.equal(f.calls.filter(row => row[0] === 'alert').length, 0);
    assert.equal(fs.readFileSync(filename, 'utf8'), source);

    fs.writeFileSync(filename, validConfig);
    f.advance(5000);
    await f.rounds(8);
    const launches = f.calls.filter(row => row[0] === 'launch');
    assert.equal(launches.length, 3);
    assert.deepEqual(launches.map(row => row[1].sessionGroup).sort(), ['continuation', 'inbound', 'origin']);
    assert.ok(launches.every(row => row[1].launchConfig.runtime === 'claude'));
    assert.equal(f.row(origin.id).status, 'delivered');
    assert.equal(f.row(inbound.id).status, 'delivered');
    assert.equal(f.db.listRunEndings(['continuation'])[0].continuationPending, 0);
    assert.equal(f.calls.filter(row => row[0] === 'alert').length, 0);
  });
}

// Covers the real strict mode reader and initializeRouter startup gate. Run for
// configuration recovery wording or Router startup changes; skip unrelated UI.
// CONFIG_FILE is inside the official runner's private ZYLOS_DIR, not an installed
// instance. Store, scene, runtime and teardown have the same isolation as above.
for (const [name, source] of badConfigs) {
  test(`${name} present at Router startup preserves its recovery boundary`, async t => {
    const previous = fs.existsSync(CONFIG_FILE) ? fs.readFileSync(CONFIG_FILE) : null;
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    t.after(() => {
      if (previous === null) fs.rmSync(CONFIG_FILE, { force: true });
      else fs.writeFileSync(CONFIG_FILE, previous);
    });
    fs.writeFileSync(CONFIG_FILE, validConfig);
    const f = routerFixture(t, { poolSize: 2 });
    f.dependencies.readConfig = readZylosConfigStrict;
    f.deps.readSessionMode = readSessionMode;
    const origin = f.add('system');
    const inbound = f.add('inbound');
    const previousRun = f.add('continuation');
    f.sqlite.prepare("UPDATE conversations SET status='delivered' WHERE id=?").run(previousRun.id);
    f.db.recordRunEnd('continuation', { runId: 'old-run', reason: 'unexpected' });
    fs.writeFileSync(CONFIG_FILE, source);
    const router = f.create();
    await router.initialize();
    await f.rounds(2);
    f.advance(5000);
    await f.rounds(4);
    const modeReadable = name === 'unsupported runtime';
    assert.equal(router.state.inert, !modeReadable);
    assert.equal(router.state.ready, modeReadable);
    assert.equal(f.calls.filter(row => row[0] === 'launch').length, 0);
    assert.equal(f.row(origin.id).status, 'pending');
    assert.equal(f.row(inbound.id).status, 'pending');
    assert.equal(f.db.listRunEndings(['continuation'])[0].continuationPending, 1);
    if (!modeReadable) assert.ok(f.events.some(event => event.event === 'config_unreadable'));

    fs.writeFileSync(CONFIG_FILE, validConfig);
    // Repeating initialize and ticking is intentionally insufficient to revive
    // the inert instance: initialization is memoized until service restart.
    await router.initialize();
    f.advance(5000);
    await f.rounds(8);
    const launches = f.calls.filter(row => row[0] === 'launch');
    if (!modeReadable) {
      assert.equal(router.state.inert, true);
      assert.equal(launches.length, 0);
      assert.equal(f.row(origin.id).status, 'pending');
      assert.equal(f.row(inbound.id).status, 'pending');
      assert.equal(f.db.listRunEndings(['continuation'])[0].continuationPending, 1);
    } else {
      assert.equal(router.state.inert, false);
      assert.equal(launches.length, 3);
      assert.deepEqual(launches.map(row => row[1].sessionGroup).sort(), ['continuation', 'inbound', 'origin']);
      assert.equal(f.row(origin.id).status, 'delivered');
      assert.equal(f.row(inbound.id).status, 'delivered');
      assert.equal(f.db.listRunEndings(['continuation'])[0].continuationPending, 0);
    }
  });
}
