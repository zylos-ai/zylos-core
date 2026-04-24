/**
 * zylos uninstall --self — Remove zylos entirely from the system.
 *
 * Design: https://github.com/zylos-ai/zylos-core/issues/212
 *
 * Phase 1: Stop services (tmux sessions + PM2 zylos services)
 * Phase 2: Uninstall the zylos npm package
 * Phase 3: Clean shell PATH entries
 * Phase 4: Optional cleanup (PM2, Claude CLI) — interactive, skipped with --force
 * Phase 5: Optionally remove ~/zylos/ directory — only with --purge
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { ZYLOS_DIR } from '../lib/config.js';
import { getActiveAdapter } from '../lib/runtime/index.js';
import { bold, dim, green, red, cyan, success, warn, heading } from '../lib/colors.js';
import { promptYesNo } from '../lib/prompts.js';
import { commandExists } from '../lib/shell-utils.js';

// Kill both known runtime sessions on uninstall regardless of which is active
const TMUX_SESSIONS = ['claude-main', 'codex-main'];

export async function selfUninstall(args) {
  const { force, purge } = parseSelfUninstallOptions(args);

  console.log();
  console.log(heading('Zylos Uninstall'));
  console.log();

  // ── Summary ──────────────────────────────────────────
  console.log(bold('This will:'));
  console.log(`  1. Stop all zylos services (tmux + PM2)`);
  console.log(`  2. Uninstall the ${cyan('zylos')} npm package`);
  console.log(`  3. Clean shell PATH entries`);
  if (!force) {
    console.log(`  4. Optionally remove PM2, Claude CLI, and/or Codex CLI`);
  }
  if (purge) {
    console.log(`  ${force ? 4 : 5}. Remove ${cyan('~/zylos/')} data directory`);
  }
  console.log();
  console.log(dim('This will NOT remove Node.js or nvm.'));
  console.log();

  // ── Confirmation ─────────────────────────────────────
  if (!force) {
    const confirmed = await promptYesNo(
      red(bold('Are you sure you want to uninstall zylos? [y/N] '))
    );
    if (!confirmed) {
      console.log('\nCancelled.');
      return;
    }
    console.log();
  }

  // ── Phase 1: Stop Services ───────────────────────────
  console.log(heading('Phase 1: Stopping services'));

  killTmuxSession();
  stopZylosPm2Services();

  console.log(success('Services stopped'));
  console.log();

  // ── Phase 4: Optional cleanup (ask BEFORE removing ~/zylos/) ──
  let removePm2 = false;
  let removeClaude = false;
  let removeCodex = false;

  if (!force) {
    console.log(heading('Optional cleanup'));
    console.log(dim('These tools were installed for zylos but may be used by other software.'));
    console.log();

    if (commandExists('pm2')) {
      removePm2 = await promptYesNo(
        `  Remove PM2? ${dim('(npm uninstall -g pm2 + remove ~/.pm2)')} [y/N] `
      );
    }

    if (commandExists('claude')) {
      removeClaude = await promptYesNo(
        `  Remove Claude CLI? ${dim('(npm uninstall -g + remove ~/.claude/)')} [y/N] `
      );
    }

    if (commandExists('codex')) {
      removeCodex = await promptYesNo(
        `  Remove Codex CLI? ${dim('(npm uninstall -g @openai/codex + remove ~/.codex/)')} [y/N] `
      );
    }
    console.log();
  }

  // ── Phase 2: Uninstall npm package ───────────────────
  console.log(heading('Phase 2: Uninstalling zylos package'));

  const npmOk = npmUninstallGlobal('zylos');
  if (npmOk) {
    console.log(success('zylos package uninstalled'));
  } else {
    console.log(warn('Could not uninstall zylos package (may already be removed)'));
  }
  console.log();

  // ── Phase 3: Clean shell config ──────────────────────
  console.log(heading('Phase 3: Cleaning shell config'));

  const profilesCleaned = cleanShellProfiles();
  if (profilesCleaned.length > 0) {
    console.log(success(`Shell profiles cleaned: ${profilesCleaned.join(', ')}`));
  } else {
    console.log(dim('  No shell profile changes needed'));
  }
  console.log();

  // ── Execute phase 4 choices ──────────────────────────
  if (removePm2) {
    console.log(dim('Removing PM2...'));
    uninstallPm2();
    console.log(success('PM2 removed'));
  }

  if (removeClaude) {
    console.log(dim('Removing Claude CLI...'));
    uninstallClaudeCli();
    console.log(success('Claude CLI removed'));
  }

  if (removeCodex) {
    console.log(dim('Removing Codex CLI...'));
    uninstallCodexCli();
    console.log(success('Codex CLI removed'));
  }

  // ── Phase 5: Data directory removal (explicit opt-in) ──
  let confirmedDataRemoval = false;
  if (purge && !force) {
    console.log();
    console.log(heading('Data directory'));
    console.log(red(bold('  ⚠  WARNING: ~/zylos/ contains your memory, skills, and configuration.')));
    console.log(red(bold('     This data cannot be recovered once deleted.')));
    console.log();
    confirmedDataRemoval = await promptYesNo(
      red(bold('  Delete ~/zylos/ permanently? [y/N] '))
    );
  }

  const removeData = shouldRemoveSelfUninstallData({ force, purge, confirmed: confirmedDataRemoval });
  if (removeData) {
    removeDirectory(ZYLOS_DIR);
    console.log(success('zylos data directory removed'));
  } else {
    console.log(dim(`  Data directory preserved at ${cyan('~/zylos/')}`));
    console.log(dim('  You can remove it later with: rm -rf ~/zylos'));
  }

  // ── Done ─────────────────────────────────────────────
  console.log();
  console.log(green(bold('Zylos has been uninstalled.')));

  const shell = (process.env.SHELL || '').split('/').pop() || 'bash';
  const rcFile = shell === 'zsh' ? '~/.zshrc' : '~/.bashrc';
  if (profilesCleaned.length > 0) {
    console.log(dim(`Restart your shell or run: source ${rcFile}`));
  }
}

export function parseSelfUninstallOptions(args = []) {
  return {
    force: args.includes('--force') || args.includes('-f'),
    purge: args.includes('--purge') || args.includes('purge'),
  };
}

export function shouldRemoveSelfUninstallData({ force = false, purge = false, confirmed = false } = {}) {
  if (!purge) return false;
  if (force) return true;
  return confirmed;
}

// ── Phase 1 helpers ──────────────────────────────────────

/**
 * Kill all known runtime tmux sessions (claude-main, codex-main).
 */
