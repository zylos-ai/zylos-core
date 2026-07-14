import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { emitMigrationPrompt, migrationPromptPaths } from '../emit-migration-prompt.js';

const tmpDirs = [];

function makeZylosDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-prompt-test-'));
  tmpDirs.push(dir);
  return dir;
}

function write(pathname, content = '') {
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  fs.writeFileSync(pathname, content);
}

afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

describe('migrationPromptPaths', () => {
  it('uses only the stable Zylos data paths', () => {
    assert.deepEqual(migrationPromptPaths({ zylosDir: '/opt/zy' }), {
      markerPath: path.join('/opt/zy', '.zylos', 'instructions', 'meta.json'),
      promptPath: path.join('/opt/zy', '.zylos', 'pending-migration-prompt.md'),
    });
  });
});

describe('emitMigrationPrompt', () => {
  it('emits the wrapped prompt while the marker is inactive', () => {
    const zylosDir = makeZylosDir();
    const { promptPath } = migrationPromptPaths({ zylosDir });
    write(promptPath, '\nInspect ZYLOS.md and migrate it.\n');

    assert.equal(
      emitMigrationPrompt({ zylosDir }),
      '=== PENDING MIGRATION ===\nInspect ZYLOS.md and migrate it.'
    );
  });

  it('emits nothing while inactive when the prompt is absent or unreadable', () => {
    const zylosDir = makeZylosDir();
    assert.equal(emitMigrationPrompt({ zylosDir }), '');

    const real = migrationPromptPaths({ zylosDir });
    const io = {
      existsSync: pathname => pathname === real.promptPath,
      readFileSync: () => { throw new Error('read fault'); },
    };
    assert.equal(emitMigrationPrompt({ zylosDir, io }), '');
  });

  it('suppresses and deletes a stale prompt when the marker is active', () => {
    const zylosDir = makeZylosDir();
    const { markerPath, promptPath } = migrationPromptPaths({ zylosDir });
    write(markerPath, '{}\n');
    write(promptPath, 'STALE');

    assert.equal(emitMigrationPrompt({ zylosDir }), '');
    assert.equal(fs.existsSync(promptPath), false);
  });

  it('still suppresses when active prompt cleanup fails', () => {
    const zylosDir = makeZylosDir();
    const { markerPath, promptPath } = migrationPromptPaths({ zylosDir });
    write(markerPath, '{}\n');
    write(promptPath, 'STALE');
    const io = {
      existsSync: fs.existsSync,
      unlinkSync: () => { throw new Error('unlink fault'); },
      readFileSync: fs.readFileSync,
    };

    assert.equal(emitMigrationPrompt({ zylosDir, io }), '');
    assert.equal(fs.existsSync(promptPath), true);
  });

  it('is silent on an active clean machine', () => {
    const zylosDir = makeZylosDir();
    const { markerPath } = migrationPromptPaths({ zylosDir });
    write(markerPath, '{}\n');
    assert.equal(emitMigrationPrompt({ zylosDir }), '');
  });
});
