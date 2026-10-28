import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareUpgradeRuntime, prepareUpgradeRuntimeClis } from '../upgrade-runtime-preparation.js';
import { preparePostCutoff, validatePostCutoff, publishRuntimePreparation } from '../upgrade-post-cutoff.js';
import { loadInstructionCatalog, migrationPromptPath, sha256 } from '../instruction-migration.js';
import { isMigrationPending } from '../../../skills/activity-monitor/scripts/session-start-prompt.js';

const packageRoot = path.resolve(import.meta.dirname, '../../..');

test('upgrade reuses P06 CLI preparation without login or touching the running runtime', async () => {
  const installed = new Set(['claude']), calls = [];
  const result = await prepareUpgradeRuntimeClis({}, {
    exists: runtime => installed.has(runtime),
    install: { claude() { throw Error('existing runtime must not be replaced'); },
      codex() { calls.push('install-codex'); installed.add('codex'); return true; } },
  });
  assert.deepEqual(result.completed, ['claude.cli', 'codex.cli']);
  assert.deepEqual(result.installed, ['codex']);
  assert.deepEqual(result.failed, []);
  assert.equal(calls.filter(item => item === 'install-codex').length, 1);
});

test('runtime preparation refuses failed install', async () => {
  await assert.rejects(prepareUpgradeRuntimeClis({}, { exists: () => false,
    install: { claude: () => false, codex: () => false } }), { code: 'RUNTIME_PREPARATION_INCOMPLETE' });
});
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-preparation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const zylosDir = path.join(root, 'zylos');
  const write = (name, bytes) => {
    const file = path.join(zylosDir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
  };
  write('ZYLOS.md', 'user bytes\r\n  keep trailing  \r\n');
  write('CLAUDE.md', 'old Claude'); write('AGENTS.md', 'old Codex');
  write('.zylos/instructions/meta.json', '{"schemaVersion":1,"activatedAt":"old"}\n');
  write('.claude/settings.json', '{"permissions":{"allow":["Read"]},"hooks":{}}\n');
  const ctx = { zylosDir, tempDir: packageRoot };
  const prepare = options => prepareUpgradeRuntime(ctx, { homeDir: root, stopFailureSupported: false, ...options });
  return { root, zylosDir, write, ctx, prepare };
}
function snapshot(dir) {
  const result = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) for (const [name, bytes] of Object.entries(snapshot(file))) result[`${entry.name}/${name}`] = bytes;
    else result[entry.name] = fs.readFileSync(file).toString('base64');
  }
  return result;
}

test('split preparation changes no live bytes and stages both runtimes, assets and packaged agents', t => {
  const f = fixture(t), before = snapshot(f.zylosDir);
  const prepared = f.prepare();
  assert.deepEqual(snapshot(f.zylosDir), before);
  assert.equal(prepared.replacements.some(r => r.path === 'ZYLOS.md'), false);
  for (const name of ['CLAUDE.md', 'AGENTS.md']) {
    const output = prepared.replacements.find(r => r.path === name).content;
    assert.ok(output.includes(`user: ${f.zylosDir}/ZYLOS.md\n`));
    assert.ok(output.includes('user bytes\r\n  keep trailing'));
    assert.equal(output.includes('zylos-upgrade-render-'), false);
  }
  for (const name of ['assembler.mjs', 'claude-system.md', 'codex-system.md', 'onboarding.md', 'meta.json']) {
    assert.ok(prepared.replacements.find(r => r.path === `.zylos/instructions/${name}`));
  }
  const agents = prepared.replacements.filter(item => item.path.startsWith('.claude/agents/'));
  assert.equal(agents.length, 3);
  for (const { path: name } of agents) {
    const bytes = prepared.replacements.find(r => r.path === name).content;
    assert.deepEqual(bytes, fs.readFileSync(path.join(packageRoot, 'skills/zylos-memory/agents', path.basename(name))));
  }
});

test('prepared replacements are valid protected publication material without live writes', t => {
  const f = fixture(t), prepared = f.prepare();
  const transactionDir = path.join(f.root, 'transaction'); fs.mkdirSync(transactionDir);
  const postCutoff = preparePostCutoff({ ...prepared, transactionDir, zylosDir: f.zylosDir });
  assert.equal(validatePostCutoff({ transactionDir, journal: { postCutoff, zylosDir: f.zylosDir } }).length,
    prepared.replacements.length);
  assert.equal(fs.existsSync(path.join(f.zylosDir, '.claude/agents')), false);
  assert.equal(fs.existsSync(path.join(f.zylosDir, '.codex')), false);
});

