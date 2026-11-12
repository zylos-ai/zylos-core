import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import SharedDatabase from '../../skills/comm-bridge/scripts/sqlite-driver.js';
import { cleanupWebConsoleEnv } from './web-console-env.js';
import { removeWebConsoleRoute } from './web-console-route.js';
import { dashboardAccessAddress } from './dashboard-access.js';

const realOrRaw = file => { try { return fs.realpathSync(file); } catch { return file; } };
const under = (file, root) => file.startsWith(root + path.sep);

export function webConsoleProcesses(output, skillsDir) {
  const start = String(output).search(/(?:^|\n)\s*\[(?:\s*\{|\s*\])/);
  if (start < 0) throw Error('Invalid PM2 process list');
  const list = JSON.parse(String(output).slice(start).trim());
  if (!Array.isArray(list)) throw Error('Invalid PM2 process list');
  const roots = [path.resolve(skillsDir, 'web-console'), realOrRaw(path.resolve(skillsDir, 'web-console'))];
  return list.filter(row => {
    const script = row.pm2_env?.pm_exec_path;
    return row.name === 'web-console' && Number.isInteger(row.pm_id) && row.pm_id >= 0 &&
      typeof script === 'string' && path.isAbsolute(script) &&
      roots.some(root => under(script, root) || under(realOrRaw(script), root));
  });
}

export function inspectWebConsoleTasks(zylosDir, {Database} = {}) {
  const file = path.join(zylosDir, 'scheduler/scheduler.db');
  if (!fs.existsSync(file)) return [];
  const Driver = Database || SharedDatabase;
  const db = new Driver(file, {readonly:true, fileMustExist:true});
  try {
    return db.prepare("SELECT id FROM tasks WHERE reply_channel = 'web-console' OR session_component = 'web-console'").all().map(row => String(row.id));
  } finally { db.close(); }
}

export function webConsoleRemovalNotice({zylosDir, routed = false, dashboardUrl} = {}) {
  if (!dashboardUrl) try { dashboardUrl = dashboardAccessAddress({zylosDir,routed}).url; }
  catch { dashboardUrl = 'the configured Dashboard address (run zylos init to check access)'; }
  return `Web Console has been removed. Open Dashboard at ${dashboardUrl} and use its Origin conversation. Reset access with zylos dashboard reset-password. Old Web Console history remains in Conversations > External. /console/ is no longer provided.`;
}

/** Post-cutoff cleanup is deliberately warning-only and safe to run again. */
export async function finalizeWebConsoleRemoval({zylosDir, noCaddy = false, dashboardUrl, deferNotice = false, beforePm2Delete = () => {}} = {}, deps = {}) {
  const run = deps.run || execFileSync;
  const warnings = [];
  let pm2Changed = false;
  let residue = false;
  const step = async (name, fn) => {
    try { await fn(); }
    catch { warnings.push(`${name} could not be completed. Review this step manually and rerun zylos init.`); }
  };
  await step('Web Console PM2 cleanup', () => {
    const processes = webConsoleProcesses(run('pm2', ['jlist'], {encoding:'utf8', stdio:'pipe', timeout:10000}),
      path.join(zylosDir, '.claude/skills'));
    for (const row of processes) {
      residue = true;
      try {
        beforePm2Delete();
        run('pm2', ['delete', String(row.pm_id)], {stdio:'pipe', timeout:10000});
        pm2Changed = true;
        warnings.push(`Removed this instance's Web Console PM2 record (${row.pm_id}).`);
      } catch { warnings.push(`Remove this instance's Web Console PM2 record manually: pm2 delete ${row.pm_id}.`); }
    }
  });
  await step('Web Console skill backup', () => {
    const source = path.join(zylosDir, '.claude/skills/web-console');
    try { fs.lstatSync(source); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    residue = true;
    const parent = path.join(zylosDir, '.backup');
    fs.mkdirSync(parent, {recursive:true});
    const target = path.join(parent, `web-console-skill-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    fs.renameSync(source, target);
    warnings.push(`Moved the complete old Web Console skill to ${target}. Web Console data was preserved.`);
  });
  await step('Web Console Caddy cleanup', async () => {
    const result = await (deps.removeRoute || removeWebConsoleRoute)({zylosDir, noCaddy});
    warnings.push(...(result.warnings || []));
    residue ||= result.changed || !!result.warnings?.length;
  });
  await step('Web Console environment cleanup', () => {
    const result = (deps.cleanupEnv || cleanupWebConsoleEnv)(zylosDir);
    warnings.push(...result.messages);
    residue ||= result.state === 'changed' || result.state === 'manual';
  });
  await step('Web Console scheduler inspection', () => {
    const ids = (deps.inspectTasks || inspectWebConsoleTasks)(zylosDir);
    if (ids.length) {
      residue = true;
      warnings.push(`Scheduled tasks still target Web Console: ${ids.join(', ')}. Change their reply channel or session to Dashboard or IM.`);
    }
  });
  if (residue && !deferNotice) warnings.push(webConsoleRemovalNotice({zylosDir,dashboardUrl}));
  return {warnings, pm2Changed, ...(deferNotice ? {residue} : {})};
}
