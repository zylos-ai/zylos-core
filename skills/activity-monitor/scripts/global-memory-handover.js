import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { resolveCoreConfigModule } from '../../comm-bridge/scripts/core-config-loader.js';
import { appendInbox } from '../../zylos-memory/scripts/memory-append.js';
import { inboxSegmentName } from '../../zylos-memory/scripts/state-format.js';

const material = name => ['state.md', 'inbox.md', 'handoff.md'].includes(name) || inboxSegmentName.test(name);
const hash = text => createHash('sha256').update(text.replace(/\s/gu, '')).digest('hex');
// Published templates: Memory v5 (#53), onboarding (#291), scoped bootstrap,
// and the scoped state template with onboarding managed separately.
const templateHashes = new Set([
  'ffe8dd581b5f119e30645cfd4468973d425aed1b43a42c6c9ad69eb69972642b',
  '404226132c72d05e9a41c9230314ff89ec63110526af646177224c4c0f3eac1a',
  '3c960faf449077fade3e4e1642c8738b21f19206cd0959e4c14283b2f21d2a28',
  'f58d087fadd661a03cf0a81746d39252fbf3825e1e781f903d2169b82eac3e27',
]);
const error = (code, message) => Object.assign(new Error(message), { code });
const currentTemplatePath = () => path.resolve(path.dirname(resolveCoreConfigModule()), '../../templates/memory/state.md');

/** Filesystem recovery record only; this coordinator never mutates mode transitions or gates.
 * pending() is called inside admission's lifecycle queue. advance() takes that
 * same queue; callers already holding it use advanceLocked(). */
export class GlobalMemoryHandoverCoordinator {
  constructor({ db, zylosDir, readMode, readConfiguration = readMode, readRequests,
    legacyPresent, observe, serialize = operation => operation(), diagnostic = () => {},
    now = Date.now, fsImpl = fs, append = appendInbox, waitMs = 1000,
    readMaxConversationId = () => db.getMaxConversationId(),
  } = {}) {
    Object.assign(this, { db, zylosDir, readMode, readConfiguration, readRequests, legacyPresent,
      observe, serialize, diagnostic, now, io: fsImpl, append, waitMs, readMaxConversationId });
    this.memory = path.join(zylosDir, 'memory');
    this.root = path.join(this.memory, 'mode-switch');
  }

  stat(file) {
    try { return this.io.statSync(file); }
    catch (cause) { if (cause.code === 'ENOENT') return null; throw cause; }
  }

  entries(directory) {
    try { return this.io.readdirSync(directory); }
    catch (cause) { if (cause.code === 'ENOENT') return []; throw cause; }
  }

  materials() {
    return this.entries(this.memory).filter(material).sort().map(name => {
      const file = path.join(this.memory, name), stat = this.io.statSync(file);
      if (!stat.isFile()) throw error('EINVAL', 'Global memory material is not a regular file');
      return { name, mtime: Math.floor(stat.mtimeMs / 1000), nonempty: !!this.io.readFileSync(file, 'utf8').trim() };
    });
  }

  unfinished() {
    return this.entries(this.root).filter(name => /^gm-[\w.-]+$/.test(name) &&
      this.stat(path.join(this.root, name))?.isDirectory() &&
      !this.stat(path.join(this.root, name, 'previous', '_global', '.done'))).sort();
  }

  pending() { return this.unfinished().length > 0 || this.materials().some(file => file.nonempty); }

  event(event, id, extra = {}) {
    this.diagnostic({ event, session_group: 'origin', run_id: id, ...extra });
  }

  async advance() { return this.serialize(() => this.advanceLocked()); }

