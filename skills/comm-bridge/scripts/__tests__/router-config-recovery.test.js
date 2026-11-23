import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { readConfigStrict } from '../../../../cli/lib/config-store.js';
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
