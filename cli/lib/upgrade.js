/**
 * Core upgrade logic for components.
 * Uses GitHub archive tarballs and filesystem-based backup/rollback.
 * Zero git dependency.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync, spawnSync } from 'node:child_process';
import { SKILLS_DIR, COMPONENTS_DIR } from './config.js';
import { loadComponents } from './components.js';
import { loadLocalRegistry } from './registry.js';
import { parseSkillMd } from './skill.js';
import {
  saveMergeBaseline,
  generateManifest,
} from './manifest.js';
import { downloadArchive, downloadBranch } from './download.js';
import { fetchLatestTag, fetchRawFile, compareSemverDesc, sanitizeError } from './github.js';
import { copyTree, syncTree } from './fs-utils.js';
import { applyCaddyRoutes } from './caddy.js';
import { smartSync, formatMergeResult } from './smart-merge.js';
import { restartFromEcosystem, restartManagedProcess } from './pm2.js';

// ---------------------------------------------------------------------------
// Version helpers
// ---------------------------------------------------------------------------

/**
 * Read the local version from SKILL.md frontmatter, falling back to package.json.
 * Exported so callers can perform an independent, on-disk post-condition
 * read-back after a pinned upgrade/downgrade (see runUpgrade's `pinned` mode).
 */
export function getLocalVersion(skillDir) {
  // Primary: SKILL.md frontmatter
  const parsed = parseSkillMd(skillDir);
  if (parsed?.frontmatter?.version) {
    return { success: true, version: String(parsed.frontmatter.version) };
  }
  // Fallback: package.json
  const pkgPath = path.join(skillDir, 'package.json');
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (pkg.version) {
      return { success: true, version: String(pkg.version) };
    }
  } catch {
    // package.json doesn't exist or is invalid
  }
  return { success: false, error: 'Version not found in SKILL.md or package.json' };
}

/**
 * Get the repo for a component from components.json or registry.
 */
export function getRepo(component) {
  const components = loadComponents();
  if (components[component]?.source?.type?.startsWith('local-')) return null;
  if (components[component]?.repo) return components[component].repo;
  const registry = loadLocalRegistry();
  if (registry[component]?.repo) return registry[component].repo;
  return null;
}

export function getLocalSourceUpgradeError(component, installed = loadComponents()[component]) {
  if (!installed?.source?.type?.startsWith('local-')) return null;
  const sourcePath = installed.source.path || 'the original local source';
  return {
    success: false,
    error: 'local_source_upgrade_unsupported',
    message: `Component '${component}' was installed from a local source. Reinstall it from ${sourcePath} to update it.`,
    source: installed.source,
  };
}

/**
 * Read the installed version from components.json — the exact same source
 * `zylos list` reads (see listComponents() in cli/commands/component.js).
 * This is the authoritative post-condition read-back target for a pinned
 * upgrade/downgrade: success is judged by this value matching the requested
 * version, never by pipeline step status or process health.
 *
 * @param {string} component
 * @returns {string|null}
 */
export function getInstalledVersion(component) {
  const components = loadComponents();
  return components[component]?.version || null;
}

/**
 * Determine whether it is safe to downgrade a component's code to `targetDir`
 * given the data currently on disk under the component's dataDir.
 *
 * This is a new, additive, opt-in SKILL.md frontmatter convention (no such
 * convention existed in this repo before) — components declare:
 *
 *   lifecycle:
 *     data_schema_version: <integer>   # defaults to 1 when absent
 *
 * A downgrade is refused when the currently-installed version's declared
 * data_schema_version is greater than the target version's declared
 * data_schema_version — i.e. the on-disk data may have been written in a
 * format the older target code does not understand. When either side omits
 * the field, it defaults to 1, so existing components that never declare it
 * are never blocked (non-breaking, matches requirement 5).
 *
 * This check is read-only and must be called BEFORE any file is touched —
 * on refusal, nothing is changed on disk.
 *
 * @param {string} currentSkillDir - Currently-installed skill directory (may not exist)
 * @param {string} targetDir - Downloaded target-version directory (temp dir)
 * @returns {{ compatible: boolean, currentSchema: number, targetSchema: number, error?: string }}
 */
export function checkDowngradeSchemaCompatibility(currentSkillDir, targetDir) {
  const currentSchema = readDataSchemaVersion(currentSkillDir);
  const targetSchema = readDataSchemaVersion(targetDir);

  if (targetSchema < currentSchema) {
    return {
      compatible: false,
      currentSchema,
      targetSchema,
      error: `Refusing downgrade: installed data schema version (${currentSchema}) is newer than the target version's supported schema (${targetSchema}). The target code may not understand the on-disk data. No files were changed.`,
    };
  }

  return { compatible: true, currentSchema, targetSchema };
}

function readDataSchemaVersion(dir) {
  try {
    const parsed = parseSkillMd(dir);
    const value = parsed?.frontmatter?.lifecycle?.data_schema_version;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && /^\d+$/.test(value)) return parseInt(value, 10);
  } catch {
    // Unreadable/missing SKILL.md — fall through to the permissive default.
  }
  return 1;
}

/**
 * Get the latest version from GitHub (latest tag).
 * Falls back to fetching SKILL.md from GitHub if no tags found.
 *
 * @param {string} component
 * @param {string} repo
 * @param {object} [opts]
 * @param {boolean} [opts.beta=false] - Include prerelease (beta) tags
 */
