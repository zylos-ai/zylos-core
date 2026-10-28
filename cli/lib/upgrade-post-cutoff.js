import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { parse as parseToml } from 'smol-toml';
import { installCoreCodexHook } from './codex-hooks.js';
import { syncCodexConfig } from './sync-runtime-hooks.js';
import { readConfigStrict } from './config-store.js';

const maintenance = createRequire(import.meta.url)('./upgrade-maintenance.cjs');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const failure = (code, targetId, reason) => Object.assign(new Error(reason || code), { code, targetId, reason });

// Allow root aliases, but reject links within the publication tree.
function contained(root, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) ||
      relative.split(/[\\/]/).some(p => !p || p === '.' || p === '..')) throw Error('unsafe publication path');
  const base = path.resolve(root);
  let current = base;
  for (const component of relative.split('/')) {
    current = path.join(current, component);
    try { if (fs.lstatSync(current).isSymbolicLink()) throw Error('symlink publication path'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return path.join(base, relative);
}

function syncDir(dir) {
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function atomicBytes(file, bytes, onWrite = () => {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
  onWrite();
  syncDir(path.dirname(file));
}

function existing(file) {
  try {
    if (!fs.lstatSync(file).isFile()) throw Error('publication target is not a regular file');
    return fs.readFileSync(file);
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export function dashboardHookCommands(zylosDir) {
  const script = path.join(zylosDir, '.claude', 'skills', 'dashboard', 'src', 'lib', 'hook-ingest.cjs');
  return new Set([`node ${script}`, `ZYLOS_RUNTIME=codex ZYLOS_DIR=${zylosDir} node ${script}`]);
}

export function removeLegacyDashboardHooks(config, zylosDir) {
  const next = structuredClone(config);
  const commands = dashboardHookCommands(zylosDir);
  if (Array.isArray(next)) return next.filter(h => !commands.has(h?.command));
  for (const [event, groups] of Object.entries(next.hooks || {})) {
    if (!Array.isArray(groups)) continue;
    next.hooks[event] = groups.map(group => Array.isArray(group?.hooks)
      ? { ...group, hooks: group.hooks.filter(h => !commands.has(h?.command)) } : group)
      .filter(group => !Array.isArray(group?.hooks) || group.hooks.length);
    if (!next.hooks[event].length) delete next.hooks[event];
  }
  return next;
}

/** Stage already-rendered P06 instruction/settings bytes without writing shared files. */
export function preparePostCutoff({ transactionDir, zylosDir, replacements, runtime = 'claude', homeDir = os.homedir(), ordinary = false }) {
  const codexGlobalDir = path.join(path.resolve(homeDir), '.codex');
  const targets = [];
  const add = (root, relative, kind, content, id) => {
    const file = contained(root === 'zylos' ? zylosDir : codexGlobalDir, relative);
    if (targets.some(t => path.resolve(t.root === 'zylos' ? zylosDir : codexGlobalDir, t.path) === file)) return;
    const before = existing(file);
    const beforeFile = before === null ? null : `${ordinary ? 'runtime-preparation' : 'post-cutoff'}/before/${root}/${relative}`;
    if (beforeFile) atomicBytes(contained(transactionDir, beforeFile), before);
    const stagedFile = content === undefined ? null : `runtime-preparation/final/${root}/${relative}`;
    const bytes = content === undefined ? null : Buffer.from(content);
    if (stagedFile) atomicBytes(contained(transactionDir, stagedFile), bytes);
    targets.push({ id, order: targets.length + 1, root, path: relative, kind,
      rule: stagedFile ? 'replace' : 'reconcile_091', stagedFile,
      stagedSha256: bytes === null ? null : digest(bytes), beforeExists: before !== null,
      beforeFile, beforeSha256: before === null ? null : digest(before) });
  };
  let instructionIndex = 0;
  for (const replacement of replacements) {
    const kind = replacement.kind || 'instructions';
    const id = kind === 'claude_settings' ? 't02' : (++instructionIndex === 1 ? 't01' : `t01-${instructionIndex}`);
    add('zylos', replacement.path, kind, replacement.content, replacement.id || id);
  }
  if (runtime === 'codex' || fs.existsSync(path.join(codexGlobalDir, 'config.toml')) || fs.existsSync(path.join(codexGlobalDir, 'auth.json'))) {
    add('zylos', '.codex/hooks.json', 'codex_hooks', undefined, 't03');
    add('zylos', '.codex/config.toml', 'codex_toml', undefined, 't04');
    add('codexGlobal', 'config.toml', 'codex_toml', undefined, 't05');
  }
  // Persist all newly created directory entries before the caller commits cutoff.
  const flush = dir => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) flush(path.join(dir, e.name)); syncDir(dir); };
  for (const relative of ['post-cutoff', 'runtime-preparation']) {
    const dir = path.join(transactionDir, relative);
    if (fs.existsSync(dir)) flush(dir);
  }
  syncDir(transactionDir);
  return { formatVersion: 1, items: { hooks: { state: 'pending', attempts: 0, lastError: null, codexGlobalDir, warnings: [], targets } } };
}

export function validatePostCutoff({ transactionDir, journal }) {
  const postCutoff = journal.postCutoff;
  const hooks = postCutoff?.items?.hooks;
  if (postCutoff?.formatVersion !== 1 || !hooks || !['pending', 'failed', 'done'].includes(hooks.state) ||
      !Number.isSafeInteger(hooks.attempts) || hooks.attempts < 0 || !Array.isArray(hooks.targets) ||
      !path.isAbsolute(hooks.codexGlobalDir || '') || path.basename(hooks.codexGlobalDir) !== '.codex') throw Error('invalid publication manifest');
  const ids = new Set(), files = new Set();
  let sawReconcile = false;
  return hooks.targets.map((target, index) => {
    if (!target || typeof target.id !== 'string' || ids.has(target.id) || target.order !== index + 1 ||
        !['zylos', 'codexGlobal'].includes(target.root) || !['replace', 'reconcile_091'].includes(target.rule) ||
        typeof target.beforeExists !== 'boolean') throw Error('invalid publication target');
    ids.add(target.id);
    if (target.rule === 'replace') {
      if (sawReconcile || !['instructions', 'claude_settings'].includes(target.kind) || target.root !== 'zylos') throw Error('invalid replacement target');
    } else {
      sawReconcile = true;
      const shape = target.kind === 'codex_hooks' ? target.root === 'zylos' && target.path === '.codex/hooks.json' :
        target.kind === 'codex_toml' && (target.root === 'zylos' && target.path === '.codex/config.toml' || target.root === 'codexGlobal' && target.path === 'config.toml');
      if (!shape) throw Error('invalid Codex target');
    }
    const file = contained(target.root === 'zylos' ? journal.zylosDir : hooks.codexGlobalDir, target.path);
    if (files.has(file)) throw Error('duplicate publication target');
    files.add(file);
    const material = (relative, hash) => {
      if (!/^[a-f0-9]{64}$/.test(hash || '')) throw Error('invalid publication hash');
      const bytes = existing(contained(transactionDir, relative));
      if (bytes === null || digest(bytes) !== hash) throw Error('publication material missing or corrupt');
      return bytes;
    };
    const before = target.beforeExists ? material(target.beforeFile, target.beforeSha256) : null;
    if (!target.beforeExists && (target.beforeFile !== null || target.beforeSha256 !== null)) throw Error('invalid absent publication input');
    const staged = target.rule === 'replace' ? material(target.stagedFile, target.stagedSha256) : null;
    if (target.rule === 'reconcile_091' && (target.stagedFile !== null || target.stagedSha256 !== null)) throw Error('invalid reconcile input');
    return { target, file, before, staged };
  });
}

// Keep the existing writer and its Core TOML rendering; provide its historical
// runtime qualification/result policy at this protected publication boundary.
function reconcileCodexConfig({ projectDir, homeDir, onWrite }) {
  const config = readConfigStrict(path.join(projectDir, '.zylos', 'config.json'));
  if (config.state === 'error') throw config.error;
  const runtime = config.state === 'ok' ? config.config.runtime : 'claude';
  const globalDir = path.join(homeDir, '.codex');
  if (runtime !== 'codex' && !fs.existsSync(path.join(globalDir, 'config.toml')) && !fs.existsSync(path.join(globalDir, 'auth.json'))) return { attempted: false };
  // The reused 0.9.1 writer resolves os.homedir internally. Refuse a moved
  // account rather than letting resume redirect the captured global target.
  if (path.resolve(homeDir) !== path.resolve(os.homedir())) throw Error('captured Codex home no longer matches writer home');
  const result = syncCodexConfig({ projectDir, homeDir, onWrite, log: () => {} });
  return runtime !== 'codex' && result.fatal ? { ...result, fatal: false, warning: true } : result;
}

export async function publishPostCutoff(ctx, options = {}) {
  if (ctx.journal.transactionId !== ctx.transactionId || maintenance.classifyCutoff(ctx.journal) !== 'closed') {
    throw failure('CUTOFF_UNTRUSTED', undefined, 'publication requires verified cutoff identity');
  }
  return publishPrepared(ctx, options);
}

/** The same file reconciliation, with results held only in this invocation. */
export async function publishRuntimePreparation({ workDir, zylosDir, preparation }, options = {}) {
  const state = {zylosDir, postCutoff: preparation};
  return publishPrepared({transactionDir:workDir, journal:state}, {
    ...options, persist: (current, changes) => Object.assign(current, changes)
  });
}

async function publishPrepared(ctx, { installHook = installCoreCodexHook,
  syncConfig = reconcileCodexConfig, persist = (journal, changes) => (ctx.maintenance ?? maintenance).update(ctx.transactionDir, journal, changes),
  // DM-56d crash-injection boundary; production keeps the default no-op.
  afterStep = () => {} } = {}) {
  const journal = ctx.journal;
  const hooks = journal.postCutoff?.items?.hooks;
  const writtenTargets = new Set();
  const recordWrite = targetId => {
    writtenTargets.add(targetId);
    ctx.persisted?.add(targetId);
    ctx.recordPersisted?.(targetId);
  };
  const result = values => ({ ...values, writtenTargets: [...writtenTargets] });
  const save = changes => {
    const postCutoff = { ...journal.postCutoff, items: { ...journal.postCutoff.items, hooks: { ...hooks, ...changes } } };
    persist(journal, { postCutoff });
    Object.assign(hooks, changes);
  };
  let entries;
  try { entries = validatePostCutoff(ctx); }
  catch (error) {
    const lastError = { code: 'material_corrupt', reason: error.message };
    if (hooks && hooks.state !== 'done') save({ state: 'failed', lastError, warnings: [] });
    return result({ ok: false, state: hooks?.state, lastError, warnings: hooks?.warnings || [] });
  }
  const fail = error => {
    const lastError = { code: error.code || 'codex_config_reconcile_failed', ...(error.targetId ? { targetId: error.targetId } : {}), reason: error.reason || error.message };
    if (hooks.state !== 'done') save({ state: 'failed', lastError, warnings: [] });
    return result({ ok: false, state: hooks.state, lastError, warnings: hooks.warnings || [] });
  };
  try {
    if (hooks.state === 'done') {
      for (const e of entries.filter(e => e.target.rule === 'replace')) {
        const current = existing(e.file);
        if (current === null || !current.equals(e.staged)) throw failure('runtime_config_conflict', e.target.id);
      }
      return result({ ok: true, state: 'done', warnings: hooks.warnings });
    }
    save({ state: 'pending', attempts: hooks.attempts + 1, lastError: null, warnings: [] });
    for (const e of entries.filter(e => e.target.rule === 'replace')) {
      const current = existing(e.file);
      if (current !== null && current.equals(e.staged)) continue;
      if (!(current === null ? e.before === null : e.before !== null && current.equals(e.before))) throw failure('runtime_config_conflict', e.target.id);
      atomicBytes(e.file, e.staged, () => recordWrite(e.target.id));
      await afterStep(e.target.id);
    }
    const reconcile = entries.filter(e => e.target.rule === 'reconcile_091');
    const warnings = [];
    if (reconcile.length) {
      for (const e of reconcile) {
        try { const bytes = existing(e.file); if (bytes !== null) (e.target.kind === 'codex_hooks' ? JSON.parse : parseToml)(bytes.toString()); }
        catch (error) { throw failure('codex_config_unparseable', e.target.id, error.message); }
      }
      const hook = reconcile.find(e => e.target.kind === 'codex_hooks');
      try {
        if (hook && existing(hook.file) !== null) {
          const original = JSON.parse(fs.readFileSync(hook.file, 'utf8'));
          const cleaned = removeLegacyDashboardHooks(original, journal.zylosDir);
          if (JSON.stringify(original) !== JSON.stringify(cleaned)) {
            atomicBytes(hook.file, JSON.stringify(cleaned, null, 2) + '\n', () => recordWrite(hook.target.id));
          }
        }
        await afterStep('dashboard_hooks_removed');
        installHook({ zylosDir: journal.zylosDir, onWrite: () => recordWrite(hook.target.id) });
        await afterStep('codex_hook_installed');
      } catch (error) { throw failure('codex_config_reconcile_failed', 't03', error.message); }
      let configResult;
      try { configResult = syncConfig({ projectDir: journal.zylosDir, homeDir: path.dirname(hooks.codexGlobalDir),
        onWrite: file => { const entry = reconcile.find(e => path.resolve(e.file) === path.resolve(file)); if (entry) recordWrite(entry.target.id); } }); }
      catch (error) { throw failure('codex_config_reconcile_failed', 't04', error.message); }
      if (!configResult || configResult.fatal || configResult.attempted !== true) throw failure('codex_config_reconcile_failed', 't04', configResult?.attempted === false ? 'codex_state_changed' : configResult?.error || 'invalid Codex sync result');
      if (configResult.warning || configResult.error) for (const e of reconcile.filter(e => e.target.kind === 'codex_toml')) warnings.push({ targetId: e.target.id, code: 'codex_config_refresh_warning', error: configResult.error || 'Codex configuration refresh warning' });
      await afterStep('codex_config_synced');
    }
    await afterStep('before_done');
    save({ state: 'done', lastError: null, warnings });
    return result({ ok: true, state: 'done', warnings });
  } catch (error) { return fail(error); }
}
