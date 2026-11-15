import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runComponentAppearanceBrowser } from './chat-component-appearance-browser.js';

export async function runQuestionHeightBrowser(sandbox, options) {
  await runComponentAppearanceBrowser(sandbox, { ...options,
    fixturePath: fileURLToPath(new URL('./chat-question-height-fixture.js', import.meta.url)),
    check: checkQuestion,
  });
  sandbox.assertIsolation();
  assert.equal(fs.existsSync(sandbox.paths.c4Db), false, 'browser fixture never opens C4 DB');
  assert.equal(fs.existsSync(sandbox.paths.dashboardDb), false, 'browser fixture never opens Dashboard DB');
  assert.equal(fs.existsSync(sandbox.paths.socket), false, 'browser fixture never creates a tmux socket');
  console.info('question browser resource readback', JSON.stringify({ databasesAbsent: true, socketAbsent: true }));
}

async function checkQuestion(page, { width, theme }) {
  const root = page.locator('#height-question');
  const input = root.getByLabel('名称', { exact: true });
  const select = root.getByLabel('类型', { exact: true });
  const segments = root.locator('.chat-form-segments');
  const submit = root.locator('[data-action="answer"]');
  const geometry = await root.evaluate(root => {
    const measure = node => {
      const rect = node.getBoundingClientRect();
      return { height: rect.height, width: rect.width, top: rect.top, center: rect.top + rect.height / 2 };
    };
    return {
      single: [...root.querySelectorAll('.chat-question-field input:not([type="checkbox"]), .chat-question-field select:not([hidden]),  .chat-form-segments, [data-action="answer"], [data-action="answerOther"]')].map(measure),
      textareas: [...root.querySelectorAll('textarea')].map(measure),
      segments: [...root.querySelectorAll('.chat-form-segment')].map(measure),
      chips: [...root.querySelectorAll('.chat-form-chip')].map(measure),
      scrollWidth: document.documentElement.scrollWidth,
    };
  });
  assert.equal(geometry.single.length, 7, 'text, number, date, select, segment outer track and both submit buttons are rendered');
  for (const item of geometry.single) assert.equal(item.height, 36, 'large single-line question frame is 36px: ' + JSON.stringify(item));
  assert.equal(geometry.textareas.length, 2, 'form multiline field and other-answer textarea are present');
  for (const item of geometry.textareas) assert.ok(item.height >= 88, 'multiline answer keeps its natural minimum');
  assert.ok(geometry.segments.every(item => item.height === 28), 'segment content stays inset inside its 36px track');
  assert.ok(geometry.segments.every(item => Math.abs(item.center - geometry.single[4].center) <= 1), 'segments remain centered inside their outer track');
  assert.ok(geometry.chips.every(item => item.height === (width === 390 ? 36 : 32)), 'chip touch frames are preserved');
  assert.ok(geometry.scrollWidth <= width, 'question form does not overflow horizontally');
  const output = process.env.ZYLOS_CHAT_EVIDENCE_DIR;
  if (output) {
    fs.mkdirSync(output, { recursive: true });
    await page.mouse.move(0, 0);
    await root.screenshot({ path: path.join(output, `question-height-${width}-${theme}.png`), animations: 'disabled', scale: 'css' });
    fs.writeFileSync(path.join(output, `question-height-${width}-${theme}.json`), JSON.stringify(geometry, null, 2));
  }
  await input.focus();
  await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
  assert.equal(await input.evaluate(node => node.matches(':focus-visible')), true, 'keyboard focus reaches the input');
  assert.notEqual(await input.evaluate(node => getComputedStyle(node).boxShadow), 'none', 'input keyboard focus is visible');
  await input.fill('布局验证');
  await select.selectOption('second');
  await segments.getByRole('button', { name: '方式: 第二项', exact: true }).click();
  assert.equal(await segments.locator('[aria-pressed="true"]').textContent(), '第二项', 'segmented selection follows the click');
  await root.locator('.chat-form-chip').filter({ hasText: '第二项' }).click();
  assert.equal(await root.locator('.chat-form-chip input:checked').count(), 1, 'chip click updates its checkbox');
  await root.getByLabel('说明', { exact: true }).fill('多行说明\n保留自然高度');
  await submit.focus();
  await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
  assert.equal(await submit.evaluate(node => node.matches(':focus-visible')), true, 'keyboard focus reaches submit');
  assert.notEqual(await submit.evaluate(node => getComputedStyle(node).boxShadow), 'none', 'submit keyboard focus is visible');
  await submit.hover();
  assert.equal((await submit.boundingBox()).height, 36, 'hover preserves submit geometry');
  await submit.click();
  await page.waitForFunction(() => window.questionSubmissions.length === 1);
  assert.equal(await submit.isDisabled(), true, 'pending submission disables its submit button');
  assert.equal(await input.isDisabled(), true, 'pending submission disables form controls');
  assert.equal((await submit.boundingBox()).height, 36, 'disabled submission preserves geometry');
  const action = await page.evaluate(() => window.questionSubmissions[0]);
  assert.deepEqual(action.payload.values, { mode: 'second', name: '布局验证', kind: 'second', tags: ['second'], notes: '多行说明\n保留自然高度' });
  assert.deepEqual(action.context, { messageId: 'height-message', blockId: 'details' });
  await page.evaluate(() => window.completeQuestionSubmission());
  await page.waitForFunction(() => !document.querySelector('#height-question [data-action="answer"]').disabled);
  console.info('question height passed', JSON.stringify({ width, theme, ...geometry }));
}
