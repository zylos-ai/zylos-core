import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { getActionsMeta } from '../src/lib/actions.js';

test('model changes use the root TOML assignment and preserve table values and comments', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-codex-root-model-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, '.codex'));
  const file = path.join(dir, '.codex', 'config.toml');
  const config = { runtime: 'codex', zylosDir: dir };
  const singleQuoted = 'model = \'gpt-5.6\'\nmodel_reasoning_effort = "high"\n';
  const profile = '[profiles.x]\nmodel = "gpt-6-sol"\n';

  for (const [name, source, expected, previous, model] of [
    ['single-quoted model', singleQuoted, 'model = "gpt-5.5"\nmodel_reasoning_effort = "high"\n', 'gpt-5.6', 'gpt-5.5'],
    ['inline comment', 'model = "gpt-5.6" # pinned\n', 'model = "gpt-5.5" # pinned\n', 'gpt-5.6', 'gpt-5.5'],
    ['profile-only model', profile, 'model = "gpt-5.5"\n' + profile, null, 'gpt-5.5'],
    ['already set', singleQuoted, singleQuoted, 'gpt-5.6', 'gpt-5.6'],
  ]) {
    await t.test(name, async () => {
      const { handleAction: dispatch } = await import(`../src/lib/actions.js?root-model=${encodeURIComponent(name)}`);
      fs.writeFileSync(file, source);
      const result = await dispatch('switch-model', { runtime: 'codex', model }, config);
      if (previous === model) {
        assert.equal(result.error, 'already_set');
      } else {
        assert.equal(result.ok, true);
        assert.equal(result.previous, previous);
      }
      assert.equal(fs.readFileSync(file, 'utf8'), expected);
      assert.equal(getActionsMeta(config).current_model, model);
    });
  }
});
