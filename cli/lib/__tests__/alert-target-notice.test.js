import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { alertTargetNotice } from '../alert-target-notice.js';
import { showStatus } from '../../commands/service.js';

test('alert target notices distinguish missing, explicit console, invalid, missing sender and ready', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alert-notice-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'telegram', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'telegram', 'scripts', 'send.js'), '');
  for (const [config, kind, text] of [
    [{}, 'warning', /未设置：系统告警只发到 Web Console/],
    [{ alert_target: 'web-console:console' }, 'plain', /主人选了只发 Web Console/],
    [{ alert_target: 'invalid' }, 'warning', /值不合法/],
    [{ alert_target: 'lark:oc_x' }, 'warning', /渠道 lark 的 scripts\/send.js 不存在/],
    [{ alert_target: 'telegram:8101553026|msg:9216' }, 'ready', /^telegram:8101553026\|msg:9216$/],
  ]) {
    const notice = alertTargetNotice({ read: () => ({ state: 'ok', config }), skillsDir: root });
    assert.equal(notice.kind, kind); assert.match(notice.text, text);
  }
  assert.match(alertTargetNotice({ read: () => ({ state: 'missing' }) }).text, /未设置/);
  assert.match(alertTargetNotice({ read: () => ({ state: 'error' }) }).text, /配置无法读取/);
});

test('status text adds only actionable or console notices and JSON preserves the original projection', async () => {
  const data = { sessionMode: 'multi', origin: { sessionGroup: 'origin', presence: 'not_running', runtime: null, status: { valid: false } }, groups: [], runtimeHealth: {} };
  const lines = [], original = console.log;
  console.log = line => lines.push(line);
  try {
    for (const config of [{}, { alert_target: 'web-console:console' }, { alert_target: 'invalid' }, { alert_target: 'absent:room' }, { alert_target: 'telegram:room' }]) {
      const notice = alertTargetNotice({ read: () => ({ state: 'ok', config }), exists: file => file.includes('/telegram/') });
      lines.length = 0;
      const result = await showStatus([], { collect: () => data, host: () => ({ services: [], disk: null }), alertNotice: () => notice });
      assert.deepEqual(result, { ok: true, data });
      assert.equal(lines.filter(line => line.startsWith('Alert target:')).length, notice.kind === 'ready' ? 0 : 1);
      if (notice.kind !== 'ready') assert.ok(lines.includes(`Alert target: ${notice.text}`));
      lines.length = 0;
      const json = await showStatus(['--json'], { collect: () => data, host: () => assert.fail('JSON must not collect host data'), alertNotice: () => assert.fail('JSON must not read alert target') });
      assert.equal(lines.length, 1);
      assert.deepEqual(JSON.parse(lines[0]), { ok: true, data });
      assert.deepEqual(json, result);
    }
  } finally { console.log = original; }
});
