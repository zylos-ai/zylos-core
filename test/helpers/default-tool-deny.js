import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { syncRuntimeHooks } from '../../cli/lib/sync-runtime-hooks.js';

const scenario = process.argv[2];
const root = process.env.ZYLOS_DIR;
const settingsPath = path.join(root, '.claude/settings.json');
const defaults = ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode'];
const sync = (options = {}) => syncRuntimeHooks({ zylosDir: root,
  stopFailureSupported: true, subagentHooksSupported: true, ...options });
const read = () => JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

if (scenario === 'fresh') {
  const { deployTemplates } = await import('../../cli/commands/init.js');
  deployTemplates({ freshInstall: true });
  assert.deepEqual(read().permissions.deny, defaults);
} else {
  sync();
  const settings = read();
  const variants = {
    custom: { deny: ['Bash(rm -rf *)'], allow: ['Read'], ask: ['Write'], defaultMode: 'default' },
    partial: { deny: ['EnterPlanMode', 'Bash(rm -rf *)', 'AskUserQuestion'] },
    'no-deny': { allow: ['Read'] },
    'invalid-deny': { deny: 'AskUserQuestion', allow: ['Read'] },
    'null-deny': { deny: null },
    'invalid-permissions': 'bad',
    'array-permissions': [],
    'null-permissions': null,
  };
  if (Object.hasOwn(variants, scenario)) settings.permissions = variants[scenario];
  else delete settings.permissions;
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  const before = fs.readFileSync(settingsPath, 'utf8');
  const stat = () => {
    const s = fs.statSync(settingsPath, { bigint: true });
    return [s.ino, s.mtimeNs, s.ctimeNs];
  };
  const beforeStat = stat();
  const backups = () => fs.readdirSync(path.dirname(settingsPath)).filter(name => name.startsWith('settings.json.bak.')).sort();
  const beforeBackups = backups();
  const codexPaths = [path.join(root, '.codex/config.toml'), path.join(root, '.codex/hooks.json'),
    path.join(process.env.HOME, '.codex/config.toml')];
  const codexBefore = codexPaths.map(file => fs.readFileSync(file, 'utf8'));
  const logs = [];
  const originalLog = console.log;
  console.log = line => logs.push(line);
  let result;
  try { result = sync({ dryRun: scenario === 'dry-run', log: line => logs.push(line) }); }
  finally { console.log = originalLog; }

  const invalid = scenario.includes('invalid') || scenario.includes('null') || scenario === 'array-permissions';
  if (scenario === 'dry-run' || invalid) {
    assert.equal(fs.readFileSync(settingsPath, 'utf8'), before);
    assert.deepEqual(stat(), beforeStat);
    assert.deepEqual(backups(), beforeBackups);
    assert.equal(result.changed, scenario === 'dry-run');
    assert.ok(logs.some(line => scenario === 'dry-run'
      ? line.includes('permissions.deny to backfill') : line.includes('Warning: permissions')));
    if (invalid) {
      // An invalid permissions value must not prevent unrelated settings work.
      delete settings.autoMemoryEnabled;
      fs.writeFileSync(settingsPath, JSON.stringify(settings));
      sync();
      assert.equal(read().autoMemoryEnabled, false);
      assert.deepEqual(read().permissions, settings.permissions);
    }
  } else {
    const previous = settings.permissions ?? {};
    const deny = previous.deny ?? [];
    const expected = { ...previous, deny: [...deny, ...defaults.filter(tool => !deny.includes(tool))] };
    assert.deepEqual(read(), { ...settings, permissions: expected });
    assert.equal(result.changed, true);
    assert.ok(logs.some(line => line.includes('permissions.deny backfilled')));
    assert.ok(backups().some(name => fs.readFileSync(path.join(path.dirname(settingsPath), name), 'utf8') === before));
    const after = fs.readFileSync(settingsPath, 'utf8');
    const afterStat = stat();
    const afterBackups = backups();
    assert.equal(sync().changed, false);
    assert.equal(fs.readFileSync(settingsPath, 'utf8'), after);
    assert.deepEqual(stat(), afterStat);
    assert.deepEqual(backups(), afterBackups);
  }
  assert.deepEqual(codexPaths.map(file => fs.readFileSync(file, 'utf8')), codexBefore);
}
assert.equal(fs.existsSync(path.join(root, 'comm-bridge/c4.db')), false);
