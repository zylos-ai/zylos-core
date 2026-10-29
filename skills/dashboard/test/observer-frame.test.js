import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { DEFAULT_OBSERVER_SIZE, validObserverSize } from '../public/js/observer-size.js';
import { observerFrameDocument, OBSERVER_FRAME_ASSETS } from '../src/lib/observer-frame.js';

const flush = () => new Promise(resolve => setImmediate(resolve));
function frame(documentHtml = observerFrameDocument()) {
  let resolveFont, rejectFont;
  const font = new Promise((resolve, reject) => { resolveFont = resolve; rejectFont = reject; });
  const calls = { open: 0, dispose: 0, sizes: [], writes: [], fonts: [], loads: [], wheelListeners: [] };
  const timers = new Map(), frames = new Map();
  let nextId = 0;
  const context = {
    parent: {}, ArrayBuffer, Uint8Array,
    document: {
      fonts: { load(...args) { calls.loads.push(args); return font; } },
      getElementById: () => ({}),
      querySelector: () => ({ getBoundingClientRect: () => ({ width: 900.25, height: 450.75 }) }),
    },
    Terminal: class {
      constructor(options) {
        calls.options = options;
        this.options = {};
        Object.defineProperty(this.options, 'fontFamily', { set(value) { calls.fonts.push(value); } });
      }
      open() {
        calls.open++;
        const listeners = new Map();
        this.textarea = {
          readOnly: false, attributes: {},
          setAttribute(name, value) { this.attributes[name] = value; },
          addEventListener(name, callback) { listeners.set(name, callback); },
          focus() { context.document.activeElement = this; listeners.get('focus')?.(); },
          blur() { if (context.document.activeElement === this) context.document.activeElement = null; },
        };
        calls.textarea = this.textarea;
      }
      dispose() { calls.dispose++; }
      resize(cols, rows) { calls.sizes.push({ cols, rows }); this.onResizeCallback?.(); }
      onResize(callback) { this.onResizeCallback = callback; }
      write(bytes) { calls.writes.push(bytes); }
    },
    addEventListener(name, callback, options) { if (name === 'wheel') calls.wheelListeners.push({ callback, options }); },
    removeEventListener() {},
    setTimeout(fn, delay) { assert.equal(delay, 1000); timers.set(++nextId, fn); return nextId; },
    clearTimeout(id) { timers.delete(id); },
    requestAnimationFrame(fn) { frames.set(++nextId, fn); return nextId; },
    cancelAnimationFrame(id) { frames.delete(id); },
  };
  const script = documentHtml.split('<script nonce="observer-frame">').at(-1).split('</script>')[0];
  vm.runInNewContext(script, context);
  const channel = { messages: [], starts: 0, closes: 0,
    start() { this.starts++; }, close() { this.closes++; }, postMessage(message) { this.messages.push(JSON.parse(JSON.stringify(message))); } };
  const initialize = (source = context.parent, ports = [channel]) => context.initialize({ source, data: { type: 'observer-init' }, ports });
  const send = data => channel.onmessage?.({ data });
  return { calls, channel, initialize, send, resolveFont, rejectFont, document: context.document,
    timeout() { for (const fn of timers.values()) fn(); timers.clear(); },
    paint() { const pending = [...frames.values()]; frames.clear(); for (const fn of pending) fn(); } };
}

test('read-only frame helper suppresses keyboard requests and immediately releases focus', async () => {
  const f = frame(); f.resolveFont([]); await flush();
  const textarea = f.calls.textarea;
  assert.equal(textarea.readOnly, true);
  assert.equal(textarea.attributes.inputmode, 'none');
  assert.equal(textarea.attributes.tabindex, '-1');
  for (let attempt = 0; attempt < 2; attempt++) {
    textarea.focus();
    assert.notEqual(f.document.activeElement, textarea);
  }
});

