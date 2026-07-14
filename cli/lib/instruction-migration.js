import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { hookScriptKey } from './hook-utils.js';
import {
  canonicalAssemblerEntry,
  reconcileAssemblerEntries,
} from './sync-settings-hooks.js';
import {
  activateMigratedSplitInstructions,
  hasSplitTransactionResidue,
  writeInstructionFormatVersion,
} from './runtime/instruction-builder.js';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_CATALOG_PATH = path.join(PACKAGE_ROOT, 'data', 'instruction-baselines', 'manifest.json');
const CANONICAL_MATCHERS = ['startup', 'clear', 'compact'];
const OWNER_ATTRIBUTED_EMPTY_BASELINE = Object.freeze({
  sha256: crypto.createHash('sha256').update('').digest('hex'),
  content: '',
  kind: 'owner-attributed-empty-baseline',
});

export function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

export function migrationPromptPath({ zylosDir } = {}) {
  return path.join(path.resolve(zylosDir), '.zylos', 'pending-migration-prompt.md');
}

export function cleanupMigrationPrompt({ zylosDir, io = {} } = {}) {
  const filePath = migrationPromptPath({ zylosDir });
  const existsSync = io.existsSync ?? fs.existsSync;
  const unlinkSync = io.unlinkSync ?? fs.unlinkSync;
  if (!existsSync(filePath)) return { removed: false, filePath, error: null };
  try {
    unlinkSync(filePath);
    return { removed: true, filePath, error: null };
  } catch (error) {
    return { removed: false, filePath, error };
  }
}

export function writeMigrationPrompt({ zylosDir, analysis, originalSha256, io = {} } = {}) {
  const filePath = migrationPromptPath({ zylosDir });
  const candidates = (analysis?.candidates ?? []).slice(0, 5);
  const lines = [
    '# Pending instruction migration',
    '',
    `- Classification: ${analysis?.classification ?? 'C'}`,
    `- Original ZYLOS.md SHA-256: ${originalSha256 ?? '(unknown)'}`,
    '',
    '## Candidate baselines',
    '',
    ...(candidates.length
      ? candidates.map(item => `- ${item.sha256} score=${Number(item.score).toFixed(4)} source=${item.sourceCommit}`)
      : ['- No reachable baseline candidates were found.']),
    '',
    '## Required action',
    '',
    '1. Read `~/zylos/ZYLOS.md` and compare it with the candidate baselines above.',
    '2. Separate Zylos-managed system instructions from content added by the user.',
    '3. Write only the user-owned content to a temporary file.',
    '4. Run `zylos migrate-instructions --apply --user-content <file>` with that file.',
    '',
  ];
  atomicWrite(filePath, lines.join('\n'), io);
  return { filePath };
}

export function loadInstructionCatalog({ catalogPath = DEFAULT_CATALOG_PATH } = {}) {
  const manifest = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.entries)) {
    throw new Error(`Unsupported instruction catalog: ${catalogPath}`);
  }
  return manifest.entries.map(entry => {
    const rawContent = Buffer.from(entry.contentBase64, 'base64').toString('utf8');
    return {
      ...entry,
      rawContent,
      content: stripManagedBlocks(rawContent).content,
    };
  });
}

function removeRange(content, start, end, kind, managedBlocks) {
  managedBlocks.push({ kind, content: content.slice(start, end) });
  return content.slice(0, start) + content.slice(end);
}