function killTmuxSession() {
  for (const session of TMUX_SESSIONS) {
    try {
      execFileSync('tmux', ['kill-session', '-t', session], { stdio: 'pipe' });
      console.log(`  Killed tmux session ${dim(session)}`);
    } catch {
      // Session not found — normal
    }
  }
}

/**
 * Identify and remove all zylos-managed PM2 services.
 * Detection: a PM2 process is zylos-managed if its exec_path or cwd
 * falls under ~/zylos/.
 * @returns {boolean} true if PM2 was available and services were cleaned
 */
function stopZylosPm2Services() {
  if (!commandExists('pm2')) {
    console.log(`  ${dim('PM2 not found, skipping')}`);
    return false;
  }

  let processes;
  try {
    const result = spawnSync('pm2', ['jlist'], { encoding: 'utf8', stdio: 'pipe' });
    const parsed = JSON.parse(result.stdout);
    if (!Array.isArray(parsed)) throw new Error('not an array');
    processes = parsed;
  } catch {
    console.log(`  ${dim('Could not read PM2 process list')}`);
    return false;
  }

  const zylosProcesses = processes.filter((p) => {
    const exec = p.pm2_env?.pm_exec_path || '';
    const cwd = p.pm2_env?.pm_cwd || '';
    return isUnderZylos(exec) || isUnderZylos(cwd);
  });

  if (zylosProcesses.length === 0) {
    console.log(`  ${dim('No zylos PM2 services found')}`);
    return true;
  }

  for (const p of zylosProcesses) {
    try {
      execFileSync('pm2', ['delete', p.name], { stdio: 'pipe' });
      console.log(`  Removed PM2 service ${dim(p.name)}`);
    } catch {
      console.log(`  ${dim(`Could not remove ${p.name}`)}`);
    }
  }

  // Save so pm2 resurrect won't restore them.
  // --force is needed because pm2 refuses to save an empty process list by default.
  try {
    execFileSync('pm2', ['save', '--force'], { stdio: 'pipe' });
  } catch {
    // non-fatal
  }

  return true;
}