  async advanceLocked() {
    let id = null, step = 'check';
    try {
      if (!this.pending()) return;
      if (await this.db.getModeTransition()) return;
      const mode = await this.readMode();
      if (mode.keyPresent !== true || !['single', 'multi'].includes(mode.mode)) return;
      const legacy = await this.legacyPresent();
      if (legacy !== false) {
        if (legacy === true) return;
        throw error('INVALID_OBSERVATION', 'Legacy tmux observation is unknown');
      }
      if ((await this.readRequests()).some(row => row.reason === 'manual_restart')) return;
      if ((await this.db.listDrainFences()).some(row => ['manual_restart', 'delete'].includes(row.reason))) return;
      const scenes = await this.observe({ configuration: { ...await this.readConfiguration(), mode: mode.mode } });
      if (scenes.some(scene => scene.observationError)) throw error('INVALID_OBSERVATION', 'Unknown runtime observation');
      if (scenes.some(scene => scene.present && scene.sessionGroup === 'origin' && scene.sourceScope === undefined)) throw error('INVALID_OBSERVATION', 'Origin scope is unknown');
      if (scenes.some(scene => scene.present &&
        (scene.sessionGroup === null || scene.sessionGroup === 'origin' && scene.sourceScope === null))) return;
      id = this.unfinished()[0] ?? null;
      let plan;
      if (id && this.stat(path.join(this.root, id, 'plan.json'))) {
        step = 'read_plan';
        plan = JSON.parse(this.io.readFileSync(path.join(this.root, id, 'plan.json'), 'utf8'));
        this.validate(plan, id);
      } else {
        // A process can die after writing the atomic plan temporary but before
        // rename. It contains only an uncommitted plan, never moved material.
        if (id) for (const name of this.entries(path.join(this.root, id))) {
          if (/^plan\.json\.[0-9a-f]{16}\.tmp$/.test(name)) this.io.unlinkSync(path.join(this.root, id, name));
        }
        const files = this.materials();
        if (!files.some(file => file.nonempty)) {
          // Only an empty, pre-plan directory is safe to remove. Unknown
          // contents fail closed rather than discarding possible evidence.
          if (id) this.io.rmdirSync(path.join(this.root, id));
          return;
        }
        step = 'plan';
        if (!id) {
          const base = `gm-${new Date(this.now()).toISOString().replace(/[-:]/g, '')}`;
          id = base;
          for (let suffix = 1; this.stat(path.join(this.root, id)); suffix++) id = `${base}-${suffix}`;
        }
        plan = await this.plan(id, files);
        this.io.mkdirSync(path.join(this.root, id), { recursive: true });
        this.atomic(path.join(this.root, id, 'plan.json'), JSON.stringify(plan, null, 2) + '\n');
      }
      const archive = path.join(this.root, id, 'previous', '_global');
      step = 'archive';
      this.io.mkdirSync(archive, { recursive: true });
      for (const { name } of plan.files) {
        const source = path.join(this.memory, name), destination = path.join(archive, name);
        if (this.stat(source)) {
          if (this.stat(destination)) throw error('EEXIST', 'Global material and archive both exist');
          this.io.renameSync(source, destination);
        } else if (!this.stat(destination)?.isFile()) throw error('ENOENT', 'Planned material is missing');
      }
      step = 'template';
      if (plan.rule === 2) this.installTemplate(plan.template);
      step = 'append';
      if (plan.deliver || plan.dailyRecords) {
        await this.append({ kind: plan.deliver ? 'commitment' : 'fact', content: this.body(plan, archive),
          env: { ZYLOS_DIR: this.zylosDir, ZYLOS_SESSION_GROUP: 'origin' }, waitMs: this.waitMs });
      }
      step = 'enqueue';
      if (plan.deliver) await this.db.insertControl(`Please follow up on the global working-memory handover entry numbered ${id} in your inbox.`, {
        sessionGroup: 'origin', priority: 2, appendAckSuffix: false,
      });
      step = 'done';
      this.atomic(path.join(archive, '.done'), '');
      this.event('global_memory_handover', id, { files: plan.files.map(file => file.name),
        rule: plan.rule, deliver: plan.deliver, basis: plan.basis });
      return plan;
    } catch (cause) {
      this.event('global_memory_handover_failed', id, { step, code: cause.code ?? 'UNKNOWN' });
      return { failed: true, id, step, code: cause.code ?? 'UNKNOWN' };
    }
  }

