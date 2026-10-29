import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ObserverCoordinator } from '../src/lib/observer-coordinator.js';

function fixture(t, config = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'observer-coordinator-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, 'config.json');
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return { directory, configPath };
}

function readConfig(configPath) {
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

test('concurrent install-and-enable requests coalesce and publish desired state after verification', async (t) => {
  const { configPath } = fixture(t, { untouched: true });
  let installs = 0;
  const installer = {
    async verify() { return { state: 'installed', binaryPath: '/managed/zellij', version: '0.45.1' }; },
    async install() {
      installs += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return this.verify();
    },
  };
  const coordinator = new ObserverCoordinator({ configPath, installer });
  const first = coordinator.installAndEnable();
  const second = coordinator.installAndEnable();
  assert.strictEqual(first, second);
  const result = await first;
  assert.equal(installs, 1);
  assert.equal(result.enabled, true);
  assert.equal(readConfig(configPath).observer.enabled, true);
  assert.equal(readConfig(configPath).untouched, true);
});

test('disable persists its fence before teardown and prevents first lease', async (t) => {
  const { configPath } = fixture(t, { observer: { enabled: true, generation: 1 } });
  let teardownObserved;
  const installer = {
    async verify() { return { state: 'installed', binaryPath: '/managed/zellij' }; },
  };
  const coordinator = new ObserverCoordinator({
    configPath,
    installer,
    teardown: async () => { teardownObserved = readConfig(configPath).observer; },
  });
  await coordinator.reconcileStartup();
  await coordinator.disable();
  assert.equal(teardownObserved.enabled, false);
  assert.equal(teardownObserved.teardownFence, true);
  await assert.rejects(coordinator.firstLease({ principalId: 'p' }), (error) => error?.code === 'observer_disabled');
});

test('a queued uninstall invalidates an in-flight install before publication', async (t) => {
  const { configPath } = fixture(t);
  let releaseDownload;
  const downloaded = new Promise((resolve) => { releaseDownload = resolve; });
  let reachedDownload;
  const didReachDownload = new Promise((resolve) => { reachedDownload = resolve; });
  let removals = 0;
  const installer = {
    async verify() { return { state: 'not_installed' }; },
    async install({ isCurrent }) {
      reachedDownload();
      await downloaded;
      if (!isCurrent()) {
        const error = new Error('obsolete');
        error.code = 'operation_obsolete';
        throw error;
      }
      throw new Error('late publication was not fenced');
    },
    async removeInstalledArtifacts() { removals += 1; return { state: 'not_installed' }; },
  };
  const coordinator = new ObserverCoordinator({ configPath, installer });
  const install = coordinator.installAndEnable();
  await didReachDownload;
  const uninstall = coordinator.uninstall();
  releaseDownload();
  await assert.rejects(install, (error) => error?.code === 'operation_obsolete');
  const result = await uninstall;
  assert.equal(result.state, 'not_installed');
  assert.equal(removals, 1);
  assert.deepEqual(readConfig(configPath).observer, {
    enabled: false,
    generation: 2,
    teardownFence: true,
    removalState: null,
    lastError: null,
  });
});

test('failed removal remains durably disabled and visible after coordinator restart', async (t) => {
  const { configPath } = fixture(t, { observer: { enabled: true, generation: 4 } });
  const installer = {
    async verify() { return { state: 'installed', binaryPath: '/managed/zellij' }; },
    async removeInstalledArtifacts() { throw new Error('busy'); },
  };
  const coordinator = new ObserverCoordinator({ configPath, installer });
  await coordinator.reconcileStartup();
  await assert.rejects(coordinator.uninstall(), (error) => error?.code === 'removal_failed');
  const saved = readConfig(configPath).observer;
  assert.equal(saved.enabled, false);
  assert.equal(saved.teardownFence, true);
  assert.equal(saved.removalState, 'failed');
  const restarted = new ObserverCoordinator({ configPath, installer, teardown: async () => {} });
  const status = await restarted.reconcileStartup();
  assert.equal(status.desired.removalState, 'failed');
  await assert.rejects(restarted.firstLease({}), (error) => error?.code === 'observer_disabled');
});

test('artifact publication survives config-enable failure as installed but not enabled', async (t) => {
  const { configPath } = fixture(t);
  fs.writeFileSync(configPath, '{ broken\n');
  let artifactPublished = false;
  const installer = {
    async install() { artifactPublished = true; return { state: 'installed', binaryPath: '/managed/zellij' }; },
    async verify() { return artifactPublished ? { state: 'installed', binaryPath: '/managed/zellij' } : { state: 'not_installed' }; },
  };
  const coordinator = new ObserverCoordinator({ configPath, installer });
  await assert.rejects(coordinator.installAndEnable(), (error) => error?.code === 'enable_persist_failed');
  assert.equal(artifactPublished, true);
  assert.equal(fs.readFileSync(configPath, 'utf8'), '{ broken\n');
});

test('history status checks fresh desired state and metadata without full verification', async t => {
  const { configPath } = fixture(t, { observer: { enabled: true } });
  let inspected = 0;
  const coordinator = new ObserverCoordinator({ configPath, installer: {
    async inspectInstallation() { inspected++; return { state: 'installed' }; },
    async verify() { throw new Error('history must not hash or execute artifact'); },
  } });
  assert.equal((await coordinator.historyStatus()).desired.enabled, true);
  fs.writeFileSync(configPath, JSON.stringify({ observer: { enabled: false } }));
  assert.equal((await coordinator.historyStatus()).desired.enabled, false);
  assert.equal(inspected, 2);
});

test('remembered agent size defaults, validates, and persists beside lifecycle state', async (t) => {
  const { configPath } = fixture(t, { untouched: true, observer: { enabled: true, generation: 3 } });
  const coordinator = new ObserverCoordinator({ configPath, installer: {} });
  assert.deepEqual(await coordinator.agentSize(), { cols: 120, rows: 50 });
  assert.deepEqual(await coordinator.saveAgentSize({ cols: 132, rows: 60 }), { cols: 132, rows: 60 });
  assert.deepEqual(await coordinator.agentSize(), { cols: 132, rows: 60 });
  const saved = readConfig(configPath);
  assert.deepEqual(saved.observer, { enabled: true, generation: 3, agentSize: { cols: 132, rows: 60 } });
  assert.equal(saved.untouched, true);

  for (const agentSize of [{ cols: 10, rows: 50 }, { cols: 120, rows: 201 }, { cols: '120', rows: 50 }, 'large']) {
    fs.writeFileSync(configPath, JSON.stringify({ observer: { agentSize } }));
    assert.deepEqual(await coordinator.agentSize(), { cols: 120, rows: 50 });
  }
  fs.rmSync(configPath);
  assert.deepEqual(await coordinator.agentSize(), { cols: 120, rows: 50 });
});
