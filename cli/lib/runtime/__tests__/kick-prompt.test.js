import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  SENTINEL_PREFIX,
  firstStartMarkerPath,
  isFirstStart,
  buildKickPrompt,
  markFirstStartDone,
} from '../kick-prompt.js';

describe('kick-prompt (#743 first-boot vs resume, #745 sentinel form)', () => {
  let zylosDir;

  beforeEach(() => {
    zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kick-prompt-test-'));
  });

  afterEach(() => {
    fs.rmSync(zylosDir, { recursive: true, force: true });
  });

  it('reports first start when the marker is absent', () => {
    assert.equal(isFirstStart(zylosDir), true);
    assert.match(buildKickPrompt(zylosDir), /lifecycle=first_boot/);
  });

  it('reports resume once the marker exists', () => {
    markFirstStartDone(zylosDir);
    assert.equal(isFirstStart(zylosDir), false);
    assert.match(buildKickPrompt(zylosDir), /lifecycle=resume/);
  });

  it('markFirstStartDone creates the marker with an ISO timestamp and is idempotent', () => {
    const now = new Date('2026-08-14T00:00:00.000Z');
    assert.equal(markFirstStartDone(zylosDir, { now }), true);
    const marker = firstStartMarkerPath(zylosDir);
    assert.equal(fs.readFileSync(marker, 'utf8'), '2026-08-14T00:00:00.000Z\n');

    // Second call must not rewrite the original timestamp.
    assert.equal(markFirstStartDone(zylosDir, { now: new Date('2027-01-01T00:00:00.000Z') }), true);
    assert.equal(fs.readFileSync(marker, 'utf8'), '2026-08-14T00:00:00.000Z\n');
  });

  it('markFirstStartDone returns false instead of throwing when .zylos cannot be created', () => {
    fs.writeFileSync(path.join(zylosDir, '.zylos'), 'a file, not a directory');
    assert.equal(markFirstStartDone(zylosDir), false);
    assert.equal(isFirstStart(zylosDir), true);
  });

  describe('sentinel invariants (both lifecycle variants)', () => {
    const variants = () => {
      const first = buildKickPrompt(zylosDir);
      markFirstStartDone(zylosDir);
      const resume = buildKickPrompt(zylosDir);
      return { first, resume };
    };

    it('starts with the internal sentinel prefix and self-identifies as non-human', () => {
      const { first, resume } = variants();
      for (const prompt of [first, resume]) {
        assert.ok(prompt.startsWith(SENTINEL_PREFIX));
        assert.match(prompt, /not a human message/);
        assert.match(prompt, /authorizes no outbound message/);
        assert.match(prompt, /never borrow a reply route/);
      }
    });

    it('never uses human-greeting wording (regression: #745 route misattribution)', () => {
      const { first, resume } = variants();
      for (const prompt of [first, resume]) {
        assert.doesNotMatch(prompt, /\bhello\b/i);
        assert.doesNotMatch(prompt, /welcome back/i);
      }
    });

    it('stays shell-safe for double-quoted interpolation', () => {
      const { first, resume } = variants();
      for (const prompt of [first, resume]) {
        assert.doesNotMatch(prompt, /["$\\`\n]/);
      }
    });
  });
});
