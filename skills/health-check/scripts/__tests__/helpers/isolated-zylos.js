import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const C4_CONFIG_URL = new URL('../../../../comm-bridge/scripts/c4-config.js', import.meta.url).href;
export const C4_DB_CLI = fileURLToPath(new URL('../../../../comm-bridge/scripts/c4-db.js', import.meta.url));

const inside = (parent, child) => {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

// A private HOME, ZYLOS_DIR, PM2_HOME and TMPDIR under one temporary root.
// Before returning, the database path C4 resolves with this environment is read
// back from C4's own config; the setup refuses to continue unless that path is
// inside the temporary root and outside the account's real Zylos directory.
export function createIsolatedZylos() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'hc-')));
  try {
    const home = join(root, 'h');
    const zylosDir = join(home, 'zylos');
    const pm2Home = join(root, 'p');
    const tmp = join(root, 't');
    for (const directory of [zylosDir, pm2Home, tmp]) mkdirSync(directory, { recursive: true });

    const env = Object.fromEntries(Object.entries(process.env)
      .filter(([key]) => !key.startsWith('ZYLOS_') && !key.startsWith('C4_') && key !== 'PM2_HOME'));
    Object.assign(env, { HOME: home, ZYLOS_DIR: zylosDir, PM2_HOME: pm2Home, TMPDIR: tmp });

    const probe = spawnSync(process.execPath, ['--input-type=module', '-e',
      `const { DB_PATH } = await import(${JSON.stringify(C4_CONFIG_URL)}); process.stdout.write(DB_PATH);`],
    { env, encoding: 'utf8', timeout: 10_000 });
    const dbPath = probe.stdout;
    const liveZylos = join(userInfo().homedir, 'zylos');
    if (probe.status !== 0 || dbPath !== join(zylosDir, 'comm-bridge', 'c4.db')
        || !inside(root, dbPath) || inside(liveZylos, dbPath)) {
      throw new Error(`Refusing to run: C4 database path is not isolated (${dbPath || 'unresolved'})`);
    }
    return {
      root, env, zylosDir, dbPath,
      cleanup: () => rmSync(root, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

export function c4Cli(env, args) {
  return spawnSync(process.execPath, [C4_DB_CLI, ...args], { env, encoding: 'utf8', timeout: 30_000 });
}
