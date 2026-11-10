import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const publicRoot = fileURLToPath(new URL('../../public/', import.meta.url));
const schema = fileURLToPath(new URL('../../../comm-bridge/scripts/c4-content-schema.js', import.meta.url));

const fixture = `<!doctype html><html lang="en" data-theme="light"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<script>document.documentElement.dataset.theme=new URL(location).searchParams.get('theme')||'light';</script>
<link rel="stylesheet" href="/css/style.css"><link rel="stylesheet" href="/themes/light.css">
<link rel="stylesheet" href="/themes/dark.css"><link rel="stylesheet" href="/css/wb.css">
<link rel="stylesheet" href="/css/conversation.css">
<style>html,body{overflow:auto;height:auto}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 system-ui}main{max-width:920px;margin:auto;padding:24px 16px;box-sizing:border-box}h1{font-size:20px;margin:0 0 18px}article{margin-bottom:16px;min-width:0}.confirmation-pair{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}@media(max-width:600px){.confirmation-pair{grid-template-columns:minmax(0,1fr)}}.conversation-page{display:block}.chat-message-content{width:100%;box-sizing:border-box}</style>
<script src="/vendor/chart.umd.js"></script><script src="/js/markdown-it.min.js"></script>
</head><body><main class="conversation-page"><h1>Conversation</h1>
<article id="invalid"></article><div class="confirmation-pair"><article id="normal"></article><article id="destructive"></article></div><article id="duration"></article></main>
<script type="module">
import {renderConversationContent} from '/js/wb/conversation-content.js';
import {renderQuestion} from '/js/wb/chat-questions.js';
import {makeQuestionSummary} from '/chat-schema.js';
const translations=await fetch('/i18n/wb.en.json').then(response=>response.json());
const t=key=>translations[key]??key;
const literal='**Release notes** <script>alert("unsafe")<'+ '/script> [details](https://example.test)';
const invalid={version:1,kind:'message',messageId:'invalid-message',fallbackText:literal,blocks:[{id:'unknown',type:'future_block',schemaVersion:1,data:{},fallbackText:'Must not render'}]};
const resources=[];
function mount(id,envelope,index){
 const row={id:index,direction:'out',content:'[C4-JSON]\\n'+JSON.stringify(envelope)};
 const content=renderConversationContent({document,row,t,renderQuestion:({block})=>renderQuestion({document,envelope,block,row,t,canWrite:true,
 question:{c4Id:String(index),messageId:envelope.messageId,interruptId:envelope.interruptId,questionSummary:envelope.questionSummary,status:'paused'},onSubmit:async()=>{window.submitted=(window.submitted??0)+1;}})});
 document.getElementById(id).append(content);content.mount();resources.push(content);
}
mount('invalid',invalid,1);
for(const [index,severity] of ['normal','destructive'].entries()){
 const block={id:'confirmation',type:'confirmation',schemaVersion:1,fallbackText:severity==='destructive'?'Remove draft?':'Save draft?',data:{title:severity==='destructive'?'Remove draft?':'Save draft?',body:severity==='destructive'?'This draft will be removed.':'Save the current draft.',severity,confirmLabel:severity==='destructive'?'Remove draft':'Save draft',cancelLabel:'Cancel',action:{type:'confirmation.respond',target:'draft.confirm',...(severity==='destructive'?{requiresConfirmation:true}:{})}}};
 const envelope={version:1,kind:'message',messageId:severity+'-message',fallbackText:block.fallbackText,blocks:[block],interruptId:severity+'-interrupt',interrupt:{blockId:block.id,reason:'confirmation',otherInput:false}};
 envelope.questionSummary=makeQuestionSummary(envelope);mount(severity,envelope,index+2);
}
mount('duration',{version:1,kind:'message',messageId:'duration-message',fallbackText:'Processing duration',blocks:[{id:'duration',type:'time_series',schemaVersion:1,fallbackText:'Short: 59s; Hour: 1h; Long: 1h 30m',data:{title:'Processing duration',xType:'category',xLabel:'Run',yLabel:'Duration',format:{style:'duration'},series:[{key:'duration',label:'Elapsed',points:[{x:'Short',y:59},{x:'Hour',y:3600},{x:'Long',y:5400}]}]}}]},4);
document.querySelector('details').open=true;
window.displayFixture={literal,resources};document.body.dataset.ready='true';
</script></body></html>`;

