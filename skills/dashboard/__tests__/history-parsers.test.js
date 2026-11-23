import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { safeFullText } from '../src/lib/history/inbound-parser.js';
import { loadCoreModule as loadTranscriptCore } from '../src/lib/core-modules.js';
const { getRuntime: getTranscriptRuntime } = await loadTranscriptCore('runtime/index.js');
const { transcript: claudeTranscript } = (await getTranscriptRuntime('claude')).usage;

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'history-parser-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const homeDir = path.join(root, 'home');
  const zylosDir = path.join(homeDir, 'zylos.test_dir');
  await fs.mkdir(zylosDir, { recursive: true });
  const projectDir = claudeTranscript.projectDir({ home: homeDir, zylosDir: zylosDir });
  await fs.mkdir(projectDir, { recursive: true });
  return { root, homeDir, zylosDir, projectDir };
}

test('full text allowlists recover real files and reject traversal, symlink and foreign files', async t => {
  const options = await fixture(t);
  const conv = path.join(options.zylosDir, 'comm-bridge', 'attachments', 'conv-12');
  await fs.mkdir(conv, { recursive: true });
  const file = path.join(conv, 'message.txt'); await fs.writeFile(file, 'complete inbound');
  assert.equal((await safeFullText(file, options)).text, 'complete inbound');
  const outside = path.join(options.root, 'outside.txt'); await fs.writeFile(outside, 'DO NOT READ');
  assert.ok((await safeFullText(outside, options)).unavailable);
  assert.ok((await safeFullText(`${conv}/../conv-12/message.txt`, options)).unavailable);
  await fs.rename(file, path.join(conv, 'original.txt')); await fs.symlink(outside, file);
  assert.ok((await safeFullText(file, options)).unavailable);
  assert.ok((await safeFullText(path.join(conv, 'missing.txt'), options)).unavailable);
});