function getLatestVersion(component, repo, { beta = false } = {}) {
  if (!repo) return { success: false, error: 'No repo configured for component' };

  // Primary: fetch latest tag from GitHub
  try {
    const tagVersion = fetchLatestTag(repo, { includePrerelease: beta });
    if (tagVersion) {
      return { success: true, version: tagVersion };
    }
  } catch {
    // Network/API error — fall through to SKILL.md fallback
  }

  // Fallback: fetch raw SKILL.md from GitHub (only for non-beta, as SKILL.md has no prerelease info)
  if (!beta) {
    try {
      const content = fetchRawFile(repo, 'SKILL.md');
      const match = content.match(/^---\n([\s\S]*?)\n---/);
      if (match) {
        const versionMatch = match[1].match(/^version:\s*(.+)$/m);
        if (versionMatch) {
          return { success: true, version: versionMatch[1].trim() };
        }
      }
      return { success: false, error: 'Version not found in remote SKILL.md' };
    } catch (err) {
      return { success: false, error: `Cannot fetch remote: ${sanitizeError(err.message)}` };
    }
  }

  return { success: false, error: 'No release tags found' };
}

// ---------------------------------------------------------------------------
// Public: checkForUpdates
// ---------------------------------------------------------------------------

/**
 * Check if a component has updates available.
 * Uses registry lookup (fast, no HTTP) with fallback to GitHub raw SKILL.md.
 *
 * @param {string} component
 * @param {object} [opts]
 * @param {boolean} [opts.beta=false] - Include prerelease (beta) versions
 * @returns {object} { success, hasUpdate, current, latest, repo }
 */
export function checkForUpdates(component, { beta = false } = {}) {
  const skillDir = path.join(SKILLS_DIR, component);

  if (!fs.existsSync(skillDir)) {
    return {
      success: false,
      error: 'component_not_found',
      message: `Component '${component}' is not installed`,
    };
  }

  const localSourceError = getLocalSourceUpgradeError(component);
  if (localSourceError) return localSourceError;

  const localVersion = getLocalVersion(skillDir);
  if (!localVersion.success) {
    return {
      success: false,
      error: 'version_not_found',
      message: `Cannot read current version: ${localVersion.error}`,
    };
  }

  const repo = getRepo(component);
  const latest = getLatestVersion(component, repo, { beta });
  if (!latest.success) {
    return {
      success: false,
      error: 'remote_version_failed',
      message: `Cannot determine latest version: ${latest.error}`,
    };
  }

  // Use semver comparison (not string inequality) to avoid suggesting downgrades.
  // compareSemverDesc(a, b) > 0 means b is higher than a.
  const hasUpdate = compareSemverDesc(localVersion.version, latest.version) > 0;

  return {
    success: true,
    hasUpdate,
    current: localVersion.version,
    latest: latest.version,
    repo,
  };
}

// ---------------------------------------------------------------------------
// Internal: allowed temp roots for safety checks
// ---------------------------------------------------------------------------

function safeResolve(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

/**
 * Return the list of directory roots under which temp dirs are allowed.
 * Used by cleanupTemp in both component and self-upgrade flows.
 * Order: system tmpdir first, ~/tmp as fallback.
 */
export function getAllowedTmpRoots() {
  const roots = [];
  try { roots.push(safeResolve(os.tmpdir())); } catch { /* skip */ }
  const userTmp = path.join(os.homedir(), 'tmp');
  roots.push(safeResolve(userTmp));
  return roots;
}

// ---------------------------------------------------------------------------
// Public: downloadToTemp
// ---------------------------------------------------------------------------

/**
 * Download a component version to a temp directory.
 *
 * @param {string} repo - GitHub repo (org/name)
 * @param {string} version - Version to download
 * @param {string} [branch] - Optional branch to download from (skips version tag)
 * @param {object} [opts]
 * @param {boolean} [opts.allowFallback=true] - When the exact version tag fails to
 *   download, fall back to the `main` branch. Pinned-version installs (an exact
 *   version was explicitly requested, e.g. via `zylos upgrade <c>@<version>`) MUST
 *   pass `allowFallback: false` — silently substituting `main` for a missing tag
 *   would materialize the wrong version while still looking like a success.
 * @returns {{ success: boolean, tempDir?: string, error?: string }}
 */
export function downloadToTemp(repo, version, branch, { allowFallback = true } = {}) {
  let base = os.tmpdir();
  try {
    const probe = fs.mkdtempSync(path.join(base, 'zylos-upgrade-probe-'));
    fs.rmSync(probe, { recursive: true, force: true });
  } catch {
    // System tmp unavailable — fallback to ~/tmp
    base = path.join(os.homedir(), 'tmp');
    fs.mkdirSync(base, { recursive: true });
  }
  const tempDir = fs.mkdtempSync(path.join(base, 'zylos-upgrade-'));

  if (branch) {
    const branchResult = downloadBranch(repo, branch, tempDir);
    if (!branchResult.success) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      return { success: false, error: branchResult.error };
    }
    return { success: true, tempDir };
  }

  const result = downloadArchive(repo, version, tempDir);
  if (!result.success) {
    if (!allowFallback) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      return { success: false, error: result.error };
    }
    // Fallback: try downloading main branch
    const branchResult = downloadBranch(repo, 'main', tempDir);
    if (!branchResult.success) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      return { success: false, error: result.error };
    }
  }

  return { success: true, tempDir };
}