export async function runDisplayRefinements(sandbox) {
  const modulePath = process.env.ZYLOS_CHAT_BROWSER_MODULE;
  const executablePath = process.env.ZYLOS_CHAT_BROWSER_BIN;
  const chartPath = process.env.ZYLOS_CHAT_CHART_ASSET;
  for (const filename of [modulePath, executablePath, chartPath]) assert.ok(filename && fs.existsSync(filename), 'Explicit local browser and chart assets are required');
  const output = process.env.ZYLOS_CHAT_EVIDENCE_DIR;
  assert.ok(output && path.isAbsolute(output), 'Evidence directory must be explicit');
  fs.mkdirSync(output, { recursive: true });
  const isolation = sandbox.assertIsolation();
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(fixture); return; }
    const filename = pathname === '/chat-schema.js' ? schema : pathname === '/vendor/chart.umd.js' ? chartPath
      : path.resolve(publicRoot, '.' + pathname);
    if (![schema, chartPath].includes(filename) && !filename.startsWith(publicRoot)) { res.writeHead(404); res.end(); return; }
    if (!fs.existsSync(filename) || !fs.statSync(filename).isFile()) { res.writeHead(404); res.end(); return; }
    const type = filename.endsWith('.css') ? 'text/css' : filename.endsWith('.json') ? 'application/json' : 'text/javascript';
    res.writeHead(200, { 'content-type': type }); fs.createReadStream(filename).pipe(res);
  });
  const base = await sandbox.startHttp(server);
  const { chromium } = await import(pathToFileURL(modulePath));
  // Chromium's profile/cache exceeds the shared-memory filesystem on small
  // containers. Its scratch directory is separately allocated and recorded;
  // HOME and every instance/PM2/database path stay in the proven sandbox.
  const browserTmpParent = process.env.ZYLOS_CHAT_BROWSER_TMP_PARENT;
  assert.ok(browserTmpParent && path.isAbsolute(browserTmpParent));
  const browserTmp = fs.mkdtempSync(path.join(fs.realpathSync(browserTmpParent), 'display-browser-'));
  const browserEnv = { ...sandbox.env, TMPDIR: browserTmp };
  assert.equal(fs.realpathSync(browserTmp), browserTmp);
  assert.equal(browserEnv.HOME, isolation.HOME);
  assert.equal(browserEnv.ZYLOS_DIR, isolation.ZYLOS_DIR);
  assert.equal(browserEnv.PM2_HOME, isolation.PM2_HOME);
  sandbox.addCleanup(() => fs.rmSync(browserTmp, { recursive: true, force: true }));
  console.log('Private browser scratch:', browserTmp);
  let browser;
  sandbox.addCleanup(async () => { await browser?.close(); });
  browser = await chromium.launch({ executablePath, headless: true, env: browserEnv, timeout: 15_000,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking', '--disable-component-update', '--no-first-run'] });
  const context = await browser.newContext({ locale: 'en-US' });
  await context.route('**/*', route => route.request().url().startsWith(base + '/') ? route.continue() : route.abort());
  const page = await context.newPage(); page.setDefaultTimeout(10_000);
  const errors = [], measurements = [];
  page.on('pageerror', error => { if (!errors.length) errors.push(error.message); });
  for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(base + '/?theme=' + theme);
    await page.waitForSelector('body[data-ready="true"]');
    await page.evaluate(() => window.displayFixture.resources.forEach(resource => resource.mount()));
    await page.waitForFunction(() => window.Chart.getChart(document.querySelector('canvas'))?.width > 100);
    const result = await page.evaluate(() => {
      const invalid = document.querySelector('#invalid');
      const danger = document.querySelector('#destructive [data-action="confirmAnswer"]');
      const normal = document.querySelector('#normal [data-action="confirmAnswer"]');
      const consequence = document.querySelector('#destructive .chat-question-description > .chat-block-title + .chat-block-text');
      const tokenColor = token => {
        const probe = document.createElement('span'); probe.style.backgroundColor = `var(${token})`;
        consequence.append(probe); const color = getComputedStyle(probe).backgroundColor; probe.remove(); return color;
      };
      const canvas = document.querySelector('canvas'), chart = window.Chart.getChart(canvas);
      const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let painted = 0;
      for (let i = 3; i < pixels.length; i += 4) if (pixels[i]) painted++;
      return { literal: invalid.querySelector('.chat-invalid-fallback')?.textContent, expectedLiteral: window.displayFixture.literal,
        invalidElements: invalid.querySelectorAll('a,script,button,input,select,textarea,.chat-block').length,
        notice: invalid.querySelector('.chat-notice')?.textContent,
        danger: danger && { background: getComputedStyle(danger).backgroundColor, color: getComputedStyle(danger).color, severity: danger.closest('.chat-question').dataset.severity },
        normal: normal && { background: getComputedStyle(normal).backgroundColor, severity: normal.closest('.chat-question').dataset.severity },
        consequence: { background: getComputedStyle(consequence).backgroundColor, shadow: getComputedStyle(consequence).boxShadow,
          icon: getComputedStyle(consequence, '::before').backgroundColor, soft: tokenColor('--c-danger-soft'), ink: tokenColor('--c-danger-ink') },
        cardBorderWidth: getComputedStyle(document.querySelector('#destructive .chat-block-confirmation')).borderInlineStartWidth,
        table: document.querySelector('#duration .chat-chart-table')?.textContent,
        ticks: [59,3600,5400].map(value => chart.config.options.scales.y.ticks.callback(value)),
        generatedTicks: chart.scales.y.ticks.map(tick => ({ value: tick.value, label: tick.label })),
        tooltips: [59,3600,5400].map(value => chart.config.options.plugins.tooltip.callbacks.label({parsed:{y:value},dataset:chart.data.datasets[0]})),
        painted, canvasWidth: canvas.width, canvasHeight: canvas.height,
        overflow: document.documentElement.scrollWidth > innerWidth + 1,
        bodyBackground: getComputedStyle(document.body).backgroundColor };
    });
    assert.equal(result.literal, result.expectedLiteral); assert.equal(result.invalidElements, 0);
    assert.equal(result.notice, 'Some content could not be displayed.');
    assert.equal(result.danger?.severity, 'destructive'); assert.equal(result.normal?.severity, 'normal');
    assert.notEqual(result.danger.background, result.normal.background);
    assert.equal(result.cardBorderWidth, '0px', 'destructive cards use the consequence callout without a left border');
    assert.equal(result.consequence.background, result.consequence.soft, 'consequence uses the semantic danger tint');
    assert.notEqual(result.consequence.background, 'rgba(0, 0, 0, 0)');
    assert.ok(result.consequence.shadow.includes('inset'), 'consequence retains its danger inset ring');
    assert.equal(result.consequence.icon, result.consequence.ink, 'warning icon uses the semantic danger ink');
    for (const duration of ['59s', '1h', '1h 30m']) assert.ok(result.table?.includes(duration), duration + ' is visible in the actual data table');
    assert.equal(result.ticks.join('|'), '59s|1h|1h 30m');
    assert.deepEqual(result.generatedTicks, [
      { value: 0, label: '0s' }, { value: 1800, label: '30m' },
      { value: 3600, label: '1h' }, { value: 5400, label: '1h 30m' }
    ]);
    assert.equal(result.tooltips.join('|'), 'Elapsed: 59s|Elapsed: 1h|Elapsed: 1h 30m');
    assert.ok(result.painted > 1000); assert.ok(result.canvasWidth > 100 && result.canvasHeight > 100);
    assert.equal(result.overflow, false); assert.equal(errors.length, 0, errors[0]);
    const filename = path.join(output, `display-${width}-${theme}.png`);
    await page.screenshot({ path: filename, fullPage: true });
    measurements.push({ width, theme, ...result, screenshot: filename });
  }
  assert.notEqual(measurements[0].bodyBackground, measurements[1].bodyBackground);
  fs.writeFileSync(path.join(output, 'display-measurements.json'), JSON.stringify({ isolation, browserTmp, measurements }, null, 2));
  console.log('Display screenshots:', measurements.map(result => result.screenshot).join(', '));
}