/**
 * Check if a path is under the zylos directory.
 */
function isUnderZylos(filePath) {
  if (!filePath) return false;
  return filePath === ZYLOS_DIR || filePath.startsWith(ZYLOS_DIR + '/');
}

// ── Phase 2 helpers ──────────────────────────────────────

/**
 * Run npm uninstall -g for a package.
 * @returns {boolean} true if successful
 */
function npmUninstallGlobal(pkg) {
  try {
    execFileSync('npm', ['uninstall', '-g', pkg], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// ── Phase 3 helpers ──────────────────────────────────────

/**
 * Remove zylos-related PATH entries from shell profile files.
 * Removes lines containing "zylos" that modify PATH or were added by zylos.
 * @returns {string[]} list of profile files that were modified
 */
function cleanShellProfiles() {
  const homedir = os.homedir();
  const profiles = ['.bashrc', '.zshrc', '.profile', '.bash_profile'];
  const modified = [];

  for (const name of profiles) {
    const filePath = path.join(homedir, name);
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue; // file doesn't exist
    }

    // Remove lines added by zylos (the comment + the export line)
    const original = content;
    const lines = content.split('\n');
    const filtered = lines.filter((line) => {
      // Remove "# Added by zylos" comment lines
      if (/^#\s*added by zylos/i.test(line)) return false;
      // Remove PATH exports that reference zylos directories
      if (/export\s+PATH=.*zylos/i.test(line)) return false;
      return true;
    });

    if (filtered.length === lines.length) continue; // nothing removed

    // Clean up consecutive blank lines left behind by removal
    content = filtered.join('\n').replace(/\n{3,}/g, '\n\n');

    if (content !== original) {
      fs.writeFileSync(filePath, content);
      modified.push(`~/${name}`);
    }
  }

  return modified;
}

/**
 * Remove the zylos directory.
 */
function removeDirectory(dirPath) {
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
  } catch (err) {
    console.log(warn(`Could not fully remove ${dirPath}: ${err.message}`));
  }
}

// ── Phase 4 helpers ──────────────────────────────────────

/**
 * Fully remove PM2: unstartup, uninstall, remove data dir.
 */
function uninstallPm2() {
  // Remove startup hook
  try {
    // pm2 unstartup outputs a sudo command that needs to be run
    const result = spawnSync('pm2', ['unstartup'], { encoding: 'utf8', stdio: 'pipe' });
    const sudoCmd = (result.stdout + result.stderr).match(/sudo .+/)?.[0];
    if (sudoCmd) {
      spawnSync('bash', ['-c', sudoCmd], { stdio: 'pipe' });
    }
  } catch {
    // non-fatal
  }

  // Kill PM2 daemon
  try {
    execFileSync('pm2', ['kill'], { stdio: 'pipe' });
  } catch {
    // non-fatal
  }

  npmUninstallGlobal('pm2');

  // Remove PM2 data directory
  const pm2Dir = path.join(os.homedir(), '.pm2');
  removeDirectory(pm2Dir);
}

/**
 * Remove Claude CLI and its data directory.
 */
function uninstallClaudeCli() {
  npmUninstallGlobal('@anthropic-ai/claude-code');

  const claudeDir = path.join(os.homedir(), '.claude');
  removeDirectory(claudeDir);
}

/**
 * Remove Codex CLI and its config directory.
 */
function uninstallCodexCli() {
  npmUninstallGlobal('@openai/codex');

  const codexDir = path.join(os.homedir(), '.codex');
  removeDirectory(codexDir);
}
