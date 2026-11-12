import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('both Core upgrade flows carry out Agent warnings after completion and report results', () => {
  const document = fs.readFileSync(new URL('../../../skills/component-management/references/upgrade.md', import.meta.url), 'utf8');
  const sections = [
    document.split('### Step 5: Review Conflicts + Completion\n')[1]?.split('\n## ')[0],
    document.split('## C4 Mode — Self-Upgrade (zylos-core)')[1]?.split('### Step 2 — User confirms\n')[1],
  ];
  for (const section of sections) {
    assert.ok(section, 'Core upgrade completion section exists');
    assert.match(section, /If `dashboard\.state` is `degraded`[^\n]+\n\d+\. Read `warnings` in the result JSON\. After the upgrade completes, carry out every entry starting with `Agent action required:`, then report what you did and the result\./);
  }
});
