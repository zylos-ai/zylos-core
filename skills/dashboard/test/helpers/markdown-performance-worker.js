import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

const seeds = {
  'continuous-stars': '*',
  'alternating-openers': '**（',
  'unmatched-punctuation': '（「【《“‘……—！？；、',
};
const [pattern, byteCount] = process.argv.slice(2);
const bytes = Number(byteCount);
assert.ok(Object.hasOwn(seeds, pattern));
assert.ok([524288, 1048576, 2097152].includes(bytes));

function send(message) {
  return new Promise((resolve, reject) => process.send(message, error => error ? reject(error) : resolve()));
}

await send({ type: 'ready', isolation: Object.fromEntries(
  ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR'].map(key => [key, process.env[key]])),
  cwd: process.cwd(), execArgv: process.execArgv });

process.once('message', async message => {
  try {
    assert.equal(message, 'render');
    // Native imports exercise the shipped parser and the real Memory renderer,
    // including its CJK plugin, linkification and safe-link configuration.
    await import('../../public/js/markdown-it.min.js');
    const { createMarkdownRenderer } = await import('../../public/js/markdown-config.js');
    const md = createMarkdownRenderer(globalThis.markdownit);
    assert.ok(md);
    assert.equal(typeof globalThis.gc, 'function');
    md.render('前文**（热身）**后文');

    const seed = seeds[pattern];
    const remaining = bytes - Buffer.byteLength('文后');
    const copies = Math.floor(remaining / Buffer.byteLength(seed));
    // The surrounding Han characters keep continuous stars inside a paragraph
    // instead of letting the block parser recognize a thematic break.
    const source = '文' + seed.repeat(copies) + 'a'.repeat(remaining - copies * Buffer.byteLength(seed)) + '后';
    assert.equal(Buffer.byteLength(source), bytes);
    const samplesMs = [];
    let outputCharacters = 0;
    for (let sample = 0; sample < 3; sample++) {
      globalThis.gc();
      await send({ type: 'sample-start', sample });
      const started = performance.now();
      let html = md.render(source);
      const elapsedMs = performance.now() - started;
      outputCharacters = html.length;
      html = null;
      assert.ok(outputCharacters > 0, 'the real renderer must return HTML');
      samplesMs.push(elapsedMs);
      await send({ type: 'sample-done', sample, elapsedMs });
    }
    await send({ type: 'result', pattern, bytes, samplesMs, outputCharacters });
    process.disconnect();
  } catch (error) {
    await send({ type: 'failure', message: String(error.message).slice(0, 500) });
    process.exitCode = 1;
    process.disconnect();
  }
});