test('focus oracle detects the frame with keyboard protection removed', async () => {
  const html = observerFrameDocument();
  const mutant = html.replace(/  \/\/ Read-only viewing must not summon[\s\S]*?textarea.addEventListener\('focus',\(\)=>textarea.blur\(\)\);\n/, '');
  assert.notEqual(mutant, html);
  const f = frame(mutant); f.resolveFont([]); await flush();
  f.calls.textarea.focus();
  assert.throws(() => assert.notEqual(f.document.activeElement, f.calls.textarea), assert.AssertionError);
  assert.equal(f.calls.textarea.readOnly, false);
});

test('wheel events are stopped before xterm so it cannot cancel page scrolling', async () => {
  const f = frame(); f.resolveFont([]); await flush();
  assert.equal(f.calls.wheelListeners.length, 1);
  const [{ callback, options }] = f.calls.wheelListeners;
  assert.deepEqual({ ...options }, { capture: true, passive: true });
  let stopped = 0, prevented = 0;
  callback({ type: 'wheel', deltaY: 120, stopPropagation() { stopped++; }, preventDefault() { prevented++; } });
  assert.deepEqual({ stopped, prevented }, { stopped: 1, prevented: 0 });
});

test('size contract enforces inclusive integer bounds', () => {
  assert.deepEqual(DEFAULT_OBSERVER_SIZE, { cols: 80, rows: 24 });
  for (const value of [{ cols: 20, rows: 5 }, { cols: 500, rows: 200 }]) assert.equal(validObserverSize(value), true);
  for (const value of [null, {}, { cols: '80', rows: 24 }, { cols: 80.1, rows: 24 }, { cols: 19, rows: 24 }, { cols: 501, rows: 24 }, { cols: 80, rows: 4 }, { cols: 80, rows: 201 }]) assert.equal(validObserverSize(value), false);
});

test('frame waits for font, accepts latest size and reports rounded actual metrics', async () => {
  const f = frame(); f.initialize();
  f.send({ type: 'size', cols: 100, rows: 30 });
  f.send({ type: 'size', cols: 140, rows: 41 });
  await flush();
  assert.equal(f.calls.open, 0); assert.deepEqual(f.channel.messages, []);
  assert.deepEqual(f.calls.loads, [['15px "Zylos Observer Symbols"', '⏵']]);
  f.resolveFont([]); await flush(); f.paint();
  assert.equal(f.calls.open, 1);
  assert.deepEqual(f.calls.sizes, [{ cols: 140, rows: 41 }]);
  assert.deepEqual(f.channel.messages, [{ type: 'ready' }, { type: 'metrics', width: 901, height: 451 }]);
  f.send({ type: 'size', cols: 100, rows: 30 }); f.paint();
  assert.deepEqual(f.calls.sizes.at(-1), { cols: 100, rows: 30 });
  f.send({ type: 'render', bytes: new Uint8Array([65]).buffer });
  assert.equal(f.calls.writes.length, 1);
});

test('frame rejects wrong sources, multiple ports, invalid sizes and obsolete presets', async () => {
  const f = frame(); f.initialize({}); f.initialize(undefined, [f.channel, f.channel]);
  assert.equal(f.channel.starts, 0);
  f.initialize(); f.initialize(); assert.equal(f.channel.starts, 1);
  f.resolveFont([]); await flush(); f.paint();
  for (const data of [{ type: 'preset', preset: 'large' }, { type: 'size', cols: 501, rows: 24 }, { type: 'size', cols: 80, rows: 4 }, { type: 'size', cols: 80.5, rows: 24 }, { type: 'size', cols: '80', rows: 24 }]) f.send(data);
  assert.deepEqual(f.calls.sizes, []);
});

test('font timeout opens terminal and late font completion remeasures and sends metrics', async () => {
  const f = frame(); f.initialize(); await flush(); f.timeout(); await flush(); f.paint();
  assert.equal(f.calls.open, 1); assert.equal(f.calls.fonts.length, 0);
  f.resolveFont([]); await flush(); f.paint();
  assert.equal(f.calls.open, 1); assert.equal(f.calls.fonts.length, 2);
  assert.match(f.calls.fonts[1], /^"Zylos Observer Symbols",/);
  assert.equal(f.channel.messages.filter(m => m.type === 'metrics').length, 2);
});

