import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
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

before(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-selfup-test-'));
  process.env.ZYLOS_DIR = tmpRoot;
  skillsDir = path.join(tmpRoot, '.claude', 'skills');
  ({ syncCoreSkills } = await import('../cli/lib/self-upgrade.js'));
  ({ generateManifest, saveManifest } = await import('../cli/lib/manifest.js'));
});

after(() => {
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

describe('syncCoreSkills preserved aggregation', () => {
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

    assert.deepEqual(result.errors, []);
    assert.ok(result.preserved.includes('demo-skill/gone.js'));
    // The skill must register as changed — previously this scenario
    // reported "no changes" while the manifest lost the file's ownership
    assert.ok(result.synced.includes('demo-skill'));
    assert.equal(result.pendingBaselines.length, 1);
    assert.equal(result.pendingBaselines[0].destDir, destDir);
    // File kept in place with the user's content
    assert.equal(fs.readFileSync(path.join(destDir, 'gone.js'), 'utf8'), 'user changes');
  });

  test('unmodified upstream-removed file: deleted, counted, not preserved', () => {
    const destDir = path.join(skillsDir, 'demo-skill');
    writeFile(destDir, 'a.js', 'stable');
    writeFile(destDir, 'gone.js', 'untouched');
    saveManifest(destDir, generateManifest(destDir));

    const newSkillsSrc = fs.mkdtempSync(path.join(tmpRoot, 'src-'));
    writeFile(path.join(newSkillsSrc, 'demo-skill'), 'a.js', 'stable');

    const result = syncCoreSkills(newSkillsSrc, null);

    assert.deepEqual(result.errors, []);
    assert.ok(result.deleted.includes('demo-skill/gone.js'));
    assert.deepEqual(result.preserved, []);
    assert.ok(result.synced.includes('demo-skill'));
    assert.equal(result.pendingBaselines.length, 1);
    assert.equal(fs.existsSync(path.join(destDir, 'gone.js')), false);
  });
});