test('first preparation includes staged assembler in all three SessionStart matchers', t => {
  const f=fixture(t);
  assert.equal(fs.existsSync(path.join(f.zylosDir,'.zylos/instructions/assembler.mjs')),false);
  const result=f.prepare();
  const settings=JSON.parse(result.replacements.find(item=>item.kind==='claude_settings').content);
  const assemblerGroups=settings.hooks.SessionStart.filter(group=>group.hooks.some(hook=>hook.command.includes('assembler.mjs')));
  assert.equal(assemblerGroups.length,3);
  for(const group of assemblerGroups) assert.equal(group.hooks.filter(hook=>hook.command.includes('assembler.mjs')).length,1);
  assert.equal(fs.existsSync(path.join(f.zylosDir,'.zylos/instructions/assembler.mjs')),false);
});

test('Codex runtime staging captures the intended home despite CODEX_HOME',t=>{
  const f=fixture(t);
  f.write('.zylos/config.json',JSON.stringify({runtime:'codex'}));
  const previous=process.env.CODEX_HOME;
  process.env.CODEX_HOME=path.join(f.root,'unrelated-codex');
  try {
    const prepared=f.prepare();
    const transactionDir=path.join(f.root,'transaction');fs.mkdirSync(transactionDir);
    const staged=preparePostCutoff({...prepared,transactionDir,zylosDir:f.zylosDir});
    assert.equal(prepared.runtime,'codex');
    assert.equal(staged.items.hooks.codexGlobalDir,path.join(f.root,'.codex'));
    assert.equal(fs.existsSync(process.env.CODEX_HOME),false);
  } finally {
    if(previous===undefined)delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME=previous;
  }
});

test('Claude settings preserve user settings, remove only exact Dashboard commands, qualify health hooks', t => {
  const f = fixture(t);
  const command = `node ${f.zylosDir}/.claude/skills/dashboard/src/lib/hook-ingest.cjs`;
  f.write('.claude/settings.json', JSON.stringify({ model: 'custom-model', hooks: {
    SessionStart: [{ matcher: 'custom', hooks: [{ command }, { command: `${command} --user` }] }],
  }, permissions: { allow: ['Read'] } }));
  for (const supported of [true, false]) {
    const result = f.prepare({ stopFailureSupported: supported });
    const settings = JSON.parse(result.replacements.find(r => r.kind === 'claude_settings').content);
    assert.equal(settings.model, 'custom-model');
    assert.deepEqual(settings.permissions, { allow: ['Read'] });
    assert.ok(JSON.stringify(settings).includes('--user'));
    assert.equal(settings.hooks.SessionStart.find(g => g.matcher === 'custom').hooks.length, 1);
    assert.equal(Boolean(settings.hooks.StopFailure?.length), supported);
  }
});

test('legacy files and ZYLOS bytes are preserved with truthful pending migration', t => {
  const f = fixture(t); fs.unlinkSync(path.join(f.zylosDir, '.zylos/instructions/meta.json'));
  const before = snapshot(f.zylosDir), result = f.prepare();
  assert.deepEqual(snapshot(f.zylosDir), before);
  assert.equal(result.replacements.some(r => ['CLAUDE.md', 'AGENTS.md', 'ZYLOS.md', '.zylos/instruction-format-version'].includes(r.path)), false);
  assert.ok(result.warnings.some(w => w.includes('pending')));
  assert.match(result.replacements.find(r => r.path.endsWith('90-migration-prompt.md')).content.toString(), /Classification: C/);
});

