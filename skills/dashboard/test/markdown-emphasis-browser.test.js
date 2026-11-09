import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { Store } from '../src/lib/store.js';
import { ChatConversations } from '../src/lib/chat/conversations.js';
import { hashPassword } from '../src/lib/auth.js';
import { migrateSchema } from '../../comm-bridge/scripts/c4-migrations.js';
import { migrateToV2 } from '../../comm-bridge/scripts/c4-migrations-v2.js';
import { createChatSandbox, chatEnabled } from './helpers/chat-integration-harness.js';
import { startChatBrowser, until } from './helpers/chat-push-browser-driver.js';

const enabled = chatEnabled() && !!process.env.ZYLOS_CHAT_BROWSER_BIN;
const helper = fileURLToPath(new URL('./helpers/markdown-emphasis-server.js', import.meta.url));
const namespace = 'dashboard-markdown-emphasis';
const group = namespace + ':private';
const conversation = 'g:' + Buffer.from(group).toString('hex').toUpperCase();
const row = `[data-conversation-id="${conversation}"]`;
const body = '[data-message-id="2"] .chat-message-content';
const href = 'https://example.invalid/**path**';
const title = 'title **literal**';
const chineseLead = '**（粗体）**后文，*“斜体”*后文；前文**【重点】**后文，前文*「强调」*后文。';
const chinesePreview = '（粗体）后文，“斜体”后文；前文【重点】后文，前文「强调」后文。';
const englishLead = '**Bold text** and *italic text* keep ordinary formatting.';
const englishPreview = 'Bold text and italic text keep ordinary formatting.';
const source = locale => [locale === 'zh' ? chineseLead : englishLead,
  locale === 'zh' ? `[**《链接》**后文](${href} "${title}")` : `[**Linked bold**](${href} "${title}")`,
  '`**（行内代码）**后文`', '```text\n**（代码块）**后文\n```'].join('\n\n');

async function screenshot(page, locale, width, view) {
  const evidence = process.env.ZYLOS_CHAT_EVIDENCE_DIR;
  if (!evidence) return;
  fs.mkdirSync(evidence, { recursive: true });
  await page.screenshot(path.join(evidence, `markdown-${locale}-${width}-${view}.png`));
}

