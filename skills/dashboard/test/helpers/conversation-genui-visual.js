import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createChatApiFixture, questionContent } from './chat-integration-api.js';
import { sendJson, sendHtml } from '../../src/lib/http.js';
import { makeQuestionSummary, parseC4Content } from '../../../comm-bridge/scripts/c4-content-schema.js';

const markdown = (id, text) => ({ id, type: 'markdown', schemaVersion: 1, data: { text } });
function formMessage(scene) {
  const block = { id: 'customer_form', type: 'form_intent', schemaVersion: 2, fallbackText: '请填写姓名、邮箱与适用的公司信息。', data: {
    title: '这次方案按个人还是企业需求来准备？', action: { type: 'form.submit', target: 'customer.register' },
    fields: [
      { key: 'customer_type', label: '需求类型', type: 'single_select', required: true, defaultValue: scene === 'conditional' ? 'person' : 'company', options: [{ id: 'person', label: '个人' }, { id: 'company', label: '企业' }] },
      { key: 'full_name', label: '姓名', type: 'text', required: true, maxLength: 40 },
      { key: 'email', label: '邮箱', type: 'text', required: true, maxLength: 100 },
      { key: 'company_name', label: '公司名称', type: 'text', required: true, maxLength: 40, activeWhen: { field: 'customer_type', eq: 'company' } },
    ],
  } };
  const envelope = { version: 1, kind: 'message', messageId: `${scene}_message`, fallbackText: block.fallbackText, blocks: [block],
    interruptId: `${scene}_interrupt`, interrupt: { blockId: block.id, reason: 'input_required' } };
  envelope.questionSummary = makeQuestionSummary(envelope);
  return envelope;
}
function columnsMessage(fallback = false) {
  const plans = [
    ['a', 'A · 单机轻量', '¥180 / 月', '一台实例，最少维护。', '预计 2 天交付', '适合内部试点', '单点故障需手动恢复'],
    ['b', 'B · 双实例', '¥460 / 月', '主备切换，成本和可用性平衡。', '预计 4 天交付', '适合日常生产', '切换目标 5 分钟内'],
    ['c', 'C · 弹性集群', '¥1,200 / 月起', '自动扩缩，面向高峰流量。', '预计 8 天交付', '适合多团队规模', '需要持续运维预算'],
  ];
  const blocks = [markdown('intro', '**三种方案，按同一组标准比较。** 每个方案保留完整说明。')];
  const nodes = [{ id: 'root', type: 'stack', children: ['intro_node', 'columns', 'question_node'] },
    { id: 'intro_node', type: 'block', blockId: 'intro' }, { id: 'columns', type: 'columns', layout: 'balanced', children: plans.map(plan => 'section_' + plan[0]) }];
  for (const [key, title, ...body] of plans) {
    blocks.push(markdown('title_' + key, '**' + title + '**'), markdown('body_' + key, body.join('\n\n')));
    nodes.push({ id: 'section_' + key, type: 'section', header: ['title_node_' + key], body: ['body_node_' + key] },
      { id: 'title_node_' + key, type: 'block', blockId: 'title_' + key }, { id: 'body_node_' + key, type: 'block', blockId: 'body_' + key });
  }
  blocks.push({ id: 'question', type: 'choice', schemaVersion: 1, fallbackText: '请选择方案 A、B 或 C。', data: { prompt: '先深入哪一种方案？',
    options: plans.map(([id, label]) => ({ id, label })), action: { type: 'choice.select', target: 'plan.select' } } });
  nodes.push({ id: 'question_node', type: 'block', blockId: 'question' });
  const envelope = { version: 1, kind: 'message', messageId: fallback ? 'fallback_message' : 'columns_message', fallbackText: '三种完整部署方案；请选择要深入的方案。', blocks,
    interruptId: fallback ? 'fallback_interrupt' : 'columns_interrupt', interrupt: { blockId: 'question', reason: 'input_required' } };
  if (!fallback) envelope.metadata = { view: { schemaVersion: 1, root: 'root', nodes } };
  envelope.questionSummary = makeQuestionSummary(envelope);
  return envelope;
}
function chartMessage() {
  return { version: 1, kind: 'message', messageId: 'cache_chart_message', fallbackText: '两种方案的吞吐量和命中率比较。', blocks: [
    { id: 'throughput', type: 'time_series', schemaVersion: 1, fallbackText: 'A:4200/3900/2100；B:6100/5400/3600。', data: { title: '每秒处理请求数（压测回放）', xType: 'category', xLabel: '延迟分位', yLabel: '请求数 / 秒', series: [
      { key: 'a', label: '方案 A', points: ['p50', 'p90', 'p99'].map((x, i) => ({ x, y: [4200, 3900, 2100][i] })) },
      { key: 'b', label: '方案 B', points: ['p50', 'p90', 'p99'].map((x, i) => ({ x, y: [6100, 5400, 3600][i] })) },
    ] } },
    { id: 'hit_rate', type: 'time_series', schemaVersion: 1, fallbackText: 'A:61→87%；B:48→90%。', data: { title: '命中率随时间', xType: 'number', xLabel: '时间（分钟）', yLabel: '命中率', yUnit: '%', series: [
      { key: 'a', label: '方案 A', points: [0, 5, 10, 15, 20, 25, 30].map((x, i) => ({ x, y: [61, 72, 80, 84, 86, 87, 87][i] })) },
      { key: 'b', label: '方案 B', points: [0, 5, 10, 15, 20, 25, 30].map((x, i) => ({ x, y: [48, 66, 79, 85, 88, 89, 90][i] })) },
    ] } },
  ] };
}