for (const classification of ['B', 'C']) {
  test(`classification ${classification} stages a migration prompt and publishes it through the real replacement path`, async t => {
    const f = fixture(t);
    fs.unlinkSync(path.join(f.zylosDir, '.zylos/instructions/meta.json'));
    const original = fs.readFileSync(path.join(f.zylosDir, 'ZYLOS.md'));
    const before = snapshot(f.zylosDir);
    const prepared = f.prepare({ classifyBaseline: () => ({ classification, candidates: [] }) });
    const promptRelative = path.relative(f.zylosDir, migrationPromptPath({ zylosDir: f.zylosDir }));
    const prompt = prepared.replacements.find(item => item.path === promptRelative);
    assert.ok(prompt);
    const text = prompt.content.toString();
    assert.match(text, new RegExp(`Classification: ${classification}`));
    assert.ok(text.includes(sha256(original)));
    assert.ok(text.includes(`${f.zylosDir}/.zylos/instructions/claude-system.md`));
    assert.equal(text.includes('zylos-upgrade-render-'), false);
    assert.deepEqual(snapshot(f.zylosDir), before);
    const workDir = path.join(f.root, 'publication'); fs.mkdirSync(workDir);
    const preparation = preparePostCutoff({ ...prepared, transactionDir: workDir, zylosDir: f.zylosDir });
    const published = await publishRuntimePreparation({ workDir, zylosDir: f.zylosDir, preparation });
    assert.equal(published.ok, true);
    assert.equal(fs.readFileSync(path.join(f.zylosDir, promptRelative), 'utf8'), text);
    assert.deepEqual(fs.readFileSync(path.join(f.zylosDir, 'ZYLOS.md')), original);
    assert.equal(fs.readFileSync(path.join(f.zylosDir, 'CLAUDE.md'), 'utf8'), 'old Claude');
  });
}

test('prompt preparation failure stays pending, warns and preserves live bytes', t => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.zylosDir, '.zylos/instructions/meta.json'));
  const before = snapshot(f.zylosDir);
  const prepared = f.prepare({ writePrompt() { throw Error('prompt fault'); } });
  assert.ok(prepared.warnings.some(message => message.includes('prompt fault')));
  assert.deepEqual(snapshot(f.zylosDir), before);
  assert.equal(prepared.replacements.some(item => item.path.endsWith('90-migration-prompt.md')), false);
});

for (const mode of ['split', 'automatic-A']) {
  test(`${mode} activation retires stale migration work only after publication`, async t => {
    const f = fixture(t);
    if (mode === 'automatic-A') {
      fs.unlinkSync(path.join(f.zylosDir, '.zylos/instructions/meta.json'));
      f.write('ZYLOS.md', loadInstructionCatalog()[0].rawContent);
    }
    const promptRelative = path.relative(f.zylosDir, migrationPromptPath({ zylosDir: f.zylosDir }));
    f.write(promptRelative, '# stale migration instructions\n');
    const before = snapshot(f.zylosDir), prepared = f.prepare();
    assert.deepEqual(snapshot(f.zylosDir), before);
    assert.equal(isMigrationPending({ migrationPromptPath: path.join(f.zylosDir, promptRelative) }), true);
    const workDir = path.join(f.root, 'publication'); fs.mkdirSync(workDir);
    const preparation = preparePostCutoff({ ...prepared, transactionDir: workDir, zylosDir: f.zylosDir });
    const published = await publishRuntimePreparation({ workDir, zylosDir: f.zylosDir, preparation });
    assert.equal(published.ok, true);
    assert.equal(isMigrationPending({ migrationPromptPath: path.join(f.zylosDir, promptRelative) }), false);
    assert.equal((await publishRuntimePreparation({ workDir, zylosDir: f.zylosDir, preparation })).ok, true);
  });
}

for (const mode of ['split', 'automatic-A']) {
  test(`${mode} activation does not create an absent migration prompt`, async t => {
    const f = fixture(t);
    if (mode === 'automatic-A') {
      fs.unlinkSync(path.join(f.zylosDir, '.zylos/instructions/meta.json'));
      f.write('ZYLOS.md', loadInstructionCatalog()[0].rawContent);
    }
    const file = migrationPromptPath({ zylosDir: f.zylosDir });
    assert.equal(fs.existsSync(file), false);
    const prepared = f.prepare();
    const workDir = path.join(f.root, 'publication'); fs.mkdirSync(workDir);
    const preparation = preparePostCutoff({ ...prepared, transactionDir: workDir, zylosDir: f.zylosDir });
    assert.equal((await publishRuntimePreparation({ workDir, zylosDir: f.zylosDir, preparation })).ok, true);
    assert.equal(fs.existsSync(file), false);
  });
}

