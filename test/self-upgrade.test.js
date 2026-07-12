import { describe, test, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ZYLOS_DIR is baked into config.js at import time — point it at a temp dir
// BEFORE importing self-upgrade.js so SKILLS_DIR lands inside the sandbox.
let tmpRoot;
let skillsDir;
let syncCoreSkills;
let generateManifest;
let saveManifest;

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-selfup-test-'));
  process.env.ZYLOS_DIR = tmpRoot;
  skillsDir = path.join(tmpRoot, '.claude', 'skills');
  ({ syncCoreSkills } = await import('../cli/lib/self-upgrade.js'));
  ({ generateManifest, saveManifest } = await import('../cli/lib/manifest.js'));
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(skillsDir, { recursive: true, force: true });
});

function writeFile(dir, relPath, content) {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

describe('syncCoreSkills preserved aggregation (#715 review)', () => {
  test('preserved files are aggregated, skill counts as synced, no false "no changes"', () => {
    // Installed skill: manifest tracks a.js + gone.js
    const destDir = path.join(skillsDir, 'demo-skill');
    writeFile(destDir, 'a.js', 'stable');
    writeFile(destDir, 'gone.js', 'original');
    saveManifest(destDir, generateManifest(destDir));

    // User modifies the file upstream is about to remove
    writeFile(destDir, 'gone.js', 'user changes');

    // New version ships only a.js, unchanged — the ONLY delta is the
    // upstream-deleted + locally-modified file
    const newSkillsSrc = fs.mkdtempSync(path.join(tmpRoot, 'src-'));
    writeFile(path.join(newSkillsSrc, 'demo-skill'), 'a.js', 'stable');

    const result = syncCoreSkills(newSkillsSrc, null);

    expect(result.errors).toEqual([]);
    expect(result.preserved).toContain('demo-skill/gone.js');
    // The skill must register as changed — previously this scenario
    // reported "no changes" while the manifest lost the file's ownership
    expect(result.synced).toContain('demo-skill');
    expect(result.pendingBaselines).toHaveLength(1);
    expect(result.pendingBaselines[0].destDir).toBe(destDir);
    // File kept in place with the user's content
    expect(fs.readFileSync(path.join(destDir, 'gone.js'), 'utf8')).toBe('user changes');
  });

  test('unmodified upstream-removed file: deleted, counted, not preserved', () => {
    const destDir = path.join(skillsDir, 'demo-skill');
    writeFile(destDir, 'a.js', 'stable');
    writeFile(destDir, 'gone.js', 'untouched');
    saveManifest(destDir, generateManifest(destDir));

    const newSkillsSrc = fs.mkdtempSync(path.join(tmpRoot, 'src-'));
    writeFile(path.join(newSkillsSrc, 'demo-skill'), 'a.js', 'stable');

    const result = syncCoreSkills(newSkillsSrc, null);

    expect(result.errors).toEqual([]);
    expect(result.deleted).toContain('demo-skill/gone.js');
    expect(result.preserved).toEqual([]);
    expect(result.synced).toContain('demo-skill');
    expect(result.pendingBaselines).toHaveLength(1);
    expect(fs.existsSync(path.join(destDir, 'gone.js'))).toBe(false);
  });
});