  async plan(id, files) {
    const conversion = await this.db.getLastCompletedModeTransition({ memoryConversion: true });
    const installationTemplate = files.length === 1 && files[0].name === 'state.md' &&
      templateHashes.has(hash(this.io.readFileSync(path.join(this.memory, 'state.md'), 'utf8')));
    let rule = 3;
    if (conversion?.target_mode === 'multi' && !this.stat(path.join(this.root, conversion.run_id, 'previous', '_global', '.done')) &&
      files.every(file => file.mtime <= conversion.updated_at)) rule = 1;
    else if (installationTemplate) rule = 2;
    const plan = { version: 1, id, files: files.map(({ name, mtime }) => ({ name, mtime })), rule, deliver: rule === 3,
      basis: { conversionRunId: conversion?.run_id ?? null, conversionUpdatedAt: conversion?.updated_at ?? null },
      dailyRecords: this.entries(path.join(this.memory, 'sessions')).length > 0 };
    if (rule === 2) plan.template = this.io.readFileSync(currentTemplatePath(), 'utf8').replace('scope=*', 'scope=origin');
    if (plan.deliver && conversion?.target_mode === 'single') {
      plan.interval = { B: await this.db.getGlobalCoverageEnd(), M: await this.readMaxConversationId() };
      if (![plan.interval.B, plan.interval.M].every(value => Number.isSafeInteger(value) && value >= 0)) throw error('INVALID_DATA', 'Invalid C4 interval');
    }
    return plan;
  }

  validate(plan, id) {
    if (plan?.version !== 1 || plan.id !== id || ![1, 2, 3].includes(plan.rule) || plan.deliver !== (plan.rule === 3) ||
      !Array.isArray(plan.files) || !plan.files.length || plan.files.some(file => typeof file.name !== 'string' || !material(file.name)) ||
      new Set(plan.files.map(file => file.name)).size !== plan.files.length ||
      plan.rule === 2 && typeof plan.template !== 'string') throw error('INVALID_DATA', 'Invalid handover plan');
  }

  atomic(file, body) {
    const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
    try { this.io.writeFileSync(temporary, body, { mode: 0o600, flag: 'wx' }); this.io.renameSync(temporary, file); }
    finally { try { this.io.unlinkSync(temporary); } catch (cause) { if (cause.code !== 'ENOENT') throw cause; } }
  }

  installTemplate(body) {
    const file = path.join(this.memory, 'session-groups', 'origin', 'state.md');
    this.io.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      this.io.writeFileSync(temporary, body, { mode: 0o600, flag: 'wx' });
      try { this.io.linkSync(temporary, file); } catch (cause) { if (cause.code !== 'EEXIST') throw cause; }
    } finally { this.io.unlinkSync(temporary); }
  }

  body(plan, archive) {
    const daily = path.join(this.memory, 'sessions');
    if (!plan.deliver) return `Global memory handover ${plan.id}: daily records remain at ${JSON.stringify(daily)}; they were not moved. Read them when needed.`;
    return `Global memory handover ${plan.id}: archived at ${JSON.stringify(archive)}; files: ${JSON.stringify(plan.files.map(file => file.name))}. ` +
      `Daily records remain at ${JSON.stringify(daily)}; read when needed. Read all archived materials completely and verify actual progress before continuing. ` +
      'Record your own work in your own working memory; in multi use internal to relay other groups\' work to their threads, and in single take it over yourself. ' +
      (plan.interval ? `C4 interval (${plan.interval.B}, ${plan.interval.M}]: rows recorded under origin are covered by Origin\'s own Sync (already or subsequently); rows under other groups were not organized into Origin memory. Read original text by id when needed.` : '');
  }
}
