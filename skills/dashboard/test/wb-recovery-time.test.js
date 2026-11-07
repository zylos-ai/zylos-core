import test from 'node:test';
import assert from 'node:assert/strict';
import { recoveryTime } from '../public/js/wb/cooldown.js';
import { instanceStrip } from '../public/js/wb/instance-strip.js';
import { renderAttention } from '../public/js/wb/attention-bar.js';
import { waitText } from '../public/js/wb/view-mode.js';
import { createDocument, allNodes } from './fixtures/workbench-dom.js';

// Direct product imports with injected DOM and clock. Run for recovery-time,
// instance strip, attention bar or waiting text changes; skip collectors and
// server code. No database, process, timer, tmux or network I/O.
const t = (key, values = {}) => key + Object.values(values).join(':');
const now = 1_800_000_000_000;
const future = now / 1000 + 600;
const cases = [['zero', 0], ['null', null], ['past', now / 1000 - 600], ['future', future]];

test('recovery time is known only for a future epoch second', () => {
  for (const [name, value] of cases) assert.equal(recoveryTime(value, now), name === 'future' ? future * 1000 : null, name);
  for (const value of [-5, NaN, Infinity, '1800000600', undefined]) assert.equal(recoveryTime(value, now), null, String(value));
});

test('instance strip shows an unknown recovery time unless cooldown is in the future', () => {
  const document = createDocument(), root = document.createElement('div');
  for (const [name, cooldownUntil] of cases) {
    instanceStrip(root, { mode: 'multi', baselineRuntime: 'claude', rows: [],
      instance: { runtimeHealth: { claude: { health: 'rate_limited', cooldownUntil } } } }, { document, t, now });
    if (name === 'future') {
      assert.match(root.textContent, new RegExp('wb\\.recovery' + new Date(future * 1000).toLocaleTimeString().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.doesNotMatch(root.textContent, /wb\.recoveryUnknown/);
    } else {
      assert.match(root.textContent, /wb\.recoveryUnknown/, name);
      assert.doesNotMatch(root.textContent, /1970/, name);
    }
  }
});

test('attention reminder shows an unknown recovery time unless cooldown is in the future', () => {
  const document = createDocument(), root = document.createElement('div');
  for (const [name, until] of cases) {
    renderAttention(root, { attention: { problems: [], reminders: [{ kind: 'rate_limited', runtime: 'codex', until }] } }, { document, t, now });
    const text = root.textContent;
    if (name === 'future') {
      assert.match(text, /^wb\.attention\.rate_limitedcodex:/);
      assert.ok(text.endsWith(new Date(future * 1000).toLocaleTimeString()));
    } else assert.match(text, /^wb\.attention\.rate_limited_unknowncodex/, name);
    assert.equal(allNodes(root).filter(node => node.className.split(' ').includes('wb-attention-reminder')).length, 1);
  }
});

test('waiting text shows an unknown recovery time unless cooldown is in the future', () => {
  for (const [name, cooldownUntil] of cases) {
    const wait = { kind: 'rate_wait', cooldownUntil, pendingCount: 2 };
    const translated = waitText(wait, 'plain', t, now), fallback = waitText(wait, 'plain', undefined, now);
    if (name === 'future') {
      const time = new Date(future * 1000).toLocaleTimeString();
      assert.equal(translated, 'wb.wait.rate_wait' + time + ':2');
      assert.match(fallback, new RegExp(time.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' 恢复'));
    } else {
      assert.equal(translated, 'wb.wait.rate_wait_unknown:2', name);
      assert.match(fallback, /恢复时间未知/, name);
    }
    assert.equal(waitText(wait, 'technical', t, now).includes(':'), name === 'future', name);
  }
  for (const kind of ['queued', 'auth_wait', 'starting']) {
    assert.equal(waitText({ kind, cooldownUntil: 0, pendingCount: 2 }, 'plain', t, now), `wb.wait.${kind}:2`, kind);
  }
  assert.equal(waitText({ kind: 'queued' }, 'plain', undefined, now), '正在排队，空出位置后自动处理，不需要操作。');
});
