// Isolated scheduler installation for schedule page tests: a temporary HOME,
// ZYLOS_DIR, PM2_HOME, short TMPDIR and private tmux directory, with the
// repository's scheduler linked at the installed skill path. Nothing here reads
// or writes a live Zylos directory; every path is asserted to stay under root.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from '../../../comm-bridge/scripts/sqlite-driver.js';

const schedulerSource = fileURLToPath(new URL('../../../scheduler', import.meta.url));

export function scheduleEnv(t, { tz = 'Asia/Singapore', link = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wbs-'));
  const home = path.join(root, 'h');
  const zylosDir = path.join(home, 'zylos');
  const tmp = path.join(root, 't');
  const skills = path.join(zylosDir, '.claude', 'skills');
  for (const dir of [tmp, path.join(skills, 'telegram'), path.join(zylosDir, 'scheduler')]) fs.mkdirSync(dir, { recursive: true });
  if (link) fs.symlinkSync(schedulerSource, path.join(skills, 'scheduler'), 'dir');
  if (tz !== null) fs.writeFileSync(path.join(zylosDir, '.env'), `TZ=${tz}\n`);
  const env = { ...process.env, HOME: home, ZYLOS_DIR: zylosDir, PM2_HOME: path.join(home, '.pm2'),
    TMPDIR: tmp, TMUX_TMPDIR: tmp, TZ: 'UTC' };
  for (const key of ['TMUX', 'ZYLOS_SESSION_GROUP', 'ZYLOS_RUN_ID']) delete env[key];
  const dbPath = path.join(zylosDir, 'scheduler', 'scheduler.db');
  const cliPath = path.join(skills, 'scheduler', 'scripts', 'cli.js');
  for (const target of [home, zylosDir, env.PM2_HOME, tmp, dbPath, cliPath]) assert.ok(target.startsWith(root + path.sep));
  const readback = { root, HOME: env.HOME, ZYLOS_DIR: env.ZYLOS_DIR, PM2_HOME: env.PM2_HOME, TMPDIR: env.TMPDIR,
    TMUX_TMPDIR: env.TMUX_TMPDIR, TMUX: env.TMUX ?? null, database: dbPath };
  console.log(JSON.stringify({ scheduleFixture: readback }));
  const handles = [];
  t.after(() => {
    for (const db of handles) if (db.open) db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  /** Runs the real scheduler CLI as an agent would. */
  const agent = args => {
    const result = spawnSync(process.execPath, [cliPath, ...args, '--json'], { env, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.error, undefined);
    return JSON.parse(result.stdout);
  };
  const open = () => {
    const db = new Database(dbPath);
    handles.push(db);
    return db;
  };
  return { root, home, zylosDir, env, dbPath, cliPath, agent, open };
}

/** Workbench pack lookup with the same placeholder rule as the main i18n module. */
export function packTranslator(locale = 'zh') {
  const pack = JSON.parse(fs.readFileSync(new URL(`../../public/i18n/wb.${locale}.json`, import.meta.url), 'utf8'));
  return (key, params = {}) => {
    let text = pack[key] ?? key;
    for (const [name, value] of Object.entries(params)) text = text.replaceAll(`{${name}}`, value ?? '');
    return text;
  };
}
