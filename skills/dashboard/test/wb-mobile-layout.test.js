import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Phone layout rules read from the shipped stylesheet and page; the rendered sizes are measured in a browser
// for each change (1280 and 390 wide, light and dark), so these only keep the rules from being dropped.
const read = path => fs.readFileSync(new URL('../public/' + path, import.meta.url), 'utf8');
const css = read('css/wb.css'), html = read('index.html'), app = read('js/app.js');

// The bodies of every `@media (max-width: 760px)` block, joined.
function phoneRules(source) {
  const bodies = [];
  for (let at = source.indexOf('@media (max-width: 760px) {'); at >= 0; at = source.indexOf('@media (max-width: 760px) {', at + 1)) {
    let depth = 0, start = source.indexOf('{', at);
    for (let i = start; i < source.length; i++) {
      if (source[i] === '{') depth++;
      if (source[i] === '}' && --depth === 0) { bodies.push(source.slice(start + 1, i)); break; }
    }
  }
  return bodies.join('\n');
}
const phone = phoneRules(css);

test('on phones every control a finger taps is at least 40px, icon-only buttons 40px wide', () => {
  const rule = phone.match(/:is\(([^)]*)\)\s*:is\(button, select, summary, a\.wb-btn, input[^{]*\{ min-height: 40px; \}/);
  assert.ok(rule, 'one rule sets the minimum height of tappable controls');
  for (const area of ['.app-header', '#fleet-view', '#tab-overview', '#tab-memory', '#tab-observer', '#tab-trends', '#tab-schedule', '#tab-settings', '.wb-modal']) {
    assert.ok(rule[1].split(',').map(item => item.trim()).includes(area), area + ' is covered');
  }
  assert.doesNotMatch(rule[1], /#tab-chat/, 'the conversation page keeps its own layout');
  assert.match(phone, /:is\(\.app-header \.header-icon-btn, \.wb-icon-btn, \.memory-head \.memory-refresh\) \{ min-width: 40px; \}/);
  assert.match(phone, /\.wb-switch-l \{ min-height: 40px; \}/);
  assert.match(phone, /\.wb-sched-timeline \.wb-sched-dot \{[^}]*width: 40px; height: 40px;/, 'timeline dots are 40px targets');
  assert.match(phone, /\.memory-file, \.wb-memory-group-h, \.wb-memory-section-h \{ min-height: 40px; \}/);
});

test('on phones the memory file list and the open file each take the screen, with a way back', () => {
  assert.match(html, /<button class="memory-back wb-btn" id="memory-back" type="button">[\s\S]*?data-i18n="memory\.back"/);
  for (const locale of ['en', 'zh']) assert.ok(JSON.parse(read(`i18n/${locale}.json`))['memory.back'], locale + ' names the way back');
  assert.match(css, /^\.memory-back \{ display: none; \}/m, 'wider screens show both panes and no back button');
  assert.match(phone, /\.memory-back \{ display: inline-flex;/);
  assert.match(phone, /#tab-memory:not\(\.memory-file-open\) \.memory-viewer \{ display: none; \}/);
  assert.match(phone, /#tab-memory\.memory-file-open :is\(\.memory-tree-card, \.wb-memory-summary, \.wb-memory-charts\) \{ display: none; \}/);
  assert.match(phone, /\.memory-tree \{ max-height: none; \}/, 'the list is not squeezed into a box');
  // A file the user picks opens on its own screen; the back button returns to the list; the page keeps the class in step.
  assert.match(app, /onFile: path => \{ state\.memory\.filePaneOpen = true;/);
  assert.match(app, /\$\('#memory-back'\)\?\.addEventListener\('click', \(\) => \{ state\.memory\.filePaneOpen = false; renderMemory\(\);/);
  assert.match(app, /\$\('#tab-memory'\)\?\.classList\.toggle\('memory-file-open', state\.memory\.filePaneOpen\);/);
  assert.equal(app.match(/filePaneOpen: false/g)?.length, 2, 'a fresh page and a reset both start on the list');
});

test('raw memory text wraps instead of scrolling sideways', () => {
  assert.match(css, /^\.memory-raw \{ white-space: pre-wrap; overflow-wrap: anywhere; \}/m);
});

test('on phones the schedule timeline labels are at least 11px', () => {
  assert.match(phone, /\.wb-sched-lane \.wb-sched-axis, \.wb-sched-lane \.wb-sched-axis span \{ font-size: 11px; \}/);
});

test('wider screens keep detail headers on one row; phones give the title its own row and put state and actions under it', () => {
  assert.match(css, /^\.wb-d-sub \{ display: contents; \}/m, 'on wider screens the state and actions stay in the title row');
  assert.match(phone, /\.wb-d-top:has\(> \.wb-d-sub\) \{ display: grid; grid-template-columns: auto minmax\(0, 1fr\) auto;/);
  assert.match(phone, /\.wb-d-top:has\(> \.wb-d-sub\) > :last-child \{ grid-column: 3; grid-row: 1; \}/, 'closing stays on the title row');
  assert.match(phone, /\.wb-d-top > \.wb-d-sub \{ grid-column: 2 \/ -1; grid-row: 2;/, 'the second row starts in the title column');
  assert.doesNotMatch(phone, /\.wb-d-top[^{]*\{[^}]*margin-left: \d+px/, 'the second row is aligned by the grid, not a fixed indent');
});

test('on phones overview rows are two columns: the group on the left, its state on the right, the rest full width', () => {
  assert.match(phone, /\.wb-row, html\[data-detail=technical\] \.wb-row \{ grid-template-columns: minmax\(0, 1fr\) auto;/);
  assert.match(phone, /\.wb-row > \.wb-pill \{ grid-column: 2; justify-self: end; \}/);
  assert.match(phone, /\.wb-row > \.wb-current, \.wb-row > \.wb-activity \{ grid-column: 1 \/ -1; \}/);
});

test('on phones the six schedule numbers form three columns by two rows', () => {
  assert.match(phone, /\.wb-sched-kpi \{ display: grid; grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/);
});

test('on phones the open memory file keeps its header compact: back, path and scope on one row', () => {
  assert.match(phone, /#tab-memory\.memory-file-open \.memory-viewer-head \{ display: grid; grid-template-columns: auto minmax\(0, 1fr\);/);
  assert.match(phone, /#tab-memory\.memory-file-open \.memory-back \{ grid-column: 1; grid-row: 1;[^}]*width: 40px;/);
  assert.match(phone, /#tab-memory\.memory-file-open \.memory-viewer-title \{ grid-column: 2; grid-row: 1; \}/);
  assert.match(phone, /#tab-memory\.memory-file-open \.memory-viewer-actions \{ grid-column: 1 \/ -1; grid-row: 2;/);
  // The label stays for screen readers while the button shows only its arrow.
  assert.match(phone, /\.memory-back > span \{ position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect\(0 0 0 0\);/);
});
