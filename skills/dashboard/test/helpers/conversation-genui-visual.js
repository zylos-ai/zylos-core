import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createChatApiFixture, questionContent } from './chat-integration-api.js';
import { hashPassword } from '../../src/lib/auth.js';
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
  if (scene === 'controls') block.data.fields.push(
    { key: 'notes', label: '补充说明', type: 'multiline_text', maxLength: 500 },
    { key: 'employee_count', label: '参与人数', type: 'integer', min: 1, max: 100 },
    { key: 'start_date', label: '开始日期', type: 'date' },
    { key: 'region', label: '地区', type: 'single_select', options: [{id:'east',label:'华东'},{id:'south',label:'华南'},{id:'north',label:'华北'},{id:'west',label:'西部'},{id:'other',label:'其他'}] }
  );
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
      import {renderChatContent} from '/_assets/js/wb/chat-blocks.js?v=107';
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
      '/api/timeline': { items: [] }, '/api/instance-status': { status: 'ok' }, '/api/actions/meta': { actions: [] },
      '/api/settings': {active:'claude',runtimes:{claude:{modelPrices:{},builtInModels:[],fastMode:{}},codex:{modelPrices:{},builtInModels:[],priorityModelPrices:{},builtInPriorityModels:[]}}},
      '/api/workbench/pricing':{models:[]}, '/api/workbench/runtime-overrides':{runtime:[],runtimeTotal:0,nextAfter:null} };
    sendJson(res, 200, values[url.pathname] || {}); return true;
  } });
  const scenes = {};
  for (const name of ['columns', 'conditional', 'form-error', 'drafts', 'fallback', 'charts', 'controls']) {
    const conversation = await fixture.createConversation(name === 'controls' ? '比较一下缓存层的两个方案：A 用 Redis 集群，B 用本地 LRU + 失效广播。' : '请比较方案并保留填写中的信息。');
    const titles = { columns:'三种部署方案', conditional:'按需求准备方案', 'form-error':'条件表单 · 检查与重试', drafts:'继续填写方案信息', fallback:'兼容展示预览', charts:'缓存方案比较', controls:'控件与消息尺寸'  };
    assert.equal((await fixture.request(conversation.route,{method:'PATCH',body:{displayName:titles[name]}})).status,200);
    const envelope = name === 'columns' || name === 'fallback' ? columnsMessage(name === 'fallback') : name === 'charts' ? chartMessage() : formMessage(name);
    assert.equal(parseC4Content(questionContent(envelope)).kind, 'envelope', name + ' fixture uses actual schema');
    const shortAi = name === 'controls' ? fixture.addOutbound(conversation.draft.localId, '我先整理三种方案。') : null;
    const row = fixture.addOutbound(conversation.draft.localId, questionContent(envelope));
    scenes[name] = { ...conversation, row, envelope, shortAi };
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
  const errors = [], shots = [], prototypeShots = [], measurements = []; let reads = 0, simulatedAnswerError = false, simulatedRemoteUnauthorized = false;
  page.on('pageerror', error => { if (!errors.length) errors.push(error.message); });
  page.on('console', message => { if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:') && !errors.length) errors.push(message.text()); });
  page.on('response', response => {
    const url = new URL(response.url());
    if (url.pathname.endsWith('/messages')) reads++;
    if (response.status() >= 400 && url.pathname !== '/favicon.ico' && !(simulatedAnswerError && url.pathname.endsWith('/answers') && response.status() === 400) && !(simulatedRemoteUnauthorized && url.pathname.startsWith('/fleet/Remote/api/chat/') && response.status() === 401) && !errors.length) errors.push(`${response.status()} ${url.pathname}`);
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
  const chooseType = async (root, value) => {
    const messageId = await root.getAttribute('data-message-id');
    await root.locator(`[data-field-key="customer_type"] .chat-form-segment[value="${value}"]`).click();
    await page.waitForFunction(({messageId,value})=>{
      const buttons=[...document.querySelectorAll(`[data-message-id="${messageId}"] [data-field-key="customer_type"] .chat-form-segment`)];
      const selected=buttons.find(button=>button.value===value), other=buttons.find(button=>button.value!==value);
      return selected?.getAttribute('aria-pressed')==='true' && other?.getAttribute('aria-pressed')==='false'
        && getComputedStyle(selected).backgroundColor!==getComputedStyle(other).backgroundColor;
    },{messageId,value});
    const buttonStyles=await root.locator('[data-field-key="customer_type"] .chat-form-segment').evaluateAll(buttons=>buttons.map(button=>({value:button.value,pressed:button.getAttribute('aria-pressed'),background:getComputedStyle(button).backgroundColor})));
    assert.equal(buttonStyles.find(button=>button.value===value).pressed,'true');
    assert.equal(buttonStyles.find(button=>button.value!==value).pressed,'false');
    assert.notEqual(buttonStyles[0].background,buttonStyles[1].background,'selected segment is visibly distinct from unselected segment');
    measurements.push({width:page.viewportSize().width,segmentedSelection:value,buttonStyles});
  };
  const formValues = async root => {
    await chooseType(root, 'company');
    await field(root, 'full_name').fill('林晓'); await field(root, 'email').fill('lin@example.com');
    await field(root, 'company_name').fill('示例科技');
  };
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  for (const width of [1440, 390]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.addInitScript(value => { if(window===window.top && ['http:','https:'].includes(location.protocol)) localStorage.setItem('zylos-dashboard-theme', value); }, theme);
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
    await chooseType(root, 'person');
    assert.equal(await root.locator('.chat-question-description .chat-form-fields:visible').count(),0,'editable fields replace initial static field description');
    assert.equal(await root.locator('[data-field-key="company_name"]').isVisible(), false);
    await chooseType(root, 'company'); await field(root, 'company_name').fill('保留的企业名称');
    await chooseType(root, 'person');
    assert.equal(await root.locator('[data-field-key="company_name"]').isVisible(), false);
    await capture(`conditional-${width}-${theme}`);
    await chooseType(root, 'company');
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
      return { type: chart?.config.type, stacked: chart?.options.scales.x.stacked ?? false, legendClickDisabled: chart?.options.plugins.legend.onClick === null, datasets: chart?.data.datasets.length, width: r.width, height: r.height };
    }));
    assert.deepEqual(chartInfo.map(info => info.type), ['bar', 'line']); assert.equal(chartInfo[0].stacked, false, 'category series use grouped bars without private protocol hints');
    assert.ok(chartInfo.every(info => info.legendClickDisabled), 'small canvas legend markers are noninteractive');
    assert.ok(chartInfo.every(info => info.datasets === 2 && info.width > 100 && info.height > 100));
    measurements.push({ width, theme, charts: chartInfo });
    for (const [index, kind] of ['grouped', 'line'].entries()) { await root.locator('.chat-chart').nth(index).scrollIntoViewIfNeeded(); await capture(`chart-${kind}-${width}-${theme}`); }
    if (width === 390) {
      const summaries = await root.locator('.conversation-chart-data > summary').evaluateAll(nodes => nodes.map(node => ({ height: node.getBoundingClientRect().height, width: node.getBoundingClientRect().width })));
      assert.ok(summaries.every(box => box.height >= 40 && box.width >= 40), 'chart data disclosures have phone-sized targets');
      measurements.push({ width, theme, chartSummaries: summaries });
    }
    root = await choose('controls');
    await formValues(root);
    await field(root, 'notes').fill('第一行说明\n第二行说明');
    assert.equal(await field(root, 'notes').inputValue(), '第一行说明\n第二行说明');
    assert.equal(await field(root, 'notes').evaluate(el => el.tagName), 'TEXTAREA', 'multiline field uses a real textarea');
    await field(root, 'employee_count').fill('8'); await field(root, 'start_date').fill('2026-11-08');
    await field(root, 'region').selectOption('east');
    const controlSizes = await root.locator('[data-field-key] input:visible,[data-field-key] select:visible,[data-field-key] textarea:visible,.chat-form-segment:visible').evaluateAll(nodes => nodes.map(el => ({tag:el.tagName,type:el.type,height:el.getBoundingClientRect().height,width:el.getBoundingClientRect().width})));
    if(output)fs.writeFileSync(path.join(output,'latest-control-dimensions.json'),JSON.stringify({width,theme,controlSizes},null,2));
    if(width===390) assert.ok(controlSizes.every(box=>box.height>=40&&box.width>=40),'text,select,number,date,multiline and segmented controls have40px phone targets: '+JSON.stringify(controlSizes));
    measurements.push({ width, theme, controlSizes });
    await field(root, 'notes').scrollIntoViewIfNeeded(); await capture(`controls-${width}-${theme}`);
    const user = page.locator(`[data-message-id="${scenes.controls.receipt.messageId}"]`);
    const shortAi = page.locator(`[data-message-id="${scenes.controls.shortAi.id}"]`);
    const userBox = await user.locator('.conversation-message-body').boundingBox();
    const shortAiBox = await shortAi.locator('.conversation-message-body').boundingBox();
    if(output)fs.writeFileSync(path.join(output,'latest-message-dimensions.json'),JSON.stringify({width,theme,userBox,shortAiBox},null,2));
    assert.ok(userBox.width>150&&userBox.width<=Math.min(600,width-50),'user text bubble retains readable intrinsic width rather than collapsing');
    if(width===390) assert.ok(userBox.width>=220&&userBox.width<=320,'phone user bubble matches the roughly286px baseline: '+JSON.stringify(userBox));
    assert.ok(shortAiBox.width>70&&shortAiBox.width<500,'short AI reply does not expand to900px');
    measurements.push({ width, theme, userBubble:userBox,shortAiBubble:shortAiBox });
    await user.scrollIntoViewIfNeeded(); await capture(`messages-${width}-${theme}`);
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
  let root = await choose('conditional'); await formValues(root); await chooseType(root, 'person');
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
  await page.waitForFunction(() => [...document.querySelectorAll('[data-interrupt-id="drafts_interrupt"] [data-field-key] input,[data-interrupt-id="drafts_interrupt"] [data-field-key] select')].every(control=>control.disabled));
  assert.equal(await field(root, 'full_name').inputValue(), '林晓', 'other-client lifecycle transition keeps the visible local input');
  assert.equal(await field(root, 'company_name').inputValue(), '示例科技', 'visible company input remains in the locked form');
  assert.equal(await page.evaluate(() => Object.keys(sessionStorage).some(key => key.startsWith('zylos-dashboard-form-draft:') && key.includes('drafts_message'))), false);
  // Exercise the app's actual remote conversation fetch adapter. Only this
  // instance's next history response is unauthorized; ordinary data still uses
  // the real fixture, so an unrelated background request cannot clear drafts.
  fixture.setProxy(fixture);
  assert.equal((await fixture.request('/api/chat/settings', { method: 'PUT', body: { allowRemote: true } })).status, 200);
  await page.goto(fixture.base + '/fleet/Remote/chat');
  await page.locator('#wb-chat [data-conversation-id]').first().waitFor();
  root = await choose('controls'); await formValues(root); await chooseType(root, 'person');
  const remoteDrafts = () => page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('zylos-dashboard-form-draft:'))
    .map(key => JSON.parse(sessionStorage.getItem(key))).filter(record => record.scope.instance.endsWith('/fleet/Remote')));
  assert.ok((await remoteDrafts()).some(record => record.values.company_name === '示例科技'), 'remote draft contains retained inactive input before authentication loss');
  let unauthorizedReads = 0;
  simulatedRemoteUnauthorized = true;
  const remoteHistoryPattern = '**/fleet/Remote/api/chat/conversations/*/messages?*';
  await context.route(remoteHistoryPattern, route => {
    if (unauthorizedReads++) return route.continue();
    return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'chat_auth_required' }) });
  });
  const unauthorizedResponse = page.waitForResponse(response => new URL(response.url()).pathname.startsWith('/fleet/Remote/api/chat/') && response.status() === 401);
  await page.locator('#wb-chat [data-action="refreshMessages"]').click(); await unauthorizedResponse;
  await page.waitForFunction(() => [...document.querySelectorAll('[data-interrupt-id="controls_interrupt"] [data-field-key] input,[data-interrupt-id="controls_interrupt"] [data-field-key] select,[data-interrupt-id="controls_interrupt"] [data-field-key] textarea')].every(control => control.disabled && control.value === ''));
  assert.equal((await remoteDrafts()).length, 0, 'remote 401 clears that instance persistent drafts through the actual application fetch adapter');
  assert.equal(await root.count(), 1, 'authentication loss retains the mounted form');
  assert.equal(await field(root, 'full_name').inputValue(), '', 'authentication loss clears the visible input');
  assert.equal(await field(root, 'full_name').isDisabled(), true, 'authentication loss locks the visible input');
  assert.equal(await field(root, 'company_name').inputValue(), '', 'authentication loss clears retained inactive input too');
  assert.equal(await root.locator('.chat-form-segment').count(), 2);
  assert.ok(await root.locator('.chat-form-segment').evaluateAll(nodes => nodes.every(control => control.disabled)), 'remote 401 locks segmented controls too');
  await page.locator('#wb-chat .conversation-update-error:visible').waitFor();
  assert.ok((await page.locator('#wb-chat .conversation-update-error').innerText()).trim(), 'remote unauthorized read displays an update prompt');
  await context.unroute(remoteHistoryPattern); simulatedRemoteUnauthorized = false;
  await page.goto(fixture.base + '/chat'); await page.locator('#wb-chat [data-conversation-id]').first().waitFor();
  // Exercise the actual application logout handler before a failed transport resolves.
  await choose('controls'); root = page.locator(`[data-message-id="${scenes.controls.row.id}"]`);
  await formValues(root); await chooseType(root,'person');
  let logoutRoute, resolveLogout;
  const logoutStarted = new Promise(resolve=>{resolveLogout=resolve;});
  await context.route('**/logout', route=>{logoutRoute=route;resolveLogout();});
  await page.locator('#wb-settings-btn').click();
  await page.locator('[data-settings-section="ui"]').click();
  await page.locator('#logout-btn').click(); await logoutStarted;
  assert.equal(await page.evaluate(()=>Object.keys(sessionStorage).filter(key=>key.startsWith('zylos-dashboard-form-draft:')).length),0,'actual logout handler clears stored drafts before failed transport');
  assert.ok(await root.locator('[data-field-key] input,[data-field-key] select,[data-field-key] textarea').evaluateAll(nodes=>nodes.every(control=>control.value==='')),'actual logout handler clears mounted hidden values before failed transport');
  await logoutRoute.abort(); await context.unroute('**/logout');
  await page.waitForURL(url=>url.pathname==='/'||url.pathname==='/login');
  // Native successful login sets the cleanup marker; stale edits cannot restore.
  fixture.config.auth.password=hashPassword('isolated-login-password');
  await page.goto('about:blank'); await context.clearCookies(); await page.goto(fixture.base+'/login');
  await page.locator('input[name="password"]').waitFor();
  const staleScope={authRoot:fixture.base,instance:fixture.base,conversationId:scenes.controls.receipt.conversationId,messageId:scenes.controls.envelope.messageId,blockId:'customer_form',schemaVersion:2};
  assert.equal(await page.evaluate(async ({scope})=>{const {browserDraftStore}=await import('/_assets/js/wb/chat-drafts.js?v=102');return browserDraftStore.save(scope,{customer_type:'company',full_name:'stale login',email:'stale@example.com',company_name:'stale hidden'}).saved;},{scope:staleScope}),true);
  await page.locator('input[name="password"]').fill('isolated-login-password');
  await Promise.all([page.waitForURL(url=>url.pathname==='/'),page.locator('button[type="submit"]').click()]);
  await page.goto(fixture.base+'/chat'); await page.locator('#wb-chat [data-conversation-id]').first().waitFor(); root=await choose('controls');
  assert.equal(await field(root,'full_name').inputValue(),'','successful native login clears before restoring the page');
  assert.equal(await field(root,'company_name').inputValue(),'','successful login clears hidden stale values too');
  assert.equal(await page.evaluate(()=>Object.keys(sessionStorage).filter(key=>key.startsWith('zylos-dashboard-form-draft:')).length),0);
  assert.deepEqual(errors, []);
  if (output) fs.writeFileSync(path.join(output, 'conversation-genui-browser.json'), JSON.stringify({ sourceHead: process.env.ZYLOS_CHAT_SOURCE_HEAD || null, sourceProductDigest: process.env.ZYLOS_CHAT_SOURCE_PRODUCT_DIGEST || null, isolation, shots, prototypeShots, measurements, reads, errors,
    prototype: 'd17ffdbfb94eb094a4f80d89edc1b48bf85ca166', prototypeSourceBlob: prototypeSource ? '77d676e8735904aa4c223e8d1d98551a9e7d3f37' : null, authChecks: { actualLogoutClearsBeforeAbortedTransport: true, nativeSuccessfulLoginClearsBeforeRestore: true, remoteUnauthorizedConversationReadClearsAndLocks: true }, simulatedErrors: ['HTTP400 field-error response; final acceptance and second-client answer use actual API', 'One remote conversation history HTTP401; actual app fetch boundary clears and locks', 'Aborted logout POST after actual application cleanup'], base: fixture.base }, null, 2));
  t.diagnostic(`GenUI browser: ${shots.length} screenshots, ${reads} real message reads, no page errors`);
}
