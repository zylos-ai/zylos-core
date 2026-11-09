import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Text checks of the shipped stylesheet and page: quick guards that the phone layout rules are still there.
// They do not render anything. The rendered result (no control under 40px, no sideways scrolling, the two-row
// detail header, the memory list and file screens, schedule numbers 3+3) is measured by the opt-in browser
// case in workbench-browser.test.js.
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

test('stylesheet: on phones every control a finger taps is at least 40px, icon-only and short labelled buttons 40px wide', () => {
  const rule = phone.match(/:is\(([^)]*)\)\s*:is\(button, select, summary, a\.wb-btn, input[^{]*\{ min-height: 40px; \}/);
  assert.ok(rule, 'one rule sets the minimum height of tappable controls');
  for (const area of ['.app-header', '#fleet-view', '#tab-overview', '#tab-memory', '#tab-observer', '#tab-trends', '#tab-schedule', '#tab-settings', '.wb-modal']) {
    assert.ok(rule[1].split(',').map(item => item.trim()).includes(area), area + ' is covered');
  }
  assert.doesNotMatch(rule[1], /#tab-chat/, 'the conversation page keeps its own layout');
  assert.match(phone, /:is\(\.app-header \.header-icon-btn, \.wb-icon-btn, \.memory-head \.memory-refresh, \.wb-btn\) \{ min-width: 40px; \}/);
  assert.match(phone, /\.wb-switch-l \{ min-height: 40px; \}/);
  assert.match(phone, /\.wb-sched-timeline \.wb-sched-dot \{[^}]*width: 40px; height: 40px;/, 'timeline dots are 40px targets');
  assert.match(phone, /\.memory-file, \.wb-memory-group-h, \.wb-memory-section-h \{ min-height: 40px; \}/);
});

test('stylesheet: on phones the memory file list and the open file each take the screen, with a way back', () => {
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

test('stylesheet: raw memory text wraps instead of scrolling sideways', () => {
  assert.match(css, /^\.memory-raw \{ white-space: pre-wrap; overflow-wrap: anywhere; \}/m);
});

test('stylesheet: on phones the schedule timeline labels are at least 11px', () => {
  assert.match(phone, /\.wb-sched-lane \.wb-sched-axis, \.wb-sched-lane \.wb-sched-axis span \{ font-size: 11px; \}/);
});

test('stylesheet: wider screens keep detail headers on one row; phones give the title its own row and put state and actions under it', () => {
  assert.match(css, /^\.wb-d-sub \{ display: contents; \}/m, 'on wider screens the state and actions stay in the title row');
  assert.match(phone, /\.wb-d-top:has\(> \.wb-d-sub\) \{ display: grid; grid-template-columns: auto minmax\(0, 1fr\) auto;/);
  assert.match(phone, /\.wb-d-top:has\(> \.wb-d-sub\) > :last-child \{ grid-column: 3; grid-row: 1; \}/, 'closing stays on the title row');
  assert.match(phone, /\.wb-d-top > \.wb-d-sub \{ grid-column: 2 \/ -1; grid-row: 2;/, 'the second row starts in the title column');
  assert.doesNotMatch(phone, /\.wb-d-top[^{]*\{[^}]*margin-left: \d+px/, 'the second row is aligned by the grid, not a fixed indent');
});

test('stylesheet: on phones overview rows are two columns: the group on the left, its state on the right, the rest full width', () => {
  assert.match(phone, /\.wb-row, html\[data-detail=technical\] \.wb-row \{ grid-template-columns: minmax\(0, 1fr\) auto;/);
  assert.match(phone, /\.wb-row > \.wb-pill \{ grid-column: 2; justify-self: end; \}/);
  assert.match(phone, /\.wb-row > \.wb-current, \.wb-row > \.wb-activity \{ grid-column: 1 \/ -1; \}/);
});

test('stylesheet: on phones the six schedule numbers form three columns by two rows', () => {
  assert.match(phone, /\.wb-sched-kpi \{ display: grid; grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/);
});

test('stylesheet: on phones the open memory file keeps its header compact: back, path and scope on one row', () => {
  assert.match(phone, /#tab-memory\.memory-file-open \.memory-viewer-head \{ display: grid; grid-template-columns: auto minmax\(0, 1fr\);/);
  assert.match(phone, /#tab-memory\.memory-file-open \.memory-back \{ grid-column: 1; grid-row: 1;[^}]*width: 40px;/);
  assert.match(phone, /#tab-memory\.memory-file-open \.memory-viewer-title \{ grid-column: 2; grid-row: 1; \}/);
  assert.match(phone, /#tab-memory\.memory-file-open \.memory-viewer-actions \{ grid-column: 1 \/ -1; grid-row: 2;/);
  // The label stays for screen readers while the button shows only its arrow.
  assert.match(phone, /\.memory-back > span \{ position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect\(0 0 0 0\);/);
});

test('stylesheet: on phones the settings sections are a drawer from the left; every drawer selector names an element the page builds', () => {
  const settings = read('js/wb/settings.js') + read('js/wb/settings-drawer.js');
  assert.match(css, /^\.wb-set-drawer-h, \.wb-set-drawer-btn, \.wb-set-scrim \{ display: none; \}/m, 'wider screens show the sidebar only');
  assert.match(phone, /\.wb-set-nav \{ position: fixed; top: 0; bottom: 0; left: 0;[^}]*align-self: stretch;[^}]*transform: translateX\(-104%\); visibility: hidden;/);
  assert.match(phone, /\.wb-set-drawer-open \.wb-set-nav \{ transform: none; visibility: visible;/);
  assert.match(phone, /@media \(prefers-reduced-motion: reduce\) \{ \.wb-set-nav, \.wb-set-scrim, \.wb-set-drawer-open :is\(\.wb-set-nav, \.wb-set-scrim\) \{ transition: none; \} \}/, 'no slide, open or closed');
  const drawerClasses = new Set(css.match(/\.wb-set-(?:drawer[\w-]*|scrim)\b/g));
  assert.ok(drawerClasses.size >= 5);
  for (const name of drawerClasses) assert.ok(settings.includes(`'${name.slice(1)}`) || settings.includes(` ${name.slice(1)}'`), name + ' is built by the settings page');
});

test('stylesheet: on phones usage ranges fill the row, custom dates fold onto one row, totals read as a list', () => {
  assert.match(css, /^\.wb-usage-custom \{ display: contents; \}/m, 'wide screens keep the dates in the control row');
  assert.match(css, /^\.wb-usage-custom-btn \{ display: none !important; \}/m);
  assert.match(phone, /\.wb-usage-controls \.wb-seg button \{ flex: 1 1 0;/);
  assert.match(phone, /\.wb-usage-custom \{ display: none;/);
  assert.match(phone, /\.wb-usage-custom-open \.wb-usage-custom \{ display: flex; \}/);
  assert.match(phone, /\.wb-usage-total \{ grid-template-columns: minmax\(0, 1fr\) auto; grid-template-areas: "label value" "sub value";/);
  assert.match(phone, /\.wb-usage-head \.wb-usage-legend \{ flex-basis: 100%; \}/, 'legends go under chart titles');
  assert.match(phone, /\.wb-usage-table tbody th:first-child \{ white-space: normal; overflow-wrap: anywhere; \}/, 'long names wrap inside data tables');
});

test('stylesheet: memory backlog rows are one 40px line on phones, with names wrapping and counts never cut', () => {
  // The count column grows to its content ("Unknown" in English) instead of spilling out of the card.
  assert.match(phone, /\.wb-memory-bl \{ grid-template-columns: minmax\(0, 1fr\) minmax\(56px, 26%\) minmax\(2\.6em, max-content\);[^}]*min-height: 40px; \}/);
  assert.match(css, /^\.wb-memory-bl \{ grid-template-columns: minmax\(120px, 260px\) minmax\(60px, 1fr\) minmax\(3em, max-content\);/m, 'and on wide screens');
  assert.match(phone, /\.wb-memory-bl-head \.wb-memory-chart-label \{ white-space: normal; overflow-wrap: anywhere;/);
});

test('stylesheet and page: on phones the terminal observer is one left-aligned column, the size form folds behind a button', () => {
  assert.match(phone, /\.wb-o-bar \{ flex-flow: row wrap; align-items: center; justify-content: flex-start;/, 'overrides the older stacked toolbar');
  assert.match(phone, /\.wb-o-bar > \* \{ flex: 1 1 100%; \}/, 'one item per row, controls fill the width');
  assert.match(phone, /\.wb-o-bar > #observer-back \{ flex: none; \}\s*\.wb-o-bar > \.wb-o-title \{ flex: 1 1 0;/, 'back button and title share the first row');
  assert.match(phone, /\.wb-o-bar \.wb-o-picker, \.wb-o-bar \.wb-o-picker select \{ width: 100%; \}/, 'outranks the 220px desktop select width');
  assert.match(phone, /\.wb-o-bar \.observer-view-switch button \{ flex: 1 1 0; \}/);
  assert.match(phone, /\.wb-o-size:not\(\.wb-o-size-open\) \{ display: none; \}/);
  assert.match(css, /^\.wb-o-size-btn \{ display: none; \}/m, 'wide screens keep the size form in the toolbar');
  assert.match(css, /^\.observer-frame-shell\.wb-o-wide:not\(\[hidden\]\) \+ \.wb-o-wide-hint \{ display: block; \}/m);
  // The picker label is read by screen readers only (the select already says "choose a running group"),
  // and the one-line scope note sits in the toolbar, under the picker, before any group is chosen.
  assert.match(html, /<span class="wb-vh" data-i18n="wb\.observer\.chooseGroup">/);
  const bar = html.slice(html.indexOf('wb-o-bar">'), html.indexOf('class="wb-o-notice"'));
  assert.ok(bar.indexOf('id="observer-group-picker"') < bar.indexOf('data-i18n="wb.observer.scope"'), 'scope note follows the picker');
  assert.match(bar, /id="observer-size-toggle"[^>]*aria-controls="observer-size-form" aria-expanded="false"/);
  assert.ok(html.indexOf('class="observer-frame-shell"') < html.indexOf('class="wb-note wb-o-wide-hint"'), 'the hint sits right after the frame');
  assert.match(app, /\$\('#observer-size-toggle'\)\?\.addEventListener\('click'/);
});

test('stylesheet: on phones a group\'s name has the first row, and the actions are icons beside a labelled conversation button', () => {
  assert.match(phone, /\.wb-group-head \.wb-d-top:has\(> \.wb-d-sub\) > \.wb-d-sub \{ display: flex; flex-wrap: wrap; grid-column: 1 \/ -1; grid-row: 2;/, 'state and actions form the second row');
  assert.match(phone, /\.wb-group-head \.wb-d-title \{ display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; white-space: normal;/, 'a long name takes two lines instead of being cut');
  assert.match(phone, /\.wb-group-head \.wb-d-acts > \.wb-act \{ flex: none; width: 40px; padding: 0; \}/);
  assert.match(phone, /\.wb-group-head \.wb-d-acts \.wb-act-label \{ display: none; \}/, 'secondary actions show their icon; their name stays as aria-label');
  // Wider touch screens (tablets) keep the labelled actions.
  assert.match(css, /@media \(max-width: 900px\) \{[^@]*\.wb-act-label \{ display: inline; \}/);
});