test('concurrent prompt edit rejects staged cleanup and preserves the edit', async t => {
  const f = fixture(t), promptRelative = path.relative(f.zylosDir, migrationPromptPath({ zylosDir: f.zylosDir }));
  f.write(promptRelative, 'stale');
  const prepared = f.prepare(), workDir = path.join(f.root, 'publication'); fs.mkdirSync(workDir);
  const preparation = preparePostCutoff({ ...prepared, transactionDir: workDir, zylosDir: f.zylosDir });
  f.write(promptRelative, 'new user edit');
  const published = await publishRuntimePreparation({ workDir, zylosDir: f.zylosDir, preparation });
  assert.equal(published.ok, false);
  assert.equal(published.lastError.code, 'runtime_config_conflict');
  assert.equal(fs.readFileSync(path.join(f.zylosDir, promptRelative), 'utf8'), 'new user edit');
});

test('legacy missing ZYLOS uses existing conservative migration in scratch only', t => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.zylosDir, '.zylos/instructions/meta.json'));
  fs.unlinkSync(path.join(f.zylosDir, 'ZYLOS.md'));
  const result = f.prepare();
  const user = result.replacements.find(r => r.path === 'ZYLOS.md').content.toString();
  assert.ok(user.endsWith('old Claude'));
  assert.ok(user.includes('MIGRATION NOTE'));
  assert.equal(fs.existsSync(path.join(f.zylosDir, 'ZYLOS.md')), false);
});

test('legacy classification A stages conserved backups before split activation without live writes', async t => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.zylosDir, '.zylos/instructions/meta.json'));
  const baseline = loadInstructionCatalog()[0];
  const userOriginal = Buffer.from(baseline.rawContent);
  const claudeOriginal = Buffer.from([0xff, 0, 13, 10, 32]);
  const codexOriginal = Buffer.from('manual Codex\r\n trailing  \r\n');
  f.write('ZYLOS.md', userOriginal); f.write('CLAUDE.md', claudeOriginal); f.write('AGENTS.md', codexOriginal);
  const before = snapshot(f.zylosDir);
  const result = f.prepare({ generatedAt: new Date('2026-01-01T00:00:00Z') });
  assert.deepEqual(snapshot(f.zylosDir), before);
  const replacement = name => result.replacements.find(item => item.path === name);
  const marker = JSON.parse(replacement('.zylos/instructions/meta.json').content);
  assert.equal(marker.migration.classification, 'A');
  assert.equal(marker.migration.backupPath.includes('zylos-upgrade-render-'), false);
  const backupRelative = path.relative(f.zylosDir, marker.migration.backupPath);
  for (const [name, bytes] of [['ZYLOS.md', userOriginal], ['CLAUDE.md', claudeOriginal], ['AGENTS.md', codexOriginal]]) {
    const saved = replacement(`${backupRelative}/${name}`);
    assert.deepEqual(saved.content, bytes);
    assert.ok(result.replacements.indexOf(saved) < result.replacements.indexOf(replacement(name)));
  }
  assert.deepEqual(replacement('ZYLOS.md').content, fs.readFileSync(path.join(packageRoot, 'templates/ZYLOS.md')));
  for (const name of ['CLAUDE.md', 'AGENTS.md']) {
    assert.equal(replacement(name).content.includes('zylos-upgrade-render-'), false);
    assert.ok(replacement(name).content.includes(`user: ${f.zylosDir}/ZYLOS.md\n`));
  }
  const report = replacement(`${backupRelative}/migration-report.md`).content;
  assert.ok(report.includes(marker.migration.backupPath));
  assert.equal(report.includes('zylos-upgrade-render-'), false);
  const transactionDir = path.join(f.root, 'transaction'); fs.mkdirSync(transactionDir);
  const postCutoff = preparePostCutoff({ ...result, transactionDir, zylosDir: f.zylosDir });
  const materials = validatePostCutoff({ transactionDir, journal: { postCutoff, zylosDir: f.zylosDir } });
  assert.deepEqual(materials.find(item => item.target.path === `${backupRelative}/CLAUDE.md`).staged, claudeOriginal);
  assert.deepEqual(snapshot(f.zylosDir), before);
  const markerTarget = postCutoff.items.hooks.targets.find(item => item.path === '.zylos/instructions/meta.json');
  let sawMarker = false;
  const published = await publishRuntimePreparation({ workDir: transactionDir, zylosDir: f.zylosDir, preparation: postCutoff }, {
    afterStep(id) {
      if (id !== markerTarget.id) return;
      sawMarker = true;
      for (const [name, bytes] of [['ZYLOS.md', userOriginal], ['CLAUDE.md', claudeOriginal], ['AGENTS.md', codexOriginal]]) {
        assert.deepEqual(fs.readFileSync(path.join(marker.migration.backupPath, name)), bytes);
      }
    },
  });
  assert.equal(published.ok, true);
  assert.equal(sawMarker, true);
  assert.deepEqual(fs.readFileSync(path.join(f.zylosDir, 'ZYLOS.md')), replacement('ZYLOS.md').content);
});