export async function runConversationGenuiVisual(t, sandbox) {
  const modulePath = process.env.ZYLOS_CHAT_BROWSER_MODULE, executablePath = process.env.ZYLOS_CHAT_BROWSER_BIN;
  assert.ok(modulePath && fs.existsSync(modulePath)); assert.ok(executablePath && fs.existsSync(executablePath));
  const output = process.env.ZYLOS_CHAT_EVIDENCE_DIR;
  if (output) fs.mkdirSync(output, { recursive: true });
  const prototypeFile = process.env.ZYLOS_CHAT_PROTOTYPE_FILE;
  const prototypeSource = prototypeFile ? fs.readFileSync(prototypeFile,'utf8') : null;
  if(prototypeSource) { const bytes=Buffer.from(prototypeSource); assert.equal(crypto.createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`),bytes])).digest('hex'),'77d676e8735904aa4c223e8d1d98551a9e7d3f37','prototype is the exact approved source blob'); }
  const isolation = sandbox.assertIsolation();
  const fixture = await createChatApiFixture(t, sandbox, { name: 'GenUI design review', extraHandler(req, res, url, f) {
    if(url.pathname === '/approved-prototype.html' && prototypeSource){sendHtml(res,200,prototypeSource);return true;}
    if (url.pathname === '/renderer-fallback') {
      sendHtml(res, 200, `<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:15px/1.6 system-ui;margin:24px;background:#f4f7f8;color:#17222e}body.dark{background:#11191e;color:#e6edf2}main{max-width:900px;margin:auto}.chat-message-content{padding:20px;border:1px solid #86939d;border-radius:12px;margin:16px 0}.chat-block{margin:16px 0}h1{font-size:22px}</style><main><h1>兼容展示：完整 Content 顺序与无渲染器表单</h1><div id="fallback"></div></main><script type="module">
      import {renderChatContent} from '/_assets/js/wb/chat-blocks.js?v=102';
      const root=document.querySelector('#fallback');
      const columns=${JSON.stringify(columnsMessage())};
      const form=${JSON.stringify(formMessage('no-renderer'))};
      for(const [index,envelope] of [columns,form].entries()) root.append(renderChatContent({document,row:{id:index+1,content:'[C4-JSON]\\n'+JSON.stringify(envelope)},supportsBlock:block=>block.type!=='form_intent',showTechnicalDetails:false}));
      document.body.className=new URL(location).searchParams.get('theme')||'';
      root.dataset.ready='true';
      </script></html>`); return true;
    }
    if (url.pathname.startsWith('/api/chat/') || !url.pathname.startsWith('/api/')) return false;
    if (url.pathname === '/api/stream') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(); return true; }
    const values = { '/api/session-mode': { data: { sessionMode: f.readMode() } },
      '/api/state': { state: 'idle', runtime: 'claude', session_mode: f.readMode(), agent: { id: 'test', name: '隔离浏览器' }, runtime_info: {} },
      '/api/fleet': { agents: [] }, '/api/health': { status: 'ok' }, '/api/communication': {}, '/api/summary': {},
      '/api/timeline': { items: [] }, '/api/instance-status': { status: 'ok' }, '/api/actions/meta': { actions: [] } };
    sendJson(res, 200, values[url.pathname] || {}); return true;
  } });
  const scenes = {};
  for (const name of ['columns', 'conditional', 'form-error', 'drafts', 'fallback', 'charts']) {
    const conversation = await fixture.createConversation('请比较方案并保留填写中的信息。');
    const titles = { columns:'三种部署方案', conditional:'按需求准备方案', 'form-error':'条件表单 · 检查与重试', drafts:'继续填写方案信息', fallback:'兼容展示预览', charts:'缓存方案比较' };
    assert.equal((await fixture.request(conversation.route,{method:'PATCH',body:{displayName:titles[name]}})).status,200);
    const envelope = name === 'columns' || name === 'fallback' ? columnsMessage(name === 'fallback') : name === 'charts' ? chartMessage() : formMessage(name);
    assert.equal(parseC4Content(questionContent(envelope)).kind, 'envelope', name + ' fixture uses actual schema');
    const row = fixture.addOutbound(conversation.draft.localId, questionContent(envelope));
    scenes[name] = { ...conversation, row, envelope };
  }
  // Historical invalid data must show the existing placeholder beside readable Content.
  const invalid = fixture.addOutbound(scenes.fallback.draft.localId, 'Historical invalid record');
  fixture.db.prepare('UPDATE conversations SET content=? WHERE id=?').run('[C4-JSON]\n{invalid', invalid.id);
  sandbox.assertIsolation();
  const { chromium } = await import(pathToFileURL(modulePath));
  const browser = await chromium.launch({ executablePath, headless: true, env: sandbox.env,
    args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--no-first-run'] });
  sandbox.addCleanup(() => browser.close());
  const context = await browser.newContext({ locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
  await context.route('**/*', route => route.request().url().startsWith(fixture.base + '/') ? route.continue() : route.abort());
  await context.addCookies([{ name: '__Secure-zylos_dashboard_session', value: fixture.cookie, domain: '127.0.0.1', path: '/', secure: true }]);
  const page = await context.newPage(); page.setDefaultTimeout(10_000);
  const errors = [], shots = [], prototypeShots = [], measurements = []; let reads = 0, simulatedAnswerError = false;
  page.on('pageerror', error => { if (!errors.length) errors.push(error.message); });
  page.on('console', message => { if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:') && !errors.length) errors.push(message.text()); });
  page.on('response', response => {
    const url = new URL(response.url());
    if (url.pathname.endsWith('/messages')) reads++;
    if (response.status() >= 400 && url.pathname !== '/favicon.ico' && !(simulatedAnswerError && url.pathname.endsWith('/answers') && response.status() === 400) && !errors.length) errors.push(`${response.status()} ${url.pathname}`);
  });
  const choose = async name => {
    const scene = scenes[name];
    const item=page.locator(`[data-conversation-id="${scene.receipt.conversationId}"]`);
    if(!await item.isVisible()) await page.locator('#wb-chat .conversation-back').click();
    await item.click();
    await page.locator(`[data-message-id="${scene.row.id}"]`).waitFor();
    await page.locator(`[data-message-id="${scene.row.id}"]`).scrollIntoViewIfNeeded();
    return page.locator(`[data-message-id="${scene.row.id}"]`);
  };
  const capture = async name => {
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), name + ' document width fits');
    assert.ok(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1), name + ' document height fits');
    if (output) { const filename = path.join(output, name + '.png'); await page.screenshot({ path: filename }); shots.push(filename); }
  };
  const field = (root, key) => root.locator(`[data-field-key="${key}"]`).locator('input,select,textarea');
  const formValues = async root => {
    await field(root, 'customer_type').selectOption('company');
    await field(root, 'full_name').fill('林晓'); await field(root, 'email').fill('lin@example.com');
    await field(root, 'company_name').fill('示例科技');
  };
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  for (const width of [1440, 390]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.addInitScript(value => { if(window===window.top) localStorage.setItem('zylos-dashboard-theme', value); }, theme);
    await page.goto(fixture.base + '/chat');
    await page.locator('#wb-chat [data-conversation-id]').first().waitFor();
    let root = await choose('columns');
    const blocks = await root.locator('[data-block-id]').evaluateAll(nodes => nodes.map(node => node.dataset.blockId));
    assert.equal(blocks.length, new Set(blocks).size, 'each complete block has one mounted node');
    const sections = root.locator('.conversation-view-section');
    assert.equal(await sections.count(), 3);
    const boxes = await sections.evaluateAll(nodes => nodes.map(node => { const r = node.getBoundingClientRect(); return { top: r.top, left: r.left, right: r.right }; }));
    if(output) fs.writeFileSync(path.join(output,'latest-column-dimensions.json'),JSON.stringify({width,theme,boxes,body:await root.locator('.chat-message-content').boundingBox()},null,2));
    if(output) await page.screenshot({path:path.join(output,'latest-columns.png')});
    if (width === 1440) assert.ok(Math.max(...boxes.map(box => box.top)) - Math.min(...boxes.map(box => box.top)) < 2, 'wide plans align side by side: '+JSON.stringify(boxes));
    else assert.ok(boxes[0].top < boxes[1].top && boxes[1].top < boxes[2].top, 'phone plans retain source order');
    measurements.push({ width, theme, sections: boxes });
    await sections.first().scrollIntoViewIfNeeded(); await capture(`columns-${width}-${theme}`);
    root = await choose('conditional');
    await field(root, 'customer_type').selectOption('person');
    assert.equal(await root.locator('.chat-question-description .chat-form-fields:visible').count(),0,'editable fields replace initial static field description');
    assert.equal(await root.locator('[data-field-key="company_name"]').isVisible(), false);
    await field(root, 'customer_type').selectOption('company'); await field(root, 'company_name').fill('保留的企业名称');
    await field(root, 'customer_type').selectOption('person');
    assert.equal(await root.locator('[data-field-key="company_name"]').isVisible(), false);
    await capture(`conditional-${width}-${theme}`);
    await field(root, 'customer_type').selectOption('company');
    assert.equal(await field(root, 'company_name').inputValue(), '保留的企业名称');
    root = await choose('form-error'); await formValues(root);
    const answersPattern = '**/api/chat/conversations/*/answers';
    simulatedAnswerError = true;
    await context.route(answersPattern, route => route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'invalid_chat_answer', fields: [{ key: 'company_name', reason: 'range' }] }) }));
    await root.locator('[data-action="answer"]').click();
    await root.locator('[data-field-key="company_name"] [aria-invalid="true"]').waitFor();
    assert.equal(await field(root, 'full_name').inputValue(), '林晓');
    assert.equal(await root.locator('.chat-form-error:visible').count(),1,'failed form shows one generic error');
    await capture(`form-error-${width}-${theme}`);
    await context.unroute(answersPattern); simulatedAnswerError = false;
    root = await choose('drafts'); await formValues(root);
    await page.reload(); await page.locator('#wb-chat [data-conversation-id]').first().waitFor(); root = await choose('drafts');
    assert.equal(await field(root, 'company_name').inputValue(), '示例科技', 'reload restores current-tab open draft');
    await field(root, 'full_name').focus();
    await field(root, 'full_name').evaluate(el => el.setSelectionRange(1, 1));
    const previousReads = reads;
    fixture.addOutbound(scenes.drafts.draft.localId, '增量消息不重建填写中的表单。');
    await page.locator('#wb-chat [data-action="refreshMessages"]').click();
    await page.waitForFunction(() => document.querySelector('#wb-chat')?.textContent.includes('增量消息不重建填写中的表单。'));
    // The explicit refresh button takes focus; restore it, then let the normal background read run.
    await field(root, 'full_name').focus(); await field(root, 'full_name').evaluate(el => el.setSelectionRange(1, 1));
    await page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/messages'), { timeout: 15_000 });
    assert.ok(reads > previousReads);
    assert.deepEqual(await field(root, 'full_name').evaluate(el => ({ active: document.activeElement === el, value: el.value, caret: el.selectionStart })), { active: true, value: '林晓', caret: 1 });
    await capture(`drafts-${width}-${theme}`);
    root = await choose('fallback'); assert.equal(await root.locator('.conversation-view-section').count(), 0);
    assert.ok(await page.locator(`[data-message-id="${invalid.id}"] .chat-block-error`).count());
    await root.scrollIntoViewIfNeeded(); await capture(`fallback-${width}-${theme}`);
    root = await choose('charts'); await settle();
    assert.equal(await root.locator('canvas').count(), 2);
    const chartInfo = await root.locator('canvas').evaluateAll(nodes => nodes.map(canvas => {
      const chart = window.Chart.getChart(canvas), r = canvas.getBoundingClientRect();
      return { type: chart?.config.type, stacked: chart?.options.scales.x.stacked ?? false, datasets: chart?.data.datasets.length, width: r.width, height: r.height };
    }));
    assert.deepEqual(chartInfo.map(info => info.type), ['bar', 'line']); assert.equal(chartInfo[0].stacked, true);
    assert.ok(chartInfo.every(info => info.datasets === 2 && info.width > 100 && info.height > 100));
    measurements.push({ width, theme, charts: chartInfo });
    for (const [index, kind] of ['stacked', 'line'].entries()) { await root.locator('.chat-chart').nth(index).scrollIntoViewIfNeeded(); await capture(`chart-${kind}-${width}-${theme}`); }
  }
  if(prototypeSource && output){
    const prototypePage=await context.newPage();
    prototypePage.on('pageerror',error=>{if(!errors.length)errors.push('prototype: '+error.message);});
    for(const width of [1440,390]) for(const theme of ['light','dark']){
      await prototypePage.setViewportSize({width,height:width===390?844:900});
      await prototypePage.goto(fixture.base+'/approved-prototype.html?view=chat&cc=dashboard:cmp-cache&theme='+theme);
      for(const [kind,title] of [['stacked','每秒处理请求数（压测回放）'],['line','命中率随时间']]){
        const chart=prototypePage.locator('.c-block').filter({has:prototypePage.locator('h5').filter({hasText:title})});
        await chart.waitFor();await chart.scrollIntoViewIfNeeded();
        const filename=path.join(output,`prototype-chart-${kind}-${width}-${theme}.png`);await prototypePage.screenshot({path:filename});prototypeShots.push(filename);
      }
    }
    await prototypePage.close();
  }
  const fallbackPage = await context.newPage();
  fallbackPage.on('pageerror', error => { if (!errors.length) errors.push(error.message); });
  for (const width of [1440, 390]) for (const theme of ['light', 'dark']) {
    await fallbackPage.setViewportSize({width,height:width===390?844:900});
    await fallbackPage.goto(fixture.base + '/renderer-fallback?theme=' + theme);
    await fallbackPage.locator('#fallback[data-ready="true"]').waitFor();
    assert.equal(await fallbackPage.locator('input,select,textarea,button').count(),0,'no renderer supplies no answer controls');
    assert.equal(await fallbackPage.locator('.conversation-view-columns').count(),0,'legacy host ignores valid View');
    assert.deepEqual(await fallbackPage.locator('.chat-message-content').first().locator('[data-block-id]').evaluateAll(nodes=>nodes.map(node=>node.dataset.blockId)),columnsMessage().blocks.map(block=>block.id));
    assert.match(await fallbackPage.locator('.chat-message-content').last().innerText(),/请填写姓名、邮箱与适用的公司信息/);
    if(output){const filename=path.join(output,`no-renderer-${width}-${theme}.png`);await fallbackPage.screenshot({path:filename});shots.push(filename);}
  }
  await fallbackPage.close();
  // Real API acceptance must omit retained inactive values and erase the local draft.
  await page.setViewportSize({ width: 1440, height: 900 });
  let root = await choose('conditional'); await formValues(root); await field(root, 'customer_type').selectOption('person');
  const answerRequest = page.waitForRequest(request => new URL(request.url()).pathname.endsWith('/answers') && request.method() === 'POST');
  const answerResponse=page.waitForResponse(response=>new URL(response.url()).pathname.endsWith('/answers')&&response.request().method()==='POST');
  await root.locator('[data-action="answer"]').click();
  const sent = (await answerRequest).postDataJSON();
  assert.equal((await answerResponse).status(),200,'actual API accepts active-only form');
  assert.equal(Object.hasOwn(sent.action.payload.values, 'company_name'), false);
  await page.waitForFunction(() => [...document.querySelectorAll('[data-interrupt-id="conditional_interrupt"] [data-field-key] input,[data-interrupt-id="conditional_interrupt"] [data-field-key] select')].every(control=>control.disabled&&control.value===''));
  assert.equal(await page.evaluate(() => Object.keys(sessionStorage).some(key => key.startsWith('zylos-dashboard-form-draft:') && key.includes('conditional_message'))), false);
  // A second client's actual answer wins over the still-open local draft.
  const draftScene = scenes.drafts, block = draftScene.envelope.blocks[0];
  const response = await fixture.request(draftScene.route + '/answers', { method: 'POST', body: { interruptId: draftScene.envelope.interruptId,
    action: { id: 'other-device-form-answer', protocolVersion: '0.1', type: block.data.action.type, target: block.data.action.target,
      context: { messageId: draftScene.envelope.messageId, blockId: block.id }, payload: { values: { customer_type: 'person', full_name: '另一设备', email: 'other@example.com' } } } } });
  assert.equal(response.status, 200);
  root = await choose('drafts'); await page.locator('#wb-chat .conversation-header-actions [data-action="refreshStatus"]').click();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-interrupt-id="drafts_interrupt"] [data-field-key] input,[data-interrupt-id="drafts_interrupt"] [data-field-key] select')].every(control=>control.disabled&&control.value===''));
  assert.equal(await page.evaluate(() => Object.keys(sessionStorage).some(key => key.startsWith('zylos-dashboard-form-draft:') && key.includes('drafts_message'))), false);
  assert.deepEqual(errors, []);
  if (output) fs.writeFileSync(path.join(output, 'conversation-genui-browser.json'), JSON.stringify({ sourceHead: process.env.ZYLOS_CHAT_SOURCE_HEAD || null, isolation, shots, prototypeShots, measurements, reads, errors,
    prototype: 'd17ffdbfb94eb094a4f80d89edc1b48bf85ca166', prototypeSourceBlob: prototypeSource ? '77d676e8735904aa4c223e8d1d98551a9e7d3f37' : null, simulatedErrors: ['HTTP400 field-error response only; final acceptance and second-client answer use actual API'], base: fixture.base }, null, 2));
  t.diagnostic(`GenUI browser: ${shots.length} screenshots, ${reads} real message reads, no page errors`);
}
