import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installTestChildGuard } from './test-child-guard.js';
import { cleanupTestPm2 } from './test-pm2-cleanup.js';

function isWithin(parent, target) {
  const relative = path.relative(parent, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

// Called by the runners before loading tests or spawning test workers. Override
// inherited live-instance paths; individual tests may set their own paths later.
export function createTestEnvironment() {
  const realHome = fs.realpathSync(os.userInfo().homedir);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-tests-'));
  const previous = { HOME: process.env.HOME, ZYLOS_DIR: process.env.ZYLOS_DIR, PM2_HOME: process.env.PM2_HOME };
  let cleaned = false;
  let restoreChildGuard;

  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    process.removeListener('exit', onExit);
    try {
      const current = process.env.ZYLOS_DIR;
      const resolved = current && (fs.existsSync(current) ? fs.realpathSync(current) : path.resolve(current));
      assert(!resolved || !isWithin(path.join(realHome, 'zylos'), resolved),
        'Test runner ZYLOS_DIR points at the live instance');
    } finally {
      try {
        cleanupTestPm2(root);
        fs.rmSync(root, { recursive: true, force: true });
      } finally {
        restoreChildGuard?.();
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    }
  }

  function onExit() {
    try {
      cleanup();
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    }
  }

  try {
    const home = path.join(root, 'home');
    // Keep the normal ~/zylos layout for home-relative hook/config paths.
    const zylos = path.join(home, 'zylos');
    fs.mkdirSync(home);
    fs.mkdirSync(zylos);
    assert(!isWithin(realHome, fs.realpathSync(home)), 'Test HOME must be outside the real home');
    assert(!isWithin(realHome, fs.realpathSync(zylos)), 'Test ZYLOS_DIR must be outside the real home');
    process.env.HOME = home;
    process.env.ZYLOS_DIR = zylos;
    process.env.PM2_HOME = path.join(home, '.pm2');
    assert.equal(os.homedir(), home, 'os.homedir() must use the isolated HOME');
    restoreChildGuard = installTestChildGuard();
    process.on('exit', onExit);
    return { root, cleanup };
  } catch (error) {
    restoreChildGuard?.();
    // Initialization may fail before the live inherited paths are replaced.
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
