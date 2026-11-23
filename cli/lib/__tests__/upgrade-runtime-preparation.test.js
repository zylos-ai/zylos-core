import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { prepareUpgradeRuntime, prepareUpgradeRuntimeClis } from '../upgrade-runtime-preparation.js';


const packageRoot = path.resolve(import.meta.dirname, '../../..');


test('runtime preparation refuses failed install', async t => {
  const f = fixture(t);
  await assert.rejects(prepareUpgradeRuntimeClis(f.ctx, { exists: () => false,
    install: { claude: () => false, codex: () => false } }), { code: 'RUNTIME_PREPARATION_INCOMPLETE' });
});

test('multi includes persisted D10 group runtimes in the required CLI set without database writes', async t => {
  const f = fixture(t);
  f.write('.zylos/config.json', JSON.stringify({ runtime: 'claude', session_mode: 'multi' }));
  const ownerRoot = path.join(packageRoot, 'skills/comm-bridge');
  const Database = createRequire(path.join(ownerRoot, 'package.json'))('better-sqlite3');
  f.write('.claude/skills/comm-bridge/package.json', '{}');
  fs.symlinkSync(path.join(ownerRoot, 'node_modules'), path.join(f.zylosDir, '.claude/skills/comm-bridge/node_modules'), 'dir');
  const database = path.join(f.zylosDir, 'comm-bridge/c4.db');
  fs.mkdirSync(path.dirname(database), { recursive: true });
  const db = new Database(database);
  db.exec("CREATE TABLE group_runtime_overrides(session_group TEXT PRIMARY KEY,runtime TEXT); INSERT INTO group_runtime_overrides VALUES('test:group','codex')");
  db.close();
  const before = fs.readFileSync(database);
  await assert.rejects(prepareUpgradeRuntimeClis(f.ctx, {
    exists: name => name === 'claude', install: { codex: () => false },
  }), { code: 'RUNTIME_PREPARATION_INCOMPLETE' });
  assert.deepEqual(fs.readFileSync(database), before);
  assert.equal(fs.existsSync(`${database}-wal`), false);
  assert.equal(fs.existsSync(`${database}-shm`), false);
  const result = await prepareUpgradeRuntimeClis(f.ctx, { exists: () => true });
  assert.deepEqual(result.completed, ['claude.cli', 'codex.cli']);
  assert.deepEqual(result.warnings, []);
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
  const prepare = options => prepareUpgradeRuntime(ctx, { homeDir: root, stopFailureSupported: false, subagentHooksSupported: false, ...options });
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
  for (const name of ['assembler.mjs', 'claude-system.md', 'codex-system.md', 'meta.json']) {
    assert.ok(prepared.replacements.find(r => r.path === `.zylos/instructions/${name}`));
  }
  assert.equal(prepared.replacements.some(r => r.path === '.zylos/instructions/onboarding.md'), false);
  assert.equal(prepared.replacements.some(r => r.path === '.zylos/onboarding-pending'), false);
  const agents = prepared.replacements.filter(item => item.path.startsWith('.claude/agents/'));
  assert.equal(agents.length, 3);
  for (const { path: name } of agents) {
    const bytes = prepared.replacements.find(r => r.path === name).content;
    assert.deepEqual(bytes, fs.readFileSync(path.join(packageRoot, 'skills/zylos-memory/agents', path.basename(name))));
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