test('corrupt staged legacy backup prevents all publication', async t => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.zylosDir, '.zylos/instructions/meta.json'));
  f.write('ZYLOS.md', loadInstructionCatalog()[0].rawContent);
  const before = snapshot(f.zylosDir), result = f.prepare();
  const transactionDir = path.join(f.root, 'transaction'); fs.mkdirSync(transactionDir);
  const postCutoff = preparePostCutoff({ ...result, transactionDir, zylosDir: f.zylosDir });
  const backup = postCutoff.items.hooks.targets.find(item => item.path.startsWith('.backup/') && item.path.endsWith('/ZYLOS.md'));
  fs.writeFileSync(path.join(transactionDir, backup.stagedFile), 'corrupt backup');
  const published = await publishRuntimePreparation({ workDir: transactionDir, zylosDir: f.zylosDir, preparation: postCutoff });
  assert.equal(published.ok, false);
  assert.equal(published.lastError.code, 'material_corrupt');
  assert.deepEqual(snapshot(f.zylosDir), before);
});
test('legacy automatic migration refuses an existing backup destination without live changes', t => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.zylosDir, '.zylos/instructions/meta.json'));
  f.write('ZYLOS.md', loadInstructionCatalog()[0].rawContent);
  f.write('.backup/2026-01-01T00-00-00-000Z/instruction-migration/ZYLOS.md', 'prior backup');
  const before = snapshot(f.zylosDir);
  assert.throws(() => f.prepare({ generatedAt: new Date('2026-01-01T00:00:00Z') }), /backup destination already exists/);
  assert.deepEqual(snapshot(f.zylosDir), before);
});

for (const missingUser of [true, false]) {
  test(`legacy text classification refuses lossy UTF-8 (${missingUser ? 'CLAUDE' : 'ZYLOS'})`, t => {
    const f = fixture(t);
    fs.unlinkSync(path.join(f.zylosDir, '.zylos/instructions/meta.json'));
    if (missingUser) fs.unlinkSync(path.join(f.zylosDir, 'ZYLOS.md'));
    f.write(missingUser ? 'CLAUDE.md' : 'ZYLOS.md', Buffer.from([0xff, 0, 13, 10]));
    const before = snapshot(f.zylosDir);
    assert.throws(() => f.prepare(), /not valid UTF-8/);
    assert.deepEqual(snapshot(f.zylosDir), before);
  });
}

for (const damage of ['settings', 'marker', 'missing-user', 'residue']) {
  test(`preparation refuses ${damage} without live mutation`, t => {
    const f = fixture(t);
    if (damage === 'settings') f.write('.claude/settings.json', 'broken');
    if (damage === 'marker') f.write('.zylos/instructions/meta.json', '{"schemaVersion":9}');
    if (damage === 'missing-user') fs.unlinkSync(path.join(f.zylosDir, 'ZYLOS.md'));
    if (damage === 'residue') f.write('.zylos/instructions/meta.json.split-txn.bad', 'residue');
    const before = snapshot(f.zylosDir);
    assert.throws(() => f.prepare());
    assert.deepEqual(snapshot(f.zylosDir), before);
  });
}

test('future instruction format preserves every instruction asset', t => {
  const f = fixture(t); f.write('.zylos/instruction-format-version', '99\n');
  f.write('custom-hooks/session-start/90-migration-prompt.md', 'future prompt');
  const before = snapshot(f.zylosDir);
  const result = f.prepare();
  assert.equal(result.replacements.some(r => r.path.startsWith('.zylos/instructions/')), false);
  assert.equal(result.replacements.some(r => r.path.endsWith('90-migration-prompt.md')), false);
  assert.deepEqual(snapshot(f.zylosDir), before);
});
