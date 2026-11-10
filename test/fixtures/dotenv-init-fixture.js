import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// The parent supplies these private paths before config/init can capture them.
const { ZYLOS_DIR, SKILLS_DIR, CONFIG_DIR, COMPONENTS_DIR, LOCKS_DIR } = await import('../../cli/lib/config.js');
const { getCoreServiceNames, resetManagedState } = await import('../../cli/commands/init.js');
const cleanups = [];
const t = { after: fn => cleanups.push(fn) };
try {
  if (process.argv[2] === 'discovery') {
  const file = path.join(ZYLOS_DIR, '.env');
  const pm2 = path.join(ZYLOS_DIR, 'pm2');
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(pm2), false);
  assert.deepEqual(getCoreServiceNames(), []);
  fs.mkdirSync(pm2);
  const template = path.join(pm2, 'ecosystem.config.cjs');
  t.after(() => {
    delete createRequire(import.meta.url).cache[template];
    fs.rmSync(file, { force: true });
    fs.rmSync(pm2, { recursive: true, force: true });
  });
  fs.copyFileSync(fileURLToPath(new URL('../../templates/pm2/ecosystem.config.cjs', import.meta.url)), template);
  fs.writeFileSync(file, 'CODEX_BYPASS_PERMISSIONS=false\n');
  console.log('isolated init discovery', JSON.stringify({ template, root: ZYLOS_DIR, home: process.env.HOME, pm2: process.env.PM2_HOME, tmp: process.env.TMPDIR, tmux: 'not used', database: 'not used' }));
  assert.throws(() => getCoreServiceNames(), { code: 'MODULE_NOT_FOUND' });
  }
  else if (process.argv[2] === 'reset') {
  const file = path.join(ZYLOS_DIR, '.env');
  const pm2 = path.join(ZYLOS_DIR, 'pm2');
  const template = path.join(pm2, 'ecosystem.config.cjs');
  const managed = [SKILLS_DIR, CONFIG_DIR, COMPONENTS_DIR, LOCKS_DIR, pm2];
  assert.equal(fs.existsSync(SKILLS_DIR), false);
  assert.equal(fs.existsSync(file), false);
  for (const dir of [CONFIG_DIR, COMPONENTS_DIR, LOCKS_DIR, pm2]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'fixture-marker'), 'managed');
  }
  const content = 'CODEX_BYPASS_PERMISSIONS=false\n';
  fs.writeFileSync(file, content);
  fs.copyFileSync(fileURLToPath(new URL('../../templates/pm2/ecosystem.config.cjs', import.meta.url)), template);
  const preserved = ['memory', 'logs', 'workspace'].map(name => path.join(ZYLOS_DIR, name));
  for (const dir of preserved) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'fixture-marker'), 'user data');
  }
  const warn = console.warn;
  const warnings = [];
  t.after(() => {
    console.warn = warn;
    delete createRequire(import.meta.url).cache[template];
    fs.rmSync(file, { force: true });
    for (const dir of [...managed, ...preserved]) fs.rmSync(dir, { recursive: true, force: true });
  });
  console.log('isolated init reset', JSON.stringify({ template, managed, preserved, root: ZYLOS_DIR,
    home: process.env.HOME, pm2: process.env.PM2_HOME, tmp: process.env.TMPDIR,
    tmux: 'not used', database: 'not used' }));
  assert.throws(() => getCoreServiceNames(), { code: 'MODULE_NOT_FOUND' });
  console.warn = (...args) => warnings.push(args.join(' '));
  assert.doesNotThrow(() => resetManagedState());
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Could not read the Core service list; skipping pm2 delete/);
  assert.equal(warnings[0].includes('\n'), false);
  for (const dir of managed) assert.equal(fs.existsSync(dir), false, dir);
  assert.equal(fs.readFileSync(file, 'utf8'), content);
  for (const dir of preserved) assert.equal(fs.readFileSync(path.join(dir, 'fixture-marker'), 'utf8'), 'user data');
  }
  else throw new Error('Unknown init fixture mode');
} finally {
  for (const cleanup of cleanups.reverse()) cleanup();
}