async function fixture(t, locale, width) {
  const sandbox = createChatSandbox(t);
  console.info('markdown-emphasis browser targets', JSON.stringify(sandbox.assertIsolation()));
  const db = sandbox.openDatabase(sandbox.paths.c4Db, filename => new Database(filename));
  migrateSchema(db, { isNew: true }); migrateToV2(db);
  db.prepare('INSERT INTO channel_namespaces VALUES (?,?)').run(namespace, 'dashboard');
  const insert = db.prepare(`INSERT INTO conversations (id,timestamp,direction,channel,endpoint_id,session_group,content,status)
    VALUES (?, ?, ?, 'dashboard','private', ?, ?, 'delivered')`);
  const start = Date.now() - 120000;
  insert.run(1, new Date(start).toISOString(), 'in', group, locale === 'zh' ? '展示中文标点附近的 Markdown。' : 'Show ordinary Markdown formatting.');
  insert.run(2, new Date(start + 10000).toISOString(), 'out', group, source(locale));
  const store = sandbox.openDatabase(sandbox.paths.dashboardDb, filename => new Store(filename));
  const conversations = new ChatConversations({ store, idGenerator: () => 'private' });
  conversations.create({ displayName: locale === 'zh' ? '中文 Markdown 展示' : 'English Markdown sample' });
  conversations.bind('private', namespace); conversations.markCommitted('private', { id: 1 });
  fs.writeFileSync(path.join(sandbox.paths.zylos, 'components/dashboard/config.json'), JSON.stringify({ auth: { enabled: true, password: hashPassword('private-markdown-password') } }));
  fs.mkdirSync(path.join(sandbox.paths.zylos, '.zylos'));
  fs.writeFileSync(path.join(sandbox.paths.zylos, '.zylos/config.json'), JSON.stringify({ session_mode: 'multi', runtime: 'codex' }));
  fs.writeFileSync(path.join(sandbox.paths.zylos, '.env'), 'TZ=Asia/Shanghai\n');
  const bin = path.join(sandbox.root, 'bin'); fs.mkdirSync(bin);
  for (const command of ['zylos', 'claude', 'codex']) fs.writeFileSync(path.join(bin, command), '#!/bin/sh\ncase "$1" in\n--version) printf "1.0.0\\n";;\nsession-mode) printf \'{"ok":true,"data":{"sessionMode":"multi"}}\\n\';;\nstatus) printf \'{"runtime":"codex","status":"stopped"}\\n\';;\n*) exit 1;;\nesac\n', { mode: 0o700 });
  for (const command of ['tmux', 'pm2']) fs.writeFileSync(path.join(bin, command), '#!/bin/sh\nprintf "forbidden runtime access\\n" >&2\nexit 1\n', { mode: 0o700 });
  const child = sandbox.startChild(process.execPath, [helper], { timeoutMs: 40000, maxOutputBytes: 65536,
    env: { PATH: bin + ':/usr/bin:/bin', ZYLOS_CHAT_CASE_ROOT: sandbox.root, TMUX: sandbox.paths.socket + ',0,0' } });
  let output = '', origin, protocolError;
  child.stdout.on('data', data => {
    output += data.toString();
    if (output.length >= 65536) { protocolError = 'child protocol bound exceeded'; child.kill('SIGKILL'); return; }
    let newline;
    while ((newline = output.indexOf('\n')) >= 0) {
      const line = output.slice(0, newline); output = output.slice(newline + 1);
      if (line.startsWith('markdown-emphasis child isolation ')) console.info(line);
      try { if (line.startsWith('markdown-emphasis-server-ready ')) origin = JSON.parse(line.slice('markdown-emphasis-server-ready '.length)).origin; }
      catch { protocolError = 'invalid child protocol'; child.kill('SIGKILL'); return; }
    }
  });
  await until(() => protocolError || origin || child.exitCode !== null, 'real Dashboard HTTP server starts', 10000);
  assert.equal(protocolError, undefined);
  assert.ok(origin, 'real server announced its loopback origin');
  const browser = await startChatBrowser(t, sandbox, origin, { expectedBlockedHosts: ['fonts.googleapis.com'] });
  const page = await browser.page({ width, pathname: '/login', ready: '!!document.querySelector("input[name=password]")' });
  await page.evaluate(`localStorage.setItem('zylos-dashboard-locale',${JSON.stringify(locale)});document.querySelector('input[name=password]').value='private-markdown-password';document.querySelector('form').submit()`);
  await until(() => page.evaluate('document.querySelector("#wb-chat")?.children.length>0'), 'full app mounts', 10000);
  await page.evaluate('document.querySelector(".tab[data-tab=chat]").click()');
  await until(() => page.evaluate(`!!document.querySelector(${JSON.stringify(row + ' .chat-preview')})`), 'real history lists the seeded conversation', 5000);
  // Selection may happen automatically. Return through the actual mobile back
  // control before inspecting the visible preview, then select the listed row.
  if (width === 390) await page.evaluate('document.querySelector(".conversation-back").click()');
  const preview = await page.evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(row + ' .chat-preview')}),box=el.getBoundingClientRect();return {text:el.textContent,visible:box.width>0&&box.height>0};})()`);
  assert.equal(preview.visible, true, 'sidebar preview is visible before selecting the conversation');
  assert.ok(preview.text.startsWith(locale === 'zh' ? chinesePreview : englishPreview), preview.text);
  assert.equal(preview.text.includes(locale === 'zh' ? '**（粗体）**' : '**Bold text**'), false);
  await screenshot(page, locale, width, 'preview');
  await page.evaluate(`document.querySelector(${JSON.stringify(row)}).click()`);
  await until(() => page.evaluate(`!!document.querySelector(${JSON.stringify(body + ' pre code')})`), 'real reply body renders', 5000);
  return { sandbox, browser, page, preview };
}

// Real createServer/login/history/body + server-generated previews. Run these
// cases after the vendored Markdown library, entry wiring or asset graph changes;
// unrelated runtime/backend changes may skip. The official runner and each case
// prove fresh HOME/ZYLOS_DIR/PM2_HOME, short TMPDIR, private tmux socket, both
// databases and Chrome profile before use. Runtime CLIs are refused/fixture-only,
// outside browser requests are blocked, and no model or collector is started.
// Sandbox lifecycle/abort reclaims service/Chrome groups, timers, DBs and roots
// on success, failure and timeout. Output and observations are bounded.
for (const [locale, width] of [['zh', 1280], ['zh', 390], ['en', 1280], ['en', 390]]) {
  test(`Markdown body and conversation preview agree in ${locale} at ${width}`, { skip: !enabled, timeout: 35000 }, async t => {
    const f = await fixture(t, locale, width);
    const result = await f.page.evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(body)}),link=el.querySelector('a'),box=el.getBoundingClientRect();return {strong:[...el.querySelectorAll('strong')].map(n=>n.textContent),em:[...el.querySelectorAll('em')].map(n=>n.textContent),inline:el.querySelector('p code')?.textContent,fenced:el.querySelector('pre code')?.textContent,href:link?.getAttribute('href'),title:link?.getAttribute('title'),target:link?.getAttribute('target'),rel:link?.getAttribute('rel'),visible:box.width>0&&box.height>0};})()`);
    assert.equal(result.visible, true);
    assert.deepEqual(result.strong, locale === 'zh' ? ['（粗体）', '【重点】', '《链接》'] : ['Bold text', 'Linked bold']);
    assert.deepEqual(result.em, locale === 'zh' ? ['“斜体”', '「强调」'] : ['italic text']);
    assert.equal(result.inline, '**（行内代码）**后文');
    assert.equal(result.fenced, '**（代码块）**后文\n');
    assert.equal(result.href, href); assert.equal(result.title, title);
    assert.equal(result.target, '_blank'); assert.equal(result.rel, 'noopener noreferrer');
    assert.equal(await f.page.evaluate('!!document.querySelector(".chat-error:not([hidden])")'), false);
    assert.equal(f.browser.errors.length, 0, JSON.stringify(f.browser.errors));
    assert.equal(f.browser.external.length, 0, JSON.stringify(f.browser.external));
    await screenshot(f.page, locale, width, 'body');
    console.info('markdown-emphasis browser result', JSON.stringify({ locale, width, preview: f.preview, ...result }));
    await f.browser.close(); await f.sandbox.close();
  });
}