export function stripManagedBlocks(original) {
  let content = original;
  const managedBlocks = [];
  const migrationNoticeLines = [
    '<!-- MIGRATION NOTE (zylos v0.4.0): This file was created from your previous',
    '     CLAUDE.md. It may contain Claude-specific instructions. If you plan to',
    '     use Codex, review this file and remove any Claude-only rules before',
    '     switching runtimes via "zylos init --runtime codex". -->',
  ];
  for (const eol of ['\n', '\r\n']) {
    for (const suffix of [eol + eol, eol]) {
      const notice = migrationNoticeLines.join(eol) + suffix;
      if (content.startsWith(notice)) {
        content = removeRange(content, 0, notice.length, 'v0.4.0-migration-note', managedBlocks);
        break;
      }
    }
    if (managedBlocks.some(block => block.kind === 'v0.4.0-migration-note')) break;
  }

  const blockPatterns = [
    ['onboarding', /(^|\r?\n)<!-- zylos-managed:onboarding:begin -->[\s\S]*?<!-- zylos-managed:onboarding:end -->(?:\r?\n|$)/],
    ['runtime-portability', /(^|\r?\n)<!-- zylos-managed:runtime-portability:begin -->[\s\S]*?<!-- zylos-managed:runtime-portability:end -->(?:\r?\n|$)/],
  ];
  for (const [kind, pattern] of blockPatterns) {
    const beginMarker = `<!-- zylos-managed:${kind}:begin -->`;
    const endMarker = `<!-- zylos-managed:${kind}:end -->`;
    const firstBegin = content.indexOf(beginMarker);
    const secondBegin = firstBegin === -1 ? -1 : content.indexOf(beginMarker, firstBegin + beginMarker.length);
    const firstEnd = content.indexOf(endMarker, firstBegin + beginMarker.length);
    // Nested/overlapping markers are ambiguous. Leave the whole family in the
    // candidate so classification conservatively falls back to C.
    if (firstBegin !== -1 && secondBegin !== -1 && secondBegin < firstEnd) continue;
    let match;
    while ((match = content.match(pattern))) {
      const preservedPrefixLength = match[1]?.length ?? 0;
      content = removeRange(
        content,
        match.index + preservedPrefixLength,
        match.index + match[0].length,
        kind,
        managedBlocks,
      );
    }
  }

  const lines = content.match(/.*(?:\r\n|\n|$)/g)?.filter(Boolean) ?? [];
  content = lines.filter(line => {
    if (!/^\s*<!-- zylos-managed:runtime-portability -->\r?\n?$/.test(line)) return true;
    managedBlocks.push({ kind: 'runtime-portability-line', content: line });
    return false;
  }).join('');
  return { content, managedBlocks };
}

function similarity(left, right) {
  const a = new Set(left.split(/\r?\n/));
  const b = new Set(right.split(/\r?\n/));
  let common = 0;
  for (const line of a) if (b.has(line)) common++;
  return common / Math.max(1, new Set([...a, ...b]).size);
}

function pureAdditionResidual(original, baseline) {
  const source = tokens(original);
  const system = tokens(baseline);
  const residual = [];
  let index = 0;
  for (const line of source) {
    if (system[index] === line) index++;
    else residual.push(line);
  }
  return index === system.length ? residual.join('') : null;
}