test('font rejection falls back and late channel gets ready', async () => {
  const f = frame(); f.rejectFont(new Error('font unavailable')); await flush();
  assert.equal(f.calls.open, 1); f.initialize(); f.paint();
  assert.equal(f.channel.messages[0].type, 'ready');
});

test('shutdown before font completion prevents reopen, ready or metrics', async () => {
  const f = frame(); f.initialize(); f.send({ type: 'shutdown' });
  f.resolveFont([]); await flush(); f.timeout(); f.paint(); f.initialize();
  assert.equal(f.calls.open, 0); assert.equal(f.calls.dispose, 1);
  assert.equal(f.channel.closes, 1); assert.equal(f.channel.starts, 1);
  assert.deepEqual(f.channel.messages, []);
});

test('shutdown cancels scheduled metrics and late font callbacks', async () => {
  const f = frame(); f.initialize(); await flush(); f.timeout(); await flush();
  f.send({ type: 'shutdown' }); f.resolveFont([]); await flush(); f.paint();
  assert.deepEqual(f.channel.messages, [{ type: 'ready' }]);
  assert.equal(f.calls.fonts.length, 0);
});

test('font is pinned and embedded with data-only CSP and requested Unicode coverage', () => {
  const html = observerFrameDocument();
  assert.match(html, /font-src data:/);
  assert.match(html, /@font-face\{font-family:"Zylos Observer Symbols";src:url\(data:font\/woff2;base64,/);
  assert.match(html, /unicode-range:U\+2190-21FF,U\+2300-23FF/);
  assert.match(OBSERVER_FRAME_ASSETS.symbolsSha256, /^[a-f0-9]{64}$/);
  // Comments/license text in xterm contain URLs; no HTML resource or CSS URL may fetch one.
  assert.doesNotMatch(html, /(?:src|href)\s*=\s*["']https?:|url\(\s*["']?https?:/i);
});

test('tampered font fails pinned verification without modifying disk', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    const read = fs.readFileSync;
    fs.readFileSync = function(file, ...args) {
      if(String(file).endsWith('/observer-symbols.woff2')) return Buffer.from('tampered');
      return read.call(this, file, ...args);
    };
    const { observerFrameDocument } = await import('./src/lib/observer-frame.js');
    observerFrameDocument();
  `], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Observer renderer asset digest mismatch: observer-symbols.woff2/);
});

test('installation and upgrade hooks do not build fonts or require Python', () => {
  const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.doesNotMatch(JSON.stringify(packageJson.scripts), /python|build-observer-symbols|verify-observer-symbols/i);
  for (const entry of fs.readdirSync(new URL('../hooks/', import.meta.url))) {
    if (!/\.(?:js|cjs|sh)$/.test(entry)) continue;
    const hook = fs.readFileSync(new URL('../hooks/' + entry, import.meta.url), 'utf8');
    assert.doesNotMatch(hook, /python|build-observer-symbols|verify-observer-symbols/i, entry);
  }
});

test('missing committed font fails immediately without runtime generation', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    import childProcess from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    for (const name of ['exec', 'execFile', 'spawn', 'execSync', 'execFileSync', 'spawnSync']) {
      childProcess[name] = () => { throw new Error('Unexpected runtime font generation'); };
    }
    syncBuiltinESMExports();
    const read = fs.readFileSync;
    fs.readFileSync = function(file, ...args) {
      if(String(file).endsWith('/observer-symbols.woff2')) throw Object.assign(new Error('Missing committed observer font'), {code:'ENOENT'});
      return read.call(this, file, ...args);
    };
    const { observerFrameDocument } = await import('./src/lib/observer-frame.js');
    observerFrameDocument();
  `], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Missing committed observer font/);
  assert.doesNotMatch(result.stderr, /Unexpected runtime font generation/);
});
