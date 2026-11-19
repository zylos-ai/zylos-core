import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { deployTemplates, syncCoreSkills } from '../../cli/commands/init.js';
import { buildInstructionFile, instructionPaths } from '../../cli/lib/runtime/instruction-builder.js';
import { prepareUpgradeRuntime } from '../../cli/lib/upgrade-runtime-preparation.js';
import { loadPostUpgradeSync, preparePostCutoff, publishPostCutoff } from '../../cli/lib/upgrade-post-cutoff.js';

const postUpgradeSync = await loadPostUpgradeSync();

const root = process.env.ZYLOS_DIR;
const mode = process.argv[2];
const user = '# Owner custom instructions\n\nKeep duplicate lines.\nKeep duplicate lines.\n中文与 literal $HOME.\n';
const sync = syncCoreSkills();
assert.ok(sync.installed.includes('comm-bridge'));
deployTemplates({ freshInstall: true });
assert.equal(fs.readFileSync(path.join(root, 'ZYLOS.md'), 'utf8'),
  fs.readFileSync(new URL('../../templates/ZYLOS.md', import.meta.url), 'utf8'));
for (const runtime of ['claude', 'codex']) {
  const paths = instructionPaths(runtime, { zylosDir: root });
  const seed = fs.readFileSync(paths.userPath, 'utf8');
  assert.ok(fs.readFileSync(paths.outputPath, 'utf8').endsWith(`${seed.trimEnd()}\n`), runtime);
}
fs.writeFileSync(path.join(root, 'ZYLOS.md'), user);
for (const runtime of ['claude', 'codex']) buildInstructionFile(runtime, { zylosDir: root, force: true });

if (mode === 'refresh') {
  // Simulate an already activated split generation with stale managed assets;
  // only fixture data changes, never product source or the user file.
  for (const runtime of ['claude', 'codex']) {
    const paths = instructionPaths(runtime, { zylosDir: root });
    fs.writeFileSync(paths.systemPath, '# Previous managed instructions\n');
    fs.writeFileSync(paths.outputPath, 'Previous generated instructions\n');
  }
  const preparation = prepareUpgradeRuntime({ zylosDir: root }, {
    homeDir: process.env.HOME, stopFailureSupported: false, subagentHooksSupported: false,
  });
  assert.equal(preparation.replacements.some(item => item.path === 'ZYLOS.md'), false);
  const transactionDir = path.join(process.env.TMPDIR, 'transaction');
  fs.mkdirSync(transactionDir);
  const postCutoff = preparePostCutoff({ ...preparation, transactionDir, zylosDir: root, sync: postUpgradeSync });
  const transactionId = 'instruction-deployment-test';
  const snapshotManifestHash = 'a'.repeat(64);
  const journal = { transactionId, zylosDir: root, phase: 'compensation_closed', snapshotManifestHash,
    compensationCutoff: { formatVersion: 1, closed: true, transactionId, snapshotManifestHash,
      writer: 'finalizer', closedAt: new Date().toISOString() }, postCutoff };
  const published = await publishPostCutoff({ transactionDir, transactionId, journal }, {
    persist: (current, changes) => Object.assign(current, changes),
  });
  assert.equal(published.ok, true, JSON.stringify(published.lastError));
}

assert.equal(fs.readFileSync(path.join(root, 'ZYLOS.md'), 'utf8'), user);
for (const runtime of ['claude', 'codex']) {
  const paths = instructionPaths(runtime, { zylosDir: root });
  const system = fs.readFileSync(paths.systemPath, 'utf8');
  const packaged = fs.readFileSync(new URL(`../../templates/${runtime}-system.md`, import.meta.url), 'utf8');
  const output = fs.readFileSync(paths.outputPath, 'utf8');
  assert.equal(system, packaged);
  assert.match(output, /zylos-generated:split-v1/);
  assert.ok(output.endsWith(`${system.trimEnd()}\n\n${user}`), runtime);
}
const reference = path.join(root, '.claude/skills/comm-bridge/references/handoff-follow-up.md');
fs.accessSync(reference, fs.constants.R_OK);
assert.equal(fs.readFileSync(reference, 'utf8'), fs.readFileSync(new URL('../../skills/comm-bridge/references/handoff-follow-up.md', import.meta.url), 'utf8'));
fs.writeFileSync(path.join(root, 'memory/handoff.md'), 'unfinished work\n');
console.log('Instruction deployment and installed handoff reference verified.');
