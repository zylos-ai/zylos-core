import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { ZYLOS_DIR } from './config.js';
import { savePm2ProcessList } from './pm2-save.js';

const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const coreManaged = () => ({ success: false, error: 'core_managed', message: 'Dashboard is bundled with Core; use zylos upgrade --self.' });
const failure = (error, message) => ({ success: false, error, message });
const inside = (file, root) => file === root || (file && root && file.startsWith(root + path.sep));

// Resolve existing symlink ancestors even when the final script no longer exists.
function canonical(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return null;
  const resolved = path.resolve(file);
  try { return fs.realpathSync(resolved); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = path.dirname(resolved);
    return parent === resolved ? resolved : path.join(canonical(parent), path.basename(resolved));
  }
}
function registry(zylosDir) {
  const file = path.join(zylosDir, '.zylos/components.json');
  let bytes;
  try { bytes = fs.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const value = JSON.parse(bytes);
  if (!object(value) || (value.components && !object(value.components))) throw Error('Invalid registry');
  const entries = value.components || value;
  return { file, bytes, value, entries };
}
const runPm2 = (action, args = []) => execFileSync('pm2', [action, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000, maxBuffer: 8 * 1024 * 1024 });

function inspect(options, deps) {
  const zylosDir = options.zylosDir || ZYLOS_DIR;
  const record = registry(zylosDir);
  if (!record || !Object.hasOwn(record.entries, 'dashboard')) return { result: coreManaged() };
  const pm2 = deps.pm2 || runPm2;
  const entries = JSON.parse(pm2('jlist', []));
  if (!Array.isArray(entries)) throw Error('Invalid PM2 list');
  const protectedRoots = [canonical(path.join(zylosDir, '.claude/skills/dashboard')), canonical(path.join(options.packageRoot || PACKAGE_ROOT, 'skills/dashboard'))];
  const legacy = canonical(record.entries.dashboard?.skillDir);
  const distinct = legacy && !protectedRoots.some(root => inside(legacy, root) || inside(root, legacy));
  const removeServices = [], preserveServices = [], warnings = [];
  for (const entry of entries) {
    if (entry?.name !== 'zylos-dashboard') continue;
    const cwd = canonical(entry.pm2_env?.pm_cwd), script = canonical(entry.pm2_env?.pm_exec_path);
    const protectedService = protectedRoots.some(root => inside(cwd, root) || inside(script, root));
    if (!protectedService && distinct && cwd === legacy && inside(script, legacy) && Number.isInteger(entry.pm_id) && entry.pm_id >= 0) removeServices.push(entry.pm_id);
    else {
      preserveServices.push(entry.pm_id ?? null);
      warnings.push('Preserved a shared or unverified Dashboard service; its name alone does not establish standalone ownership.');
    }
  }
  return { record, pm2, zylosDir, result: { success: true, component: 'dashboard', removeServices, preserveServices, warnings, dataKept: true, coreKept: true } };
}

export function inspectDashboardRegistrationCleanup(options = {}, deps = {}) {
  try { return inspect(options, deps).result; }
  catch { return failure('dashboard_cleanup_failed', 'Cannot safely inspect Dashboard registration or PM2 services; no cleanup performed.'); }
}

export function cleanupDashboardRegistration(options = {}, deps = {}) {
  let temporary;
  let removedServices = [];
  try {
    const plan = inspect(options, deps);
    if (!plan.result.success) return plan.result;
    const { record, pm2, zylosDir, result } = plan;
    // Do not change running services while recovery owns the startup list.
    if (!savePm2ProcessList({ root: zylosDir, save: () => {}, log: () => {} })) return failure('upgrade_recovery_required', 'Resolve upgrade recovery before cleaning Dashboard registration.');
    for (const id of result.removeServices) {
      pm2('delete', [String(id)]);
      removedServices.push(id);
    }
    // Save even on retry when a previous attempt deleted a service but failed
    // to persist the list. Keep the registry marker until save succeeds.
    if (!savePm2ProcessList({ root: zylosDir, save: () => pm2('save', ['--force']), log: () => {} })) throw Error('Startup list protected');
    if (fs.readFileSync(record.file, 'utf8') !== record.bytes) throw Error('Registry changed during cleanup');
    delete record.entries.dashboard;
    temporary = record.file + '.' + randomUUID() + '.tmp';
    const mode = fs.statSync(record.file).mode & 0o777;
    fs.writeFileSync(temporary, JSON.stringify(record.value, null, 2) + '\n', { flag: 'wx', mode });
    fs.renameSync(temporary, record.file);
    temporary = undefined;
    return { ...result, removedServices, message: 'Removed standalone Dashboard registration. Core Dashboard, files and data retained.' };
  } catch {
    return { ...failure('dashboard_cleanup_failed', 'Dashboard cleanup did not complete. Some standalone services may already be removed; inspect PM2 and retry. Files and data were retained.'), removedServices };
  } finally {
    if (temporary) { try { fs.unlinkSync(temporary); } catch {} }
  }
}
