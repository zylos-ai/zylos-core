import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ZYLOS_DIR } from './config.js';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const coreManaged = () => ({ success: false, error: 'core_managed', message: 'Dashboard is bundled with Core; use zylos upgrade --self.' });
const failure = () => ({ success: false, error: 'dashboard_cleanup_failed', message: 'Cannot safely read or update Dashboard registration; files and data were retained.' });
const manualCleanup = 'If you moved the installation directory or manually edited registration, use pm2 delete to remove processes at the old path manually.';

function registry(zylosDir) {
  const file = path.join(zylosDir, '.zylos/components.json');
  let bytes;
  try { bytes = fs.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const value = JSON.parse(bytes);
  if (!object(value) || (value.components && !object(value.components))) throw Error('Invalid registry');
  const entries = value.components || value;
  return { file, value, entries };
}

function inspect(options) {
  const record = registry(options.zylosDir || ZYLOS_DIR);
  if (!record || !Object.hasOwn(record.entries, 'dashboard')) return { result: coreManaged() };
  return { record, result: { success: true, component: 'dashboard', dataKept: true, coreKept: true, manualCleanup } };
}

export function inspectDashboardRegistrationCleanup(options = {}) {
  try { return inspect(options).result; }
  catch { return failure(); }
}

export function cleanupDashboardRegistration(options = {}) {
  let temporary;
  try {
    const { record, result } = inspect(options);
    if (!result.success) return result;
    delete record.entries.dashboard;
    temporary = record.file + '.' + randomUUID() + '.tmp';
    const mode = fs.statSync(record.file).mode & 0o777;
    fs.writeFileSync(temporary, JSON.stringify(record.value, null, 2) + '\n', { flag: 'wx', mode });
    // chmod also preserves permissions that the process umask would remove.
    fs.chmodSync(temporary, mode);
    fs.renameSync(temporary, record.file);
    temporary = undefined;
    return { ...result, message: 'Removed standalone Dashboard registration. Data and built-in Dashboard retained. Next run zylos upgrade --self.' };
  } catch { return failure(); }
  finally {
    if (temporary) { try { fs.unlinkSync(temporary); } catch {} }
  }
}