// ---------------------------------------------------------------------------
// Public: readChangelog
// ---------------------------------------------------------------------------

/**
 * Read CHANGELOG.md from a directory.
 *
 * @param {string} dir - Directory containing CHANGELOG.md
 * @returns {string|null}
 */
export function readChangelog(dir) {
  const changelogPath = path.join(dir, 'CHANGELOG.md');
  if (!fs.existsSync(changelogPath)) return null;
  try {
    return fs.readFileSync(changelogPath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Filter changelog to only show entries between two versions.
 * Expects standard format: ## [version] or ## version headers.
 *
 * @param {string} changelog - Full changelog text
 * @param {string} fromVersion - Current installed version (excluded)
 * @returns {string|null} Filtered changelog or null if parsing fails
 */
export function filterChangelog(changelog, fromVersion) {
  if (!changelog || !fromVersion) return changelog;

  const lines = changelog.split('\n');
  const result = [];
  let capturing = false;
  let foundHeaders = false;
  let done = false;

  // Match ## headers containing version numbers: "## [1.0.0]", "## 1.0.0", "## v1.0.0 - date"
  const versionHeaderRe = /^##\s+\[?v?(\d+\.\d+[^\]\s]*)\]?/;

  for (const line of lines) {
    if (done) break;

    const match = line.match(versionHeaderRe);
    if (match) {
      foundHeaders = true;
      const headerVersion = match[1].replace(/^v/, '');
      // Stop when we reach the installed version (already known)
      if (headerVersion === fromVersion) {
        done = true;
        continue;
      }
      // Capture everything from the newest version down to (but not including) fromVersion
      capturing = true;
    }

    if (capturing) {
      result.push(line);
    }
  }

  if (!foundHeaders) return changelog; // Couldn't parse headers, return full text
  return result.join('\n').trim() || null;
}

// ---------------------------------------------------------------------------
// Public: cleanupTemp
// ---------------------------------------------------------------------------

/**
 * Remove a temp directory.
 *
 * @param {string} tempDir
 */
export function cleanupTemp(tempDir) {
  if (!tempDir || !fs.existsSync(tempDir)) return;

  let resolved;
  try { resolved = fs.realpathSync(tempDir); } catch { resolved = path.resolve(tempDir); }

  // Safety: only delete directories under allowed temp roots
  const allowedRoots = getAllowedTmpRoots();
  if (!allowedRoots.some(root => resolved.startsWith(root + '/'))) {
    console.error(`SAFETY: refusing to delete ${resolved} (not under any allowed temp root)`);
    return;
  }

  fs.rmSync(tempDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Internal: create upgrade context
// ---------------------------------------------------------------------------

function createContext(component, { tempDir, newVersion, mode, jsonOutput, pinned } = {}) {
  const skillDir = path.join(SKILLS_DIR, component);
  const dataDir = path.join(COMPONENTS_DIR, component);

  return {
    component,
    skillDir,
    dataDir,
    tempDir: tempDir || null,
    newVersion: newVersion || null,
    mode: mode || 'merge',
    // Pinned mode (zylos upgrade <c>@<version>): a self-contained, clean
    // re-materialize that (a) is independent of the component's current
    // running/installed state — a crashed, stopped, or half-installed
    // (missing skillDir) component must still be recoverable — and (b)
    // always force-ensures the service is left running afterward instead of
    // only restoring whatever state it happened to be in beforehand.
    pinned: Boolean(pinned),
    jsonOutput: Boolean(jsonOutput),
    // Set to true only by step3_pinnedCleanReinstall, only after its atomic
    // swap-in has actually completed THIS run. This is the flag the final
    // result's `pinnedSwapCompleted` is derived from — the post-condition
    // read-back (component.js) must require it in addition to version
    // equality, so an inherited/unrelated broken tree that happens to
    // already read back as the target version is never mistaken for a
    // successful install performed by this attempt (daniel round-3 finding).
    pinnedSwapCompleted: false,
    npmInstallDoneInStaging: false,
    // State tracking
    backupDir: null,
    serviceStopped: false,
    serviceExists: true,
    serviceWasRunning: false,
    mergeConflicts: [],
    mergedFiles: [],
    // Results
    steps: [],
    from: null,
    to: null,
    success: false,
    error: null,
  };
}

// ---------------------------------------------------------------------------
// 7-step upgrade pipeline
// ---------------------------------------------------------------------------

/**
 * Step 1: stop PM2 service
 */
function step1_stopService(ctx) {
  const startTime = Date.now();
  const parsed = parseSkillMd(ctx.skillDir);
  const serviceName = parsed?.frontmatter?.lifecycle?.service?.name || `zylos-${ctx.component}`;

  try {
    const output = execSync('pm2 jlist 2>/dev/null', { encoding: 'utf8' });
    const processes = JSON.parse(output);
    const service = processes.find(p => p.name === serviceName);

    if (!service) {
      ctx.serviceExists = false;
      return { step: 1, name: 'stop_service', status: 'skipped', message: 'no service', duration: Date.now() - startTime };
    }

    ctx.serviceExists = true;
    ctx.serviceWasRunning = service.pm2_env?.status === 'online';

    if (!ctx.serviceWasRunning) {
      return { step: 1, name: 'stop_service', status: 'skipped', message: 'not running', duration: Date.now() - startTime };
    }

    execSync(`pm2 stop ${serviceName} 2>/dev/null`, { stdio: 'pipe' });
    ctx.serviceStopped = true;

    return { step: 1, name: 'stop_service', status: 'done', message: serviceName, duration: Date.now() - startTime };
  } catch {
    return { step: 1, name: 'stop_service', status: 'skipped', message: 'pm2 not available', duration: Date.now() - startTime };
  }
}

/**
 * Step 2: filesystem backup to .backup/<timestamp>/
 */
function step2_backup(ctx) {
  const startTime = Date.now();

  // Pinned recovery path: skillDir may be entirely missing (half-installed /
  // previously wiped component). There is nothing to back up in that case —
  // this is not reachable from the non-pinned flow, which already hard-fails
  // before step1 when skillDir is missing (see runUpgrade's guard below).
  if (!fs.existsSync(ctx.skillDir)) {
    return { step: 2, name: 'backup', status: 'skipped', message: 'nothing to back up (component directory missing)', duration: Date.now() - startTime };
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(ctx.skillDir, '.backup', timestamp);

  try {
    copyTree(ctx.skillDir, backupDir, { excludes: ['node_modules', '.backup', '.zylos'] });

    ctx.backupDir = backupDir;
    return { step: 2, name: 'backup', status: 'done', message: path.basename(backupDir), duration: Date.now() - startTime };
  } catch (err) {
    return { step: 2, name: 'backup', status: 'failed', error: `Backup failed: ${err.message}`, duration: Date.now() - startTime };
  }
}

/**
 * Step 3: smart merge new files into skill dir
 *
 * Uses three-way merge when possible:
 * - Local unmodified → overwrite
 * - Local modified + new unchanged → keep local
 * - Both changed → diff3 merge or overwrite + backup local
 */
function step3_smartMerge(ctx) {
  const startTime = Date.now();

  if (!ctx.tempDir || !fs.existsSync(ctx.tempDir)) {
    return { step: 3, name: 'smart_merge', status: 'failed', error: 'Temp directory not available', duration: Date.now() - startTime };
  }

  try {
    const conflictBackupDir = ctx.backupDir ? path.join(ctx.backupDir, 'conflicts') : null;
    const mergeResult = smartSync(ctx.tempDir, ctx.skillDir, {
      backupDir: conflictBackupDir,
      mode: ctx.mode,
    });

    // Store merge info on context for final result
    ctx.mergeConflicts = mergeResult.conflicts;
    ctx.mergedFiles = mergeResult.merged;

    const msg = formatMergeResult(mergeResult);

    if (mergeResult.errors.length > 0) {
      return { step: 3, name: 'smart_merge', status: 'failed', error: mergeResult.errors.join('; '), duration: Date.now() - startTime };
    }

    ctx.nextManifest = mergeResult.nextManifest;

    return { step: 3, name: 'smart_merge', status: 'done', message: msg, duration: Date.now() - startTime };
  } catch (err) {
    return { step: 3, name: 'smart_merge', status: 'failed', error: `Merge failed: ${err.message}`, duration: Date.now() - startTime };
  }
}

/**
 * Step 3 (pinned mode only): staged clean reinstall with atomic swap-in.
 *
 * Replaces step3_smartMerge for `zylos upgrade <c>@<version>` (requirement 1:
 * clean-reinstall, no three-way merge/diff — whole-tree overwrite). This is a
 * deliberate rewrite (not a `smartSync({mode:'overwrite'})` call) to satisfy
 * the stronger self-certifying guarantee daniel's review demanded:
 *
 *   "read-back can never show == target unless the install is genuinely
 *    complete" — enforced structurally, not by convention, because the
 *    install path for a missing/broken skillDir has no old version to roll
 *    back to (rollback alone cannot be the safety net here).
 *
 * How:
 *  1. The entire new tree (including version-bearing SKILL.md/package.json)
 *     is materialized in a STAGING directory that is not yet visible as
 *     `ctx.skillDir` at all.
 *  2. `npm install` and manifest generation run against that staging tree,
 *     fully, before anything touches the live skillDir.
 *  3. Only once both are green does a single atomic `fs.renameSync` swap the
 *     staging tree into `ctx.skillDir`'s place — this is the one moment
 *     version-bearing files become visible, and they arrive already
 *     fully-installed (npm deps present, manifest computed), never partially.
 *  4. Any failure up to that point leaves the live skillDir completely
 *     untouched (old content, or still absent) — there is nothing to "clean
 *     up" because nothing was written to it. If a failure happens to occur
 *     during the swap itself, the previous tree (if any) is restored so the
 *     live path is never left half-renamed.
 *  5. `.backup/` — which lives inside skillDir (requirement 🟡, and the sole
 *     rollback/inspection source for the very bad-state scenarios this
 *     feature targets) — is preserved by moving it out of the old tree
 *     before that tree is discarded, and back into the freshly-swapped-in
 *     tree. `.zylos/` and `node_modules/` are legitimately regenerated (the
 *     same way a normal upgrade always regenerates them via step9/step4),
 *     not "preserved as stale old content".
 *
 * On success, `ctx.pinnedSwapCompleted = true` is set — this is the flag the
 * caller (runUpgrade's result, then component.js's post-condition read-back)
 * binds success to, so that a read-back version match alone is never treated
 * as sufficient (daniel round 3): an inherited, unrelated broken tree that
 * happens to already read back as the target version cannot be mistaken for
 * a successful *this-attempt* install, because this flag is only ever set by
 * an atomic swap this same pipeline run actually performed.
 */
function step3_pinnedCleanReinstall(ctx) {
  const startTime = Date.now();
  const excludes = ['node_modules', '.backup', '.zylos'];

  if (!ctx.tempDir || !fs.existsSync(ctx.tempDir)) {
    return { step: 3, name: 'clean_reinstall', status: 'failed', error: 'Temp directory not available', duration: Date.now() - startTime };
  }

  const uniqueSuffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const stageDir = `${ctx.skillDir}.staging-${uniqueSuffix}`;
  let oldAsideDir = null;
  let swapped = false;

  try {
    // 1. Materialize the complete new tree in staging — the live skillDir is
    // not touched by anything in this block.
    fs.rmSync(stageDir, { recursive: true, force: true });
    copyTree(ctx.tempDir, stageDir, { excludes });

    // 2. Install dependencies against the staged tree only.
    const stagedPackageJson = path.join(stageDir, 'package.json');
    if (fs.existsSync(stagedPackageJson)) {
      execSync('npm install --omit=dev', {
        cwd: stageDir,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    }

    // 3. Compute the authoritative manifest for the staged tree. Nothing
    // observable has changed under ctx.skillDir yet.
    const nextManifest = generateManifest(stageDir);

    // 4. Atomic swap: move the old tree aside (if any), move staging in.
    // Both renames are same-filesystem (siblings under SKILLS_DIR), so each
    // individual rename is atomic; the pair is made crash-tolerant by the
    // catch block below, which restores the old tree if the second rename
    // fails.
    if (fs.existsSync(ctx.skillDir)) {
      oldAsideDir = `${ctx.skillDir}.old-${uniqueSuffix}`;
      fs.renameSync(ctx.skillDir, oldAsideDir);
    }
    try {
      fs.renameSync(stageDir, ctx.skillDir);
      swapped = true;
    } catch (swapErr) {
      if (oldAsideDir) {
        try { fs.renameSync(oldAsideDir, ctx.skillDir); oldAsideDir = null; } catch { /* best effort */ }
      }
      throw swapErr;
    }

    // 5. Carry `.backup/` forward from the discarded old tree into the
    // freshly swapped-in tree — it must survive the "whole-tree overwrite"
    // (requirement 🟡) since it is rollback's restore source and the only
    // recovery/inspection path for the bad-state scenarios this feature
    // targets. step2_backup (which runs before this step) wrote it into the
    // OLD skillDir, so it now lives under oldAsideDir.
    if (oldAsideDir) {
      const oldBackupDir = path.join(oldAsideDir, '.backup');
      if (fs.existsSync(oldBackupDir)) {
        fs.renameSync(oldBackupDir, path.join(ctx.skillDir, '.backup'));
      }
      fs.rmSync(oldAsideDir, { recursive: true, force: true });
      oldAsideDir = null;
    }

    ctx.nextManifest = nextManifest;
    ctx.npmInstallDoneInStaging = true;
    ctx.pinnedSwapCompleted = true;

    return {
      step: 3,
      name: 'clean_reinstall',
      status: 'done',
      message: 'staged clean reinstall (pinned version), atomically swapped in',
      duration: Date.now() - startTime,
    };
  } catch (err) {
    // Fail-clean (requirement ②): the staging tree is discarded. The live
    // skillDir was either never touched, or — in the narrow swap-failure
    // window — already restored above, so no half-installed tree bearing
    // target-version metadata is ever left on disk. ctx.pinnedSwapCompleted
    // is deliberately left unset.
    try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch { /* best effort */ }
    const detail = err.stderr?.trim() || err.message;
    return {
      step: 3,
      name: 'clean_reinstall',
      status: 'failed',
      error: `Clean reinstall failed${swapped ? ' after swap' : ''}: ${detail}`,
      duration: Date.now() - startTime,
    };
  }
}

/**
 * Step 4: npm install
 */
function step4_npmInstall(ctx) {
  const startTime = Date.now();

  // Pinned mode already ran npm install against the staging tree, before it
  // was ever swapped into ctx.skillDir (see step3_pinnedCleanReinstall) —
  // running it again here would be redundant, and would defeat the point of
  // doing it in staging (a second in-place run reintroduces exactly the
  // "half-installed live tree" window requirement ① exists to eliminate).
  if (ctx.pinned) {
    return { step: 4, name: 'npm_install', status: 'skipped', message: 'done during staged reinstall', duration: Date.now() - startTime };
  }

  const packageJson = path.join(ctx.skillDir, 'package.json');

  if (!fs.existsSync(packageJson)) {
    return { step: 4, name: 'npm_install', status: 'skipped', message: 'no package.json', duration: Date.now() - startTime };
  }

  try {
    execSync('npm install --omit=dev', {
      cwd: ctx.skillDir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { step: 4, name: 'npm_install', status: 'done', duration: Date.now() - startTime };
  } catch (err) {
    return { step: 4, name: 'npm_install', status: 'failed', error: err.stderr?.trim() || err.message, duration: Date.now() - startTime };
  }
}

/**
 * Step 5: verify that smart merge produced an authoritative baseline
 * candidate. It remains uncommitted until the outer transaction succeeds.
 */
function step5_generateManifest(ctx) {
  const startTime = Date.now();

  if (ctx.nextManifest) {
    return { step: 5, name: 'generate_manifest', status: 'skipped', message: 'authoritative baseline pending outer commit', duration: Date.now() - startTime };
  }
  return { step: 5, name: 'generate_manifest', status: 'failed', error: 'baseline candidate missing after smart merge', duration: Date.now() - startTime };
}

/**
 * Final step: commit manifest + originals only after every rollback-triggering
 * operation has succeeded. A pre-commit failure leaves the previous baseline
 * intact, so ordinary business-file rollback is sufficient.
 */
function step9_commitBaseline(ctx) {
  const startTime = Date.now();
  try {
    saveMergeBaseline(ctx.skillDir, ctx.tempDir, ctx.nextManifest);
    return { step: 9, name: 'commit_baseline', status: 'done', message: 'authoritative source baseline committed', duration: Date.now() - startTime };
  } catch (err) {
    return { step: 9, name: 'commit_baseline', status: 'failed', error: `Baseline commit failed: ${err.message}`, duration: Date.now() - startTime };
  }
}

/**
 * Step 6: update Caddy routes (if http_routes declared in SKILL.md)
 */
function step6_updateCaddyRoutes(ctx) {
  const startTime = Date.now();
  const parsed = parseSkillMd(ctx.skillDir);
  const httpRoutes = parsed?.frontmatter?.http_routes;

  if (!httpRoutes || !Array.isArray(httpRoutes) || httpRoutes.length === 0) {
    return { step: 6, name: 'caddy_routes', status: 'skipped', message: 'no http_routes', duration: Date.now() - startTime };
  }

  const result = applyCaddyRoutes(ctx.component, httpRoutes);
  if (result.success) {
    return { step: 6, name: 'caddy_routes', status: 'done', message: result.action, caddy: result, duration: Date.now() - startTime };
  }
  if (result.action === 'manual_required') {
    return {
      step: 6,
      name: 'caddy_routes',
      status: 'skipped',
      message: 'manual configuration required',
      caddy: result,
      duration: Date.now() - startTime,
    };
  }
  // Caddy failures are non-fatal for upgrades
  return { step: 6, name: 'caddy_routes', status: 'skipped', message: result.error, caddy: result, duration: Date.now() - startTime };
}

/**
 * Step 7: run post-upgrade hook (non-fatal).
 *
 * Mirrors the post-install soft-failure pattern in cli/commands/add.js: hook
 * problems are reported as 'skipped' (not 'failed') so they never trigger a
 * rollback of an otherwise-successful upgrade.
 */
export function step7_runPostUpgradeHook(ctx, deps = {}) {
  const startTime = Date.now();
  const spawn = deps.spawnSync ?? spawnSync;
  const exists = deps.existsSync ?? fs.existsSync;
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;

  const parsed = parseSkillMd(ctx.skillDir);
  const hookRel = parsed?.frontmatter?.lifecycle?.hooks?.['post-upgrade'];
  if (!hookRel) {
    return { step: 7, name: 'post_upgrade_hook', status: 'skipped', message: 'no post-upgrade hook', duration: Date.now() - startTime };
  }

  const hookPath = path.resolve(ctx.skillDir, hookRel);
  const hookRelativePath = path.relative(ctx.skillDir, hookPath);
  if (hookRelativePath.startsWith('..') || path.isAbsolute(hookRelativePath)) {
    return { step: 7, name: 'post_upgrade_hook', status: 'skipped', message: `hook path escapes skill directory: ${hookRel}`, duration: Date.now() - startTime };
  }
  if (!exists(hookPath)) {
    return { step: 7, name: 'post_upgrade_hook', status: 'skipped', message: `hook not found: ${hookRel}`, duration: Date.now() - startTime };
  }

  const realSkillDir = fs.realpathSync(ctx.skillDir);
  const realHookPath = fs.realpathSync(hookPath);
  const realHookRelativePath = path.relative(realSkillDir, realHookPath);
  if (realHookRelativePath.startsWith('..') || path.isAbsolute(realHookRelativePath)) {
    return { step: 7, name: 'post_upgrade_hook', status: 'skipped', message: `hook path escapes skill directory: ${hookRel}`, duration: Date.now() - startTime };
  }

  const child = spawn(process.execPath, [hookPath], {
    cwd: ctx.skillDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const hookStdout = child.stdout || '';
  const hookStderr = child.stderr || '';
  if (!ctx.jsonOutput) {
    if (hookStdout) stdout.write(hookStdout);
    if (hookStderr) stderr.write(hookStderr);
  }

  const output = {
    stdout: truncateHookOutput(hookStdout),
    stderr: truncateHookOutput(hookStderr),
  };

  if (child.error) {
    return { step: 7, name: 'post_upgrade_hook', status: 'skipped', message: `hook had issues (non-fatal): ${child.error.message}`, output, duration: Date.now() - startTime };
  }
  if (child.status !== 0) {
    const detail = hookStderr.trim() || hookStdout.trim() || `exit code ${child.status}`;
    return { step: 7, name: 'post_upgrade_hook', status: 'skipped', message: `hook had issues (non-fatal): ${truncateHookOutput(detail)}`, output, duration: Date.now() - startTime };
  }
  return { step: 7, name: 'post_upgrade_hook', status: 'done', message: hookRel, output, duration: Date.now() - startTime };
}

function truncateHookOutput(value, maxLength = 1000) {
  if (!value) return '';
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

/**
 * Step 8: restart PM2 service (if it was running before upgrade)
 */
export function step8_startService(ctx, deps = {}) {
  const startTime = Date.now();
  const exec = deps.execSync ?? execSync;
  const exists = deps.existsSync ?? fs.existsSync;
  const restartManaged = deps.restartManagedProcess ?? restartManagedProcess;
  const restartViaEcosystem = deps.restartFromEcosystem ?? restartFromEcosystem;

  const parsed = parseSkillMd(ctx.skillDir);
  const declaresService = Boolean(parsed?.frontmatter?.lifecycle?.service);

  // Non-pinned upgrades preserve the existing contract: only restart if the
  // service was actually running beforehand (byte-compatible, requirement 5).
  //
  // Pinned upgrades (requirement 4) must NOT depend on prior process health:
  // whether the component was crashed, stopped, or never registered with PM2
  // at all, a pinned upgrade always ensures the declared service ends up
  // running — that is what makes `zylos upgrade <c>@<stable>` a viable
  // recovery path for a broken component. A component that declares no
  // service at all is left alone either way (nothing to start).
  const shouldStart = ctx.serviceWasRunning || (ctx.pinned && declaresService);

  if (!shouldStart) {
    const message = ctx.pinned && !declaresService ? 'no service declared' : 'was not running';
    return { step: 8, name: 'start_service', status: 'skipped', message, duration: Date.now() - startTime };
  }

  const serviceName = parsed?.frontmatter?.lifecycle?.service?.name || `zylos-${ctx.component}`;
  const ecosystemPath = path.join(ctx.skillDir, 'ecosystem.config.cjs');

  try {
    restartManaged(serviceName, { ecosystemPath, stdio: 'pipe', save: true });
    return { step: 8, name: 'start_service', status: 'done', message: serviceName, duration: Date.now() - startTime };
  } catch {
    // If the process disappeared from PM2 between step1 and step8, retry via
    // the component ecosystem so PM2 reloads the current service definition.
    try {
      if (!exists(ecosystemPath)) {
        throw new Error(`ecosystem config not found: ${ecosystemPath}`);
      }
      try { exec(`pm2 delete "${serviceName}" 2>/dev/null`, { stdio: 'pipe' }); } catch {}
      restartViaEcosystem([serviceName], { ecosystemPath, stdio: 'pipe', save: true });
      return { step: 8, name: 'start_service', status: 'done', message: `${serviceName} (restarted from ecosystem)`, duration: Date.now() - startTime };
    } catch {
      // Requirement 4: a pinned upgrade's success/failure is judged only by
      // the installed-version read-back, never by process health. By this
      // point the target version is already fully materialized on disk (the
      // atomic swap in step3 already completed) — a restart failure here is
      // real and must be surfaced, but it must not roll back an otherwise
      // correctly-installed version, nor flip the pinned result to failure.
      // Non-pinned upgrades keep the original fatal (rollback-triggering)
      // behavior untouched — requirement 5, no regression.
      if (ctx.pinned) {
        return {
          step: 8,
          name: 'start_service',
          status: 'skipped',
          message: `service restart failed (non-fatal for pinned upgrade): ${serviceName}`,
          duration: Date.now() - startTime,
        };
      }
      return { step: 8, name: 'start_service', status: 'failed', error: `Failed to restart ${serviceName}`, duration: Date.now() - startTime };
    }
  }
}

// ---------------------------------------------------------------------------
// Public: rollback
// ---------------------------------------------------------------------------

/**
 * Rollback from .backup/ directory.
 *
 * @param {object} ctx - Upgrade context
 * @param {object} [deps] - Injectable dependencies (testing seam)
 * @returns {object[]} Array of rollback action results
 */
export function rollback(ctx, deps = {}) {
  const results = [];

  // Restore files from backup (--delete removes files added by the failed upgrade)
  if (ctx.backupDir && fs.existsSync(ctx.backupDir)) {
    try {
      syncTree(ctx.backupDir, ctx.skillDir, { excludes: ['node_modules', '.backup', '.zylos'] });
      results.push({ action: 'restore_files', success: true });
    } catch (err) {
      results.push({ action: 'restore_files', success: false, error: err.message });
    }

    // Restore dependencies
    const packageJson = path.join(ctx.skillDir, 'package.json');
    if (fs.existsSync(packageJson)) {
      try {
        execSync('npm install --omit=dev', {
          cwd: ctx.skillDir,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        results.push({ action: 'restore_dependencies', success: true });
      } catch (err) {
        results.push({ action: 'restore_dependencies', success: false, error: err.message });
      }
    }
  }

  // Restart service if it was running
  if (ctx.serviceWasRunning) {
    const restartManaged = deps.restartManagedProcess ?? restartManagedProcess;
    const parsed = parseSkillMd(ctx.skillDir);
    const serviceName = parsed?.frontmatter?.lifecycle?.service?.name || `zylos-${ctx.component}`;
    const ecosystemPath = path.join(ctx.skillDir, 'ecosystem.config.cjs');
    try {
      // save: true persists the PM2 dump so the rolled-back service survives a
      // reboot. Without it, a recreated process (pm2 delete + start) lives only
      // in memory and is lost on the next `pm2 resurrect`.
      restartManaged(serviceName, { ecosystemPath, stdio: 'pipe', save: true });
      results.push({ action: 'restart_service', success: true });
    } catch (err) {
      results.push({ action: 'restart_service', success: false, error: err.message });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Public: runUpgrade
// ---------------------------------------------------------------------------

/**
 * Run the 9-step upgrade pipeline (mechanical operations only).
 * Lock must be acquired by caller (component.js).
 *
 * @param {string} component
 * @param {{ tempDir: string, newVersion: string, pinned?: boolean }} opts
 *   `pinned: true` (used by `zylos upgrade <c>@<version>`) routes step3 to
 *   step3_pinnedCleanReinstall — a staged clean reinstall with atomic
 *   swap-in (no three-way merge, whole tree replaced to exactly match the
 *   target version) — tolerates a missing skillDir (self-healing a
 *   half-installed component), and force-ensures the service ends up running
 *   regardless of whether it was running/registered beforehand (that failure
 *   is non-fatal for pinned mode — see step8_startService).
 * @returns {object} Upgrade result
 */
export function runUpgrade(component, { tempDir, newVersion, mode, jsonOutput, onStep, pinned } = {}) {
  const ctx = createContext(component, { tempDir, newVersion, mode, jsonOutput, pinned });

  // The non-pinned path preserves its existing contract: a missing skillDir
  // is a hard failure (nothing to upgrade). The pinned path is explicitly
  // designed to recover from exactly this state (requirement 4) — step2 and
  // step3 below already tolerate a missing skillDir and (re)create it.
  if (!ctx.pinned && !fs.existsSync(ctx.skillDir)) {
    return {
      action: 'upgrade',
      component,
      success: false,
      error: `Component directory not found: ${ctx.skillDir}`,
      steps: [],
    };
  }

  // Record current version
  const localVersion = getLocalVersion(ctx.skillDir);
  if (localVersion.success) {
    ctx.from = localVersion.version;
  }
  ctx.to = newVersion || null;

  const steps = [
    step1_stopService,
    step2_backup,
    ctx.pinned ? step3_pinnedCleanReinstall : step3_smartMerge,
    step4_npmInstall,
    step5_generateManifest,
    step6_updateCaddyRoutes,
    step7_runPostUpgradeHook,
    step8_startService,
    step9_commitBaseline,
  ];

  const total = steps.length;
  let failedStep = null;

  for (const stepFn of steps) {
    const result = stepFn(ctx);
    result.total = total;
    ctx.steps.push(result);
    if (onStep) onStep(result);

    if (result.status === 'failed') {
      failedStep = result;
      ctx.error = result.error;
      break;
    }
  }

  // If failed, rollback
  if (failedStep) {
    const rollbackResults = rollback(ctx);
    return {
      action: 'upgrade',
      component,
      success: false,
      from: ctx.from,
      to: null,
      failedStep: failedStep.step,
      error: failedStep.error,
      steps: ctx.steps,
      rollback: { performed: true, steps: rollbackResults },
      // Always false here: a failed pipeline never reached (or was undone
      // after) a completed atomic swap-in. See createContext's comment and
      // the final success-path return below for what this gates.
      pinnedSwapCompleted: ctx.pinned ? Boolean(ctx.pinnedSwapCompleted) : null,
    };
  }

  // Success — read the new version and SKILL.md metadata
  const updatedVersion = getLocalVersion(ctx.skillDir);
  if (updatedVersion.success) {
    ctx.to = updatedVersion.version;
  }

  // Include SKILL.md metadata for Claude (hooks, config, service info)
  const skillMeta = parseSkillMd(ctx.skillDir);
  const fm = skillMeta?.frontmatter || {};
  const lifecycle = fm.lifecycle || {};
  const hooks = lifecycle.hooks || {};
  const config = fm.config || {};

  // Extract Caddy result from steps
  const caddyStep = ctx.steps.find(s => s.name === 'caddy_routes');
  const caddyResult = caddyStep?.caddy
    ? { ...caddyStep.caddy, status: caddyStep.status }
    : (caddyStep ? { action: caddyStep.message, status: caddyStep.status } : null);

  return {
    action: 'upgrade',
    component,
    success: true,
    from: ctx.from,
    to: ctx.to,
    steps: ctx.steps,
    backupDir: ctx.backupDir,
    skill: {
      hooks: Object.keys(hooks).length > 0 ? hooks : null,
      config: Object.keys(config).length > 0 ? config : null,
      service: lifecycle.service || null,
      caddy: caddyResult,
    },
    mergeConflicts: ctx.mergeConflicts.length > 0 ? ctx.mergeConflicts : null,
    mergedFiles: ctx.mergedFiles.length > 0 ? ctx.mergedFiles : null,
    // Requirement (daniel round 3, "inherited broken tree"): callers must
    // bind their post-condition read-back to THIS attempt having actually
    // performed the atomic swap-in, not merely to the disk version matching
    // the target — a stale, unrelated broken tree from a prior operation
    // could coincidentally already read back as the target version. For
    // pinned mode this is true here (the loop only reaches this point when
    // every step, including the clean-reinstall swap, reported non-failed).
    // Non-pinned upgrades don't use this concept — always null.
    pinnedSwapCompleted: ctx.pinned ? Boolean(ctx.pinnedSwapCompleted) : null,
  };
}
