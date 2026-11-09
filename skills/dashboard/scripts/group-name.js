#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from '../../comm-bridge/scripts/sqlite-driver.js';
import { Store } from '../src/lib/store.js';
import { inspectDatabase, TARGET_SCHEMA_VERSION } from '../src/lib/schema.js';
import { createDisplayNames } from '../src/lib/workbench/display-names.js';

const invalid = () => Object.assign(new Error('Invalid command arguments'), { code: 'INVALID_ARGS' });
export async function runGroupName(argv, { env = process.env, stdout = process.stdout, stderr = process.stderr,
  openStore = file => new Store(file), createNames = options => createDisplayNames(options) } = {}) {
  const json = argv.includes('--json'), args = argv.filter(arg => arg !== '--json');
  let store;
  try {
    const [command, ...values] = args;
    let options = {};
    if (command === 'list') {
      for (let index = 0; index < values.length; index++) {
        if (values[index] === '--unnamed' && !options.unnamed) options.unnamed = true;
        else if (values[index] === '--active' && options.activeSinceMs === undefined) {
          const match = /^(\d+)(d|h)$/.exec(values[++index] ?? '');
          const duration = match && Number(match[1]) * (match[2] === 'd' ? 86400000 : 3600000);
          if (!Number.isSafeInteger(duration) || duration <= 0) throw invalid();
          options.activeSinceMs = duration;
        } else throw invalid();
      }
    } else if (!(command === 'set' && values.length === 2 || ['get', 'clear'].includes(command) && values.length === 1)) throw invalid();
    const zylosDir = env.ZYLOS_DIR || path.join(env.HOME || os.homedir(), 'zylos');
    const file = path.join(env.ZYLOS_DATA_DIR || path.join(zylosDir, 'components', 'dashboard'), 'dashboard.db');
    if (!fs.existsSync(file)) throw Object.assign(new Error('Dashboard database not found'), { code: 'DATABASE_NOT_FOUND' });
    const check = new Database(file, { readonly: true, fileMustExist: true });
    let compatible = false;
    try { compatible = inspectDatabase(check).currentVersion === TARGET_SCHEMA_VERSION; }
    catch { /* Unsupported schema metadata or layout also requires an upgrade. */ }
    finally { check.close(); }
    if (!compatible) throw new Error('Dashboard requires an upgrade.');
    store = openStore(file);
    const names = createNames({ store, zylosDir });
    const data = command === 'set' ? names.setName(values[0], values[1], 'agent')
      : command === 'get' ? names.getName(values[0]) : command === 'clear' ? names.clearName(values[0], 'agent')
        : await names.listNames(options);
    stdout.write(json ? JSON.stringify({ ok: true, data }) + '\n' : JSON.stringify(data, null, 2) + '\n');
    return 0;
  } catch (cause) {
    const code = cause.code ?? 'COMMAND_FAILED';
    stderr.write(`Error [${code}]: ${cause.message}\n`);
    if (json) stdout.write(JSON.stringify({ ok: false, error: { code, message: cause.message } }) + '\n');
    return 1;
  } finally { store?.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runGroupName(process.argv.slice(2));
}
