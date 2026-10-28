import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderInstruction } from './runtime/assembler.mjs';
import { instructionPaths, readInstructionFormatVersion, CURRENT_INSTRUCTION_FORMAT_VERSION,
  hasSplitTransactionResidue, activateMigratedSplitInstructions } from './runtime/instruction-builder.js';
import { migrateClaudeMdToZylosMd } from './migrate.js';
import { loadInstructionCatalog, classifyInstructionBaseline, verifyInstructionConservation,
  createMigrationBackup, renderMigrationReport, migrationPromptPath, writeMigrationPrompt } from './instruction-migration.js';
import { desiredClaudeHooks, syncHooks, claimedHookBaseKeys, detectStopFailureSupport,
  syncTemplateModelSetting, syncTemplateSetting } from './sync-runtime-hooks.js';
import { removeLegacyDashboardHooks } from './upgrade-post-cutoff.js';
import { readConfigStrict } from './config-store.js';
import { commandExists } from './shell-utils.js';
import { installClaude, installCodex } from './runtime-setup.js';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

export async function prepareUpgradeRuntimeClis(ctx, {
  prepare, exists = commandExists, install = { claude: installClaude, codex: installCodex } } = {}) {
  const config = readConfigStrict(path.join(ctx.zylosDir, '.zylos/config.json'));
  if (config.state === 'error') throw config.error;
  const runtime = config.state === 'ok' ? config.config.runtime || 'claude' : 'claude';
  if (!['claude', 'codex'].includes(runtime)) throw Error('Unsupported preparation runtime');
  const prepareClis = prepare || (await import('../commands/init.js')).prepareInitRuntimeClis;
  const result = await prepareClis({
    exists,
    install: Object.fromEntries(['claude', 'codex'].map(runtime => [runtime, () => {
      return install[runtime]();
    }])),
  });
  if (!result || !Array.isArray(result.failed) || !Array.isArray(result.completed) ||
      result.failed.some(item => item.item === `${runtime}.cli`) || !result.completed.includes(`${runtime}.cli`)) {
    throw Object.assign(Error(`Runtime CLI preparation incomplete: ${result?.failed?.map(item => `${item.item}: ${item.message}`).join('; ') || 'invalid preparation result'}`),
      { code: 'RUNTIME_PREPARATION_INCOMPLETE' });
  }
  result.warnings = result.failed.map(item => `Optional runtime CLI ${item.item}: ${item.message}`);
  return result;
}

function readRegular(file, { optional = false } = {}) {
  try {
    // Preparation must not follow a user-controlled leaf outside the instance.
    if (!fs.lstatSync(file).isFile()) throw Error(`Expected regular preparation input: ${file}`);
    return fs.readFileSync(file);
  } catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
}

