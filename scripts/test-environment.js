import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function isWithin(parent, target) {
  const relative = path.relative(parent, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

// Called by the runners before loading tests or spawning test workers. Override
// inherited live-instance paths; individual tests may set their own paths later.
export function createTestEnvironment() {
  const realHome = fs.realpathSync(os.userInfo().homedir);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-tests-'));
  const previous = { HOME: process.env.HOME, ZYLOS_DIR: process.env.ZYLOS_DIR };
  let cleaned = false;

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
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(root, { recursive: true, force: true });
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
    const zylos = path.join(root, 'zylos');
    fs.mkdirSync(home);
    fs.mkdirSync(zylos);
    assert(!isWithin(realHome, fs.realpathSync(home)), 'Test HOME must be outside the real home');
    assert(!isWithin(realHome, fs.realpathSync(zylos)), 'Test ZYLOS_DIR must be outside the real home');
    process.env.HOME = home;
    process.env.ZYLOS_DIR = zylos;
    assert.equal(os.homedir(), home, 'os.homedir() must use the isolated HOME');
    process.on('exit', onExit);
    return { root, cleanup };
  } catch (error) {
    // Initialization may fail before the live inherited paths are replaced.
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
