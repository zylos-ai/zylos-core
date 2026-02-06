/**
 * Claude-powered evaluation of local modifications during component upgrades.
 *
 * Uses `claude --print` to assess whether an upgrade is safe given the user's
 * local changes, producing per-file verdicts (safe / warning / conflict).
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseSkillMd } from './skill.js';

const MAX_FILE_LINES = 500;
const MAX_FILES = 10;
const TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readFileSafe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function truncateLines(content, max) {
  if (!content) return content;
  const lines = content.split('\n');
  if (lines.length <= max) return content;
  return lines.slice(0, max).join('\n') + `\n... (truncated, ${lines.length - max} more lines)`;
}

// ---------------------------------------------------------------------------
// Build diff context
// ---------------------------------------------------------------------------

function buildDiffContext(localChanges, skillDir, tempDir) {
  const diffs = [];
  const files = [...localChanges.modified, ...localChanges.added];

  for (const file of files.slice(0, MAX_FILES)) {
    const localContent = readFileSafe(path.join(skillDir, file));
    const newContent = readFileSafe(path.join(tempDir, file));
    diffs.push({
      file,
      local: truncateLines(localContent, MAX_FILE_LINES),
      new: truncateLines(newContent, MAX_FILE_LINES),
    });
  }

  // Note deleted files (exist in new but removed locally)
  for (const file of localChanges.deleted.slice(0, MAX_FILES - diffs.length)) {
    const newContent = readFileSafe(path.join(tempDir, file));
    diffs.push({
      file,
      local: null,
      new: truncateLines(newContent, MAX_FILE_LINES),
    });
  }

  const skipped = files.length + localChanges.deleted.length - diffs.length;
  return { diffs, skipped };
}

// ---------------------------------------------------------------------------
// Construct prompt
// ---------------------------------------------------------------------------

function buildPrompt({ component, diffs, skipped, changelog, preserveList }) {
  const changelogSnippet = changelog
    ? changelog.slice(0, 2000)
    : '(no changelog available)';

  const preserveNote = preserveList.length > 0
    ? `\nPreserved files (excluded from overwrite during upgrade): ${preserveList.join(', ')}\n`
    : '';

  let fileSection = '';
  for (const d of diffs) {
    fileSection += `\n--- ${d.file} ---\n`;
    if (d.local !== null) {
      fileSection += `[LOCAL]\n${d.local}\n`;
    } else {
      fileSection += `[LOCAL] (file deleted by user)\n`;
    }
    if (d.new !== null) {
      fileSection += `[NEW]\n${d.new}\n`;
    } else {
      fileSection += `[NEW] (file does not exist in upgrade)\n`;
    }
  }

  if (skipped > 0) {
    fileSection += `\n(... and ${skipped} more files not shown)\n`;
  }

  return `You are evaluating whether a component upgrade is safe given local modifications.

Component: ${component}
Changelog:
${changelogSnippet}
${preserveNote}
The following files have local modifications. For each, the LOCAL version (user's current) and NEW version (from upgrade) are shown.
${fileSection}
Evaluate each modified file and respond in JSON:
{
  "safe": boolean,
  "recommendation": "one-line summary",
  "files": [
    { "file": "...", "verdict": "safe|warning|conflict", "reason": "..." }
  ]
}

Rules:
- "safe": file is in the preserve list (never overwritten), or local change is in a config/user area, or new version did not change the same section
- "warning": new version changed related areas, user should review after upgrade
- "conflict": new version changed the exact same code the user modified — data loss risk
- Keep reasons concise (one sentence each)
- Respond ONLY with the JSON object, no markdown fencing`;
}

// ---------------------------------------------------------------------------
// Call Claude CLI
// ---------------------------------------------------------------------------

function callClaude(prompt) {
  return new Promise((resolve) => {
    let stdout = '';
    let settled = false;

    const child = spawn('claude', ['--print', '--output-format', 'text'], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { ...process.env },
    });

    child.stdin.on('error', () => {}); // Ignore EPIPE if child exits early
    child.stdout.on('data', (chunk) => { stdout += chunk; });

    child.on('error', () => {
      if (!settled) { settled = true; resolve(null); }
    });

    child.on('close', (code) => {
      if (!settled) {
        settled = true;
        resolve(code === 0 ? stdout : null);
      }
    });

    const timer = setTimeout(() => {
      if (!settled) { settled = true; child.kill(); resolve(null); }
    }, TIMEOUT_MS);

    child.on('close', () => clearTimeout(timer));

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// Parse response
// ---------------------------------------------------------------------------

function parseResponse(raw) {
  if (!raw) return null;

  // Strip markdown fencing if present despite instructions
  let text = raw.trim();
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }

  try {
    const result = JSON.parse(text);
    if (typeof result.safe !== 'boolean' || !result.recommendation || !Array.isArray(result.files)) {
      return null;
    }
    // Validate each file entry
    for (const f of result.files) {
      if (!f.file || !f.verdict || !f.reason) return null;
    }
    return result;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Evaluate whether an upgrade is safe given local modifications.
 *
 * @param {object} opts
 * @param {string} opts.component  - Component name
 * @param {object} opts.localChanges - { modified: string[], added: string[], deleted: string[] }
 * @param {string} opts.tempDir    - Path to downloaded new version
 * @param {string} opts.skillDir   - Path to installed component
 * @param {string|null} opts.changelog - Changelog text (may be null)
 * @returns {Promise<object|null>} Evaluation result or null on failure
 */
export async function evaluateUpgrade({ component, localChanges, tempDir, skillDir, changelog }) {
  // Nothing to evaluate
  if (!localChanges) return null;
  const totalFiles = localChanges.modified.length + localChanges.added.length;
  if (totalFiles === 0) return null;

  const { diffs, skipped } = buildDiffContext(localChanges, skillDir, tempDir);
  if (diffs.length === 0) return null;

  // Read preserve list from new SKILL.md (preserved files are never overwritten)
  const newSkill = parseSkillMd(tempDir);
  const preserveList = newSkill?.frontmatter?.lifecycle?.preserve || [];

  const prompt = buildPrompt({ component, diffs, skipped, changelog, preserveList });
  const raw = await callClaude(prompt);
  return parseResponse(raw);
}