/** Render target-owned assets in private scratch space; never write live configuration. */
export function prepareUpgradeRuntime(ctx, {
  packageRoot = ctx.tempDir || PACKAGE_ROOT,
  homeDir = os.homedir(),
  generatedAt = new Date(),
  stopFailureSupported,
  detectStopFailure = detectStopFailureSupport,
  classifyBaseline = classifyInstructionBaseline,
  writePrompt = writeMigrationPrompt,
} = {}) {
  const zylosDir = path.resolve(ctx.zylosDir);
  const sourceRoot = path.resolve(packageRoot);
  const templatesDir = path.join(sourceRoot, 'templates');
  const config = readConfigStrict(path.join(zylosDir, '.zylos/config.json'));
  if (config.state === 'error') throw config.error;
  const runtime = config.state === 'ok' ? config.config.runtime || 'claude' : 'claude';
  if (!['claude', 'codex'].includes(runtime)) throw Error('Unsupported preparation runtime');
  const replacements = [];
  const warnings = [];
  const add = (relative, content, kind = 'instructions', id) => {
    replacements.push({ path: relative, content, kind, ...(id ? { id } : {}) });
  };
  const relative = file => path.relative(zylosDir, file);
  const promptRelative = relative(migrationPromptPath({ zylosDir }));
  // Publication supports replacement bytes; an empty hook retires stale instructions.
  const clearPendingPrompt = () => {
    if (readRegular(path.join(zylosDir, promptRelative), { optional: true }) !== null) add(promptRelative, '');
  };
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-upgrade-render-'));
  fs.chmodSync(scratch, 0o700);
  try {
    const version = readInstructionFormatVersion({ zylosDir });
    const claude = instructionPaths('claude', { zylosDir });
    if (version.valid && version.version > CURRENT_INSTRUCTION_FORMAT_VERSION) {
      warnings.push(`Instruction format ${version.version} is newer than this target; preserved`);
    } else {
      if (hasSplitTransactionResidue(zylosDir)) throw Error('Unresolved split instruction transaction; recover it before upgrade');
      const systems = {};
      for (const name of ['claude', 'codex']) {
        systems[name] = readRegular(path.join(templatesDir, `${name}-system.md`));
        add(relative(instructionPaths(name, { zylosDir }).systemPath), systems[name]);
      }
      add(relative(claude.onboardingPath), readRegular(path.join(templatesDir, 'onboarding.md')));
      add(relative(claude.assemblerPath), readRegular(path.join(sourceRoot, 'cli/lib/runtime/assembler.mjs')));
      const markerBytes = readRegular(claude.markerPath, { optional: true });
      if (markerBytes !== null) {
        const marker = JSON.parse(markerBytes);
        if (!marker || marker.schemaVersion !== 1) throw Error('Unsupported split instruction marker');
        const user = readRegular(claude.userPath);
        const userShadow = path.join(scratch, 'user.md');
        fs.writeFileSync(userShadow, user);
        for (const name of ['claude', 'codex']) {
          const paths = instructionPaths(name, { zylosDir });
          const systemShadow = path.join(scratch, `${name}-system.md`);
          fs.writeFileSync(systemShadow, systems[name]);
          const content = renderInstruction({ systemPath: systemShadow, userPath: userShadow, generatedAt })
            .replace(`system: ${systemShadow}\n`, `system: ${paths.systemPath}\n`)
            .replace(`user: ${userShadow}\n`, `user: ${paths.userPath}\n`);
          add(relative(paths.outputPath), content);
        }
        add(relative(claude.markerPath), JSON.stringify({ ...marker,
          refreshedAt: generatedAt.toISOString(), userSha256: hash(user) }, null, 2) + '\n');
        add('.zylos/instruction-format-version', `${CURRENT_INSTRUCTION_FORMAT_VERSION}\n`);
        clearPendingPrompt();
      } else {
        // The historical v0.4 migration is safe in scratch and conserves CLAUDE.md.
        if (readRegular(claude.userPath, { optional: true }) === null) {
          const oldClaude = readRegular(claude.outputPath, { optional: true });
          if (oldClaude !== null) {
            if (!Buffer.from(oldClaude.toString('utf8')).equals(oldClaude)) throw Error('Legacy CLAUDE.md is not valid UTF-8');
            fs.writeFileSync(path.join(scratch, 'CLAUDE.md'), oldClaude);
            migrateClaudeMdToZylosMd({ zylosDir: scratch, templatesDir });
            add('ZYLOS.md', readRegular(path.join(scratch, 'ZYLOS.md')));
          }
        }
        const originalBytes = readRegular(claude.userPath, { optional: true }) ??
          replacements.find(item => item.path === 'ZYLOS.md')?.content ?? null;
        let analysis;
        let conservation;
        if (originalBytes !== null) {
          const original = originalBytes.toString('utf8');
          // Classification is text-based; refuse lossy decoding before attribution.
          if (!Buffer.from(original).equals(originalBytes)) throw Error('Legacy ZYLOS.md is not valid UTF-8');
          let catalog;
          try {
            catalog = loadInstructionCatalog({ catalogPath: path.join(sourceRoot, 'data/instruction-baselines/manifest.json') });
            analysis = classifyBaseline({ original, catalog });
          } catch (error) {
            warnings.push(`Automatic instruction classification unavailable: ${error.message}`);
          }
          if (analysis?.classification === 'A') {
            conservation = verifyInstructionConservation({ strippedContent: analysis.strippedContent,
              userContent: '', catalog, matched: analysis.matched });
            if (!conservation.ok) throw Error(`Automatic instruction conservation refused: ${conservation.reason}`);
          }
        }
        if (analysis?.classification === 'A') {
          const migrationRoot = path.join(scratch, 'migration');
          fs.mkdirSync(migrationRoot);
          for (const name of ['ZYLOS.md', 'CLAUDE.md', 'AGENTS.md']) {
            const bytes = name === 'ZYLOS.md' ? originalBytes : readRegular(path.join(zylosDir, name), { optional: true });
            if (bytes !== null) fs.writeFileSync(path.join(migrationRoot, name), bytes);
          }
          const user = readRegular(path.join(templatesDir, 'ZYLOS.md'));
          const report = renderMigrationReport({ classification: 'A', matched: conservation.matched,
            candidates: analysis.candidates, managedBlocks: analysis.managedBlocks, userContent: user.toString('utf8'),
            originalSha256: hash(originalBytes), attributionBaseline: conservation.attributionBaseline,
            attribution: conservation.attribution, backupPath: '__BACKUP_PATH__' });
          const backup = createMigrationBackup({ zylosDir: migrationRoot, report, now: generatedAt });
          const backupRelative = path.relative(migrationRoot, backup.backupPath);
          const liveBackup = path.join(zylosDir, backupRelative);
          if (fs.existsSync(liveBackup)) throw Error('Instruction migration backup destination already exists');
          const migrationMeta = { classification: 'A', matchedTemplate: conservation.matched ? {
            sha256: conservation.matched.sha256, source: conservation.matched.sourceCommit } : null,
            attributionBaseline: conservation.attributionBaseline, originalSha256: hash(originalBytes),
            backupPath: liveBackup, migratedAt: generatedAt.toISOString() };
          activateMigratedSplitInstructions({ zylosDir: migrationRoot, templatesDir,
            assemblerSource: path.join(sourceRoot, 'cli/lib/runtime/assembler.mjs'),
            userContent: user.toString('utf8'), migrationMeta, now: generatedAt });
          // Publish verified originals before replacing either generated output or the marker.
          for (const name of fs.readdirSync(backup.backupPath)) {
            const bytes = readRegular(path.join(backup.backupPath, name));
            add(path.join(backupRelative, name), name === 'migration-report.md'
              ? bytes.toString('utf8').replaceAll(backup.backupPath, liveBackup) : bytes);
          }
          const seededIndex = replacements.findIndex(item => item.path === 'ZYLOS.md');
          if (seededIndex !== -1) replacements.splice(seededIndex, 1);
          add('ZYLOS.md', user);
          for (const name of ['CLAUDE.md', 'AGENTS.md']) {
            const shadow = instructionPaths(name === 'CLAUDE.md' ? 'claude' : 'codex', { zylosDir: migrationRoot });
            const live = instructionPaths(name === 'CLAUDE.md' ? 'claude' : 'codex', { zylosDir });
            add(name, readRegular(path.join(migrationRoot, name)).toString('utf8')
              .replace(`system: ${shadow.systemPath}\n`, `system: ${live.systemPath}\n`)
              .replace(`user: ${shadow.userPath}\n`, `user: ${live.userPath}\n`));
          }
          add(relative(claude.markerPath), readRegular(instructionPaths('claude', { zylosDir: migrationRoot }).markerPath));
          add('.zylos/instruction-format-version', `${CURRENT_INSTRUCTION_FORMAT_VERSION}\n`);
          clearPendingPrompt();
        } else {
          if (analysis && ['B', 'C'].includes(analysis.classification)) {
            try {
              const prompt = writePrompt({ zylosDir: scratch, analysis,
                originalSha256: hash(originalBytes), systemTemplatePath: claude.systemPath });
              add(promptRelative, readRegular(prompt.filePath));
            } catch (error) {
              warnings.push(`Could not prepare instruction migration prompt: ${error.message}`);
            }
          }
          warnings.push(`Split instruction migration is pending${analysis ? ` (classification ${analysis.classification})` : ''}; legacy generated files and existing ZYLOS.md preserved`);
        }
      }
    }

    const settingsBytes = readRegular(path.join(zylosDir, '.claude/settings.json'), { optional: true });
    let settings;
    try {
      settings = settingsBytes === null ? {} : JSON.parse(settingsBytes);
      if (!settings || Array.isArray(settings) || typeof settings !== 'object' ||
          settings.hooks !== undefined && (!settings.hooks || Array.isArray(settings.hooks) || typeof settings.hooks !== 'object')) {
        throw Error('Expected settings and hooks objects');
      }
    } catch (cause) { throw Object.assign(Error('Cannot prepare Claude settings', { cause }), { code: 'SETTINGS_UNREADABLE' }); }
    const healthSupported = stopFailureSupported ?? detectStopFailure();
    settings = removeLegacyDashboardHooks(settings, zylosDir);
    const existsWithStaged = file => replacements.some(item => path.join(zylosDir, item.path) === file) || fs.existsSync(file);
    syncHooks(settings, {}, { zylosDir, log: () => {}, claimedKeys: claimedHookBaseKeys({ zylosDir }),
      desiredHooks: desiredClaudeHooks({ zylosDir, existsSync: existsWithStaged, stopFailureSupported: healthSupported }) });
    const templateSettings = JSON.parse(readRegular(path.join(templatesDir, '.claude/settings.json')));
    if (templateSettings.statusLine) settings.statusLine = templateSettings.statusLine;
    else delete settings.statusLine;
    syncTemplateModelSetting({ templateSettings, installedSettings: settings,
      cfg: config.state === 'ok' ? config.config : {}, log: () => {} });
    for (const key of ['autoMemoryEnabled', 'autoDreamEnabled']) {
      syncTemplateSetting(key, { templateSettings, installedSettings: settings, log: () => {} });
    }
    add('.claude/settings.json', JSON.stringify(settings, null, 2) + '\n', 'claude_settings', 't02');

    const agentsRoot = path.join(sourceRoot, 'skills/zylos-memory/agents');
    if (!fs.lstatSync(agentsRoot).isDirectory() || fs.lstatSync(agentsRoot).isSymbolicLink()) throw Error('Missing packaged Claude agent directory');
    const agents = fs.readdirSync(agentsRoot).filter(name => name.endsWith('.md')).sort();
    if (!agents.length) throw Error('No packaged Claude memory agents');
    for (const name of agents) {
      add(`.claude/agents/${name}`, readRegular(path.join(agentsRoot, name)));
    }
    // P02 already attaches memory MCP per launch. Preserve that gate and verify
    // the installed target actually ships its server, without launching a runtime.
    readRegular(path.join(sourceRoot, 'skills/zylos-memory/scripts/memory-mcp-server.js'));
    const manifest = '.zylos/runtime-env.manifest';
    if (readRegular(path.join(zylosDir, manifest), { optional: true }) === null) {
      add(manifest, readRegular(path.join(templatesDir, 'runtime-env.manifest.example')));
    }
    return { replacements, runtime, homeDir: path.resolve(homeDir), warnings };
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}