export function classifyInstructionBaseline({ original, catalog, provenance = null }) {
  const stripped = stripManagedBlocks(original);
  const matched = catalog.find(entry => entry.content === stripped.content);
  const proven = provenance?.seedSha256
    ? catalog.find(entry => entry.sha256 === provenance.seedSha256)
    : null;
  const residual = !matched && proven ? pureAdditionResidual(stripped.content, proven.content) : null;
  const candidates = catalog
    .map(entry => ({ entry, score: similarity(stripped.content, entry.content) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(({ entry, score }) => ({
      sha256: entry.sha256,
      gitBlob: entry.gitBlob,
      sourceCommit: entry.sourceCommit,
      sourceTags: entry.sourceTags,
      paths: entry.paths,
      score,
    }));
  return {
    classification: matched ? 'A' : residual !== null ? 'B' : 'C',
    matched: matched ?? (residual !== null ? proven : null),
    candidates,
    strippedContent: stripped.content,
    managedBlocks: stripped.managedBlocks,
    residual,
  };
}

function tokens(content) {
  return content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function orderedInterleaveAttribution(original, baseline, user) {
  const source = tokens(original);
  const system = tokens(baseline);
  const custom = tokens(user);
  if (source.length !== system.length + custom.length) return null;
  const layers = [new Map([['0,0', null]])];
  for (const line of source) {
    const states = layers.at(-1);
    const next = new Map();
    for (const state of states.keys()) {
      const [i, j] = state.split(',').map(Number);
      if (system[i] === line) {
        const key = `${i + 1},${j}`;
        if (!next.has(key)) next.set(key, { previous: state, source: 'baseline', sourceOrdinal: i });
      }
      if (custom[j] === line) {
        const key = `${i},${j + 1}`;
        if (!next.has(key)) next.set(key, { previous: state, source: 'user', sourceOrdinal: j });
      }
    }
    if (next.size === 0) return null;
    layers.push(next);
  }
  let state = `${system.length},${custom.length}`;
  if (!layers.at(-1).has(state)) return null;
  const attribution = [];
  for (let index = source.length; index > 0; index--) {
    const step = layers[index].get(state);
    attribution.push({
      originalOrdinal: index - 1,
      source: step.source,
      sourceOrdinal: step.sourceOrdinal,
      lineSha256: sha256(source[index - 1]),
    });
    state = step.previous;
  }
  return attribution.reverse();
}

export function verifyInstructionConservation({ strippedContent, userContent, catalog, matched }) {
  // A known exact/proven baseline remains authoritative. For C-class content,
  // the catalog is deliberately non-exhaustive, so an owner may instead
  // attribute every non-managed occurrence to the user layer. The empty
  // baseline can only pass when userContent preserves the entire stripped
  // original byte-for-byte by ordered occurrence.
  const candidates = matched ? [matched] : [...catalog, OWNER_ATTRIBUTED_EMPTY_BASELINE];
  for (const entry of candidates) {
    const attribution = orderedInterleaveAttribution(strippedContent, entry.content, userContent);
    if (attribution) {
      const ownerAttributed = entry === OWNER_ATTRIBUTED_EMPTY_BASELINE;
      return {
        ok: true,
        matched: ownerAttributed ? null : entry,
        attributionBaseline: ownerAttributed
          ? { kind: entry.kind, sha256: entry.sha256 }
          : { kind: 'catalog', sha256: entry.sha256, sourceCommit: entry.sourceCommit },
        attribution,
      };
    }
  }
  return { ok: false, reason: 'original non-managed line occurrences are not an ordered interleave of baseline and user content' };
}

function atomicWrite(filePath, content, {
  writeFileSync = fs.writeFileSync,
  renameSync = fs.renameSync,
  existsSync = fs.existsSync,
  statSync = fs.statSync,
  chmodSync = fs.chmodSync,
  openSync = fs.openSync,
  fsyncSync = fs.fsyncSync,
  closeSync = fs.closeSync,
  unlinkSync = fs.unlinkSync,
} = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  const existingMode = existsSync(filePath) ? statSync(filePath).mode & 0o777 : null;
  let fd;
  try {
    writeFileSync(tempPath, content, 'utf8');
    if (existingMode !== null) chmodSync(tempPath, existingMode);
    fd = openSync(tempPath, 'r');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tempPath, filePath);
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { }
    try { unlinkSync(tempPath); } catch { }
  }
}

export function renderMigrationReport({
  classification,
  matched,
  candidates,
  backupPath,
  failure,
  managedBlocks = [],
  userContent,
  originalSha256,
  attributionBaseline,
  attribution = [],
}) {
  const lines = [
    '# Instruction migration report',
    '',
    `- Classification: ${classification}`,
    `- Backup: ${backupPath ?? '(dry-run)'}`,
    `- Matched template SHA-256: ${matched?.sha256 ?? '(none)'}`,
    `- Source commit: ${matched?.sourceCommit ?? '(none)'}`,
    `- Original SHA-256: ${originalSha256 ?? '(not recorded)'}`,
    `- User content SHA-256: ${typeof userContent === 'string' ? sha256(userContent) : '(not recorded)'}`,
  ];
  lines.push('', '## Attribution', '');
  lines.push(`- System baseline: ${attributionBaseline?.sha256 ?? matched?.sha256 ?? '(unresolved)'}`);
  lines.push(`- Baseline kind: ${attributionBaseline?.kind ?? (matched ? 'catalog' : '(unresolved)')}`);
  lines.push(`- Managed blocks removed: ${managedBlocks.length}`);
  for (const block of managedBlocks) lines.push(`  - ${block.kind}: ${sha256(block.content)}`);
  lines.push(`- User content: ${typeof userContent === 'string' ? `${tokens(userContent).length} line occurrence(s)` : '(not recorded)'}`);
  lines.push('', '### Occurrence edit script', '');
  for (const item of attribution) {
    lines.push(`- original[${item.originalOrdinal}] -> ${item.source}[${item.sourceOrdinal}] sha256=${item.lineSha256}`);
  }
  if (candidates?.length) {
    lines.push('', '## Candidate baselines', '');
    for (const item of candidates) lines.push(`- ${item.sha256} score=${item.score.toFixed(4)} source=${item.sourceCommit}`);
  }
  if (failure) {
    lines.push(
      '',
      '## Transaction failure',
      '',
      `- Primary error: ${failure.message}`,
      `- Recovery residue present: ${failure.residuePresent ? 'yes' : 'no'}`,
      '- Retry: rerun `zylos migrate-instructions --apply`; recovery preserves this durable backup.',
    );
  }
  return `${lines.join('\n')}\n`;
}

export function createMigrationBackup({ zylosDir, report, now = new Date(), faultInjector = () => {} }) {
  const timestamp = now.toISOString().replace(/[:.]/g, '-');
  const timestampRoot = path.join(zylosDir, '.backup', timestamp);
  let backupPath = path.join(timestampRoot, 'instruction-migration');
  let collision = 1;
  while (fs.existsSync(backupPath)) {
    backupPath = path.join(timestampRoot, `instruction-migration-${collision++}`);
  }
  const originals = ['ZYLOS.md', 'CLAUDE.md', 'AGENTS.md']
    .map(name => ({ name, source: path.join(zylosDir, name), target: path.join(backupPath, name) }))
    .filter(item => fs.existsSync(item.source));
  try {
    fs.mkdirSync(backupPath, { recursive: true });
    for (const item of originals) {
      faultInjector(`backup:copy:${item.name}`);
      fs.copyFileSync(item.source, item.target);
      faultInjector(`backup:verify:${item.name}`);
      if (sha256(fs.readFileSync(item.source)) !== sha256(fs.readFileSync(item.target))) {
        throw new Error(`backup verification failed: ${item.name}`);
      }
    }
    atomicWrite(path.join(backupPath, 'migration-report.md'), report.replaceAll('__BACKUP_PATH__', backupPath));
    return { backupPath, originals };
  } catch (error) {
    try { fs.rmSync(backupPath, { recursive: true, force: true }); } catch (cleanupError) {
      error.backupCleanupWarning = cleanupError;
      error.partialBackupPath = backupPath;
    }
    try { fs.rmdirSync(path.dirname(backupPath)); } catch { }
    throw error;
  }
}

function objectAt(value, jsonPath, expected, errors) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    errors.push({ type: 'schema-malformed', path: jsonPath, expected });
    return false;
  }
  return true;
}

export function inspectAssemblerTopology(settings, { zylosDir } = {}) {
  const anomalies = [];
  const states = {};
  if (!objectAt(settings, '$', 'object', anomalies)) return { anomalies, states, changed: false };
  if (settings.hooks !== undefined && !objectAt(settings.hooks, '$.hooks', 'object', anomalies)) return { anomalies, states, changed: false };
  const groups = settings.hooks?.SessionStart;
  if (groups !== undefined && !Array.isArray(groups)) {
    anomalies.push({ type: 'schema-malformed', path: '$.hooks.SessionStart', expected: 'array' });
    return { anomalies, states, changed: false };
  }
  const sessionGroups = groups ?? [];
  for (let gi = 0; gi < sessionGroups.length; gi++) {
    const group = sessionGroups[gi];
    if (!objectAt(group, `$.hooks.SessionStart[${gi}]`, 'object', anomalies)) continue;
    if (group.matcher !== undefined && typeof group.matcher !== 'string') {
      anomalies.push({ type: 'schema-malformed', path: `$.hooks.SessionStart[${gi}].matcher`, expected: 'string' });
    }
    if (group.hooks !== undefined && !Array.isArray(group.hooks)) {
      anomalies.push({ type: 'schema-malformed', path: `$.hooks.SessionStart[${gi}].hooks`, expected: 'array' });
      continue;
    }
    for (let hi = 0; hi < (group.hooks ?? []).length; hi++) {
      objectAt(group.hooks[hi], `$.hooks.SessionStart[${gi}].hooks[${hi}]`, 'object', anomalies);
    }
  }
  if (anomalies.length) return { anomalies, states, changed: false };

  const canonical = canonicalAssemblerEntry({ zylosDir });
  const assemblerKey = hookScriptKey(canonical.command);
  for (const matcher of CANONICAL_MATCHERS) {
    const matchingGroups = sessionGroups.filter(group => (group.matcher ?? '') === matcher);
    if (matchingGroups.length > 1) {
      anomalies.push({ type: 'duplicate-group', matcher, count: matchingGroups.length });
      continue;
    }
    const group = matchingGroups[0];
    if (!group) {
      states[matcher] = 'missing';
      continue;
    }
    const keyed = (group.hooks ?? [])
      .map((hook, index) => ({ hook, index }))
      .filter(({ hook }) => typeof hook.command === 'string' && hookScriptKey(hook.command) === assemblerKey);
    if (keyed.length > 1) {
      anomalies.push({ type: 'duplicate-entry', matcher, indexes: keyed.map(item => item.index) });
      continue;
    }
    if (keyed.length === 0) {
      states[matcher] = 'missing';
      continue;
    }
    const entry = keyed[0].hook;
    const keys = Object.keys(entry).sort();
    const canonicalKeys = Object.keys(canonical).sort();
    if (JSON.stringify(keys) !== JSON.stringify(canonicalKeys) || entry.type !== canonical.type) {
      const differences = [...new Set([...keys, ...canonicalKeys])]
        .sort()
        .filter(key => !Object.is(entry[key], canonical[key]))
        .map(key => ({ field: key, actual: entry[key], expected: canonical[key] }));
      anomalies.push({ type: 'same-key-manual', matcher, differences });
    } else if (
      entry.type === canonical.type
      && entry.command === canonical.command
      && entry.timeout === canonical.timeout
    ) {
      states[matcher] = keyed[0].index === 0 ? 'canonical' : 'canonical-needs-ordering';
    } else {
      states[matcher] = 'drift';
    }
  }

  for (let gi = 0; gi < sessionGroups.length; gi++) {
    const group = sessionGroups[gi];
    const matcher = group.matcher ?? '';
    if (CANONICAL_MATCHERS.includes(matcher)) continue;
    for (let hi = 0; hi < (group.hooks ?? []).length; hi++) {
      const hook = group.hooks[hi];
      if (typeof hook.command === 'string' && hookScriptKey(hook.command) === assemblerKey) {
        anomalies.push({ type: 'misplaced', matcher, groupIndex: gi, hookIndex: hi });
      }
    }
  }
  const changed = CANONICAL_MATCHERS.some(matcher => states[matcher] !== 'canonical');
  return { anomalies, states, changed };
}

export function convergeAssemblerTopology(settings, { zylosDir } = {}) {
  const before = inspectAssemblerTopology(settings, { zylosDir });
  if (before.anomalies.length) return { ...before, settings };
  const result = reconcileAssemblerEntries(settings, { zylosDir });
  const canonical = canonicalAssemblerEntry({ zylosDir });
  const assemblerKey = hookScriptKey(canonical.command);
  for (const group of settings.hooks.SessionStart) {
    if (!CANONICAL_MATCHERS.includes(group.matcher ?? '')) continue;
    const index = group.hooks.findIndex(hook => typeof hook.command === 'string' && hookScriptKey(hook.command) === assemblerKey);
    if (index > 0) group.hooks.unshift(group.hooks.splice(index, 1)[0]);
  }
  const after = inspectAssemblerTopology(settings, { zylosDir });
  if (after.anomalies.length || after.changed) {
    return { anomalies: [{ type: 'seam-postcondition', detail: after }], states: after.states, changed: false, settings };
  }
  return { anomalies: [], states: before.states, changed: before.changed || result.changed, settings };
}

export function reconcileAssemblerSettingsFile({
  zylosDir,
  apply = false,
  faultInjector = () => {},
  io = {},
} = {}) {
  const settingsPath = path.join(zylosDir, '.claude', 'settings.json');
  let original = '{}\n';
  try {
    const existsSync = io.existsSync ?? fs.existsSync;
    const readFileSync = io.readFileSync ?? fs.readFileSync;
    if (existsSync(settingsPath)) original = readFileSync(settingsPath, 'utf8');
  } catch (error) {
    return { ok: false, handledError: true, settingsPath, error, anomalies: [] };
  }
  let settings;
  try {
    settings = JSON.parse(original);
  } catch (error) {
    return { ok: false, refusal: true, settingsPath, anomalies: [{ type: 'malformed-json', message: error.message }] };
  }
  const preview = inspectAssemblerTopology(settings, { zylosDir });
  if (preview.anomalies.length) return { ok: false, refusal: true, settingsPath, ...preview };
  if (!apply) return { ok: true, dryRun: true, settingsPath, ...preview };
  const copy = structuredClone(settings);
  const convergence = convergeAssemblerTopology(copy, { zylosDir });
  if (convergence.anomalies.length) return { ok: false, refusal: true, settingsPath, ...convergence };
  if (!convergence.changed) return { ok: true, changed: false, settingsPath, ...convergence };
  const content = JSON.stringify(copy, null, 2) + '\n';
  try {
    faultInjector('settings:before-write');
    atomicWrite(settingsPath, content, io);
    return { ok: true, changed: true, settingsPath, ...convergence };
  } catch (error) {
    return { ok: false, handledError: true, settingsPath, error, anomalies: [] };
  }
}

export function updateFailureReport({ backupPath, baseReport, failure, io }) {
  const reportPath = path.join(backupPath, 'migration-report.md');
  atomicWrite(reportPath, renderMigrationReport({ ...baseReport, backupPath, failure }), io);
  return reportPath;
}

export function executeMigrationApply({
  zylosDir,
  templatesDir,
  assemblerSource,
  original,
  analysis,
  userContent,
  conservation,
  faultInjector,
  backupFaultInjector,
  reportIo,
  settingsIo,
  versionIo,
  promptIo,
  warn = console.error,
} = {}) {
  const root = path.resolve(zylosDir);
  const originalSha256 = sha256(original);
  const matched = conservation?.matched ?? null;
  const baseReport = {
    classification: analysis.classification,
    matched,
    candidates: analysis.candidates,
    managedBlocks: analysis.managedBlocks,
    userContent,
    originalSha256,
    attributionBaseline: conservation?.attributionBaseline,
    attribution: conservation?.attribution,
  };
  const baseResult = {
    migrated: false,
    fatal: false,
    classification: analysis.classification,
    backupPath: null,
    migrationMeta: null,
    a3: null,
    a3Pending: false,
    versionWritten: false,
    versionWriteError: null,
    error: null,
    reportError: null,
    reportFallbackError: null,
    cleanupResidue: false,
  };

  let backup;
  try {
    backup = createMigrationBackup({
      zylosDir: root,
      report: renderMigrationReport({ ...baseReport, backupPath: '__BACKUP_PATH__' }),
      faultInjector: backupFaultInjector,
    });
  } catch (error) {
    return { ...baseResult, fatal: true, error };
  }

  const migrationMeta = {
    classification: analysis.classification,
    matchedTemplate: matched ? { sha256: matched.sha256, source: matched.sourceCommit } : null,
    attributionBaseline: conservation?.attributionBaseline,
    originalSha256,
    backupPath: backup.backupPath,
    migratedAt: new Date().toISOString(),
  };
  try {
    activateMigratedSplitInstructions({
      zylosDir: root,
      templatesDir,
      assemblerSource,
      userContent,
      migrationMeta,
      faultInjector,
    });
  } catch (error) {
    let reportError = null;
    let reportFallbackError = null;
    try {
      error.residuePresent = hasSplitTransactionResidue(root);
      updateFailureReport({ backupPath: backup.backupPath, baseReport, failure: error, io: reportIo });
    } catch (secondary) {
      reportError = secondary;
      try {
        fs.writeFileSync(
          path.join(backup.backupPath, 'migration-failure-fallback.md'),
          renderMigrationReport({ ...baseReport, backupPath: backup.backupPath, failure: error }),
          { flag: 'wx' },
        );
      } catch (fallbackError) {
        reportFallbackError = fallbackError;
      }
    }
    return {
      ...baseResult,
      backupPath: backup.backupPath,
      migrationMeta,
      error,
      reportError,
      reportFallbackError,
      cleanupResidue: hasSplitTransactionResidue(root),
    };
  }

  const promptCleanup = cleanupMigrationPrompt({ zylosDir: root, io: promptIo });
  if (promptCleanup.error) warn(`Warning: could not remove pending migration prompt: ${promptCleanup.error.message}`);

  let versionWritten = false;
  let versionWriteError = null;
  try {
    writeInstructionFormatVersion({ zylosDir: root, io: versionIo });
    versionWritten = true;
  } catch (error) {
    versionWriteError = error;
    warn(`Warning: could not write instruction format version: ${error.message}; rerun --apply to backfill the version file.`);
  }

  const a3 = reconcileAssemblerSettingsFile({ zylosDir: root, apply: true, faultInjector, io: settingsIo });
  return {
    ...baseResult,
    migrated: true,
    backupPath: backup.backupPath,
    migrationMeta,
    a3,
    a3Pending: !a3.ok,
    versionWritten,
    versionWriteError,
    cleanupResidue: hasSplitTransactionResidue(root),
  };
}
