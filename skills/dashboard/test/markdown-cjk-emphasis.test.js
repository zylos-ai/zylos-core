import test from 'node:test';
import assert from 'node:assert/strict';
import '../public/js/markdown-it.min.js';
import { cjkEmphasis } from '../public/js/markdown-cjk-emphasis.js';
import { createMarkdownRenderer } from '../public/js/markdown-config.js';
import { markdownPreview } from '../src/lib/chat/markdown-preview.js';

// Pure parser/rendering tests: no services, databases, files or network are opened.
const stock = () => {
  const md = globalThis.markdownit({ html: false, linkify: true });
  md.linkify.set({ fuzzyLink: false });
  return md;
};
const extended = () => stock().use(cjkEmphasis);
const markers = [['*', 'em'], ['**', 'strong'], ['_', 'em'], ['__', 'strong']];
const punctuation = [
  '（', '）', '。', '，', '：', '“', '”', '‘', '’',
  '、', '！', '？', '；', '《', '》', '「', '」', '『', '』', '【', '】',
  '……', '—', '〈', '〉', '〔', '〕', '〝', '〞', '｡', '､', '｢', '｣', '＂', '＇',
];

for (const punctuationText of punctuation) {
  test(`Chinese punctuation ${punctuationText} supports emphasis beside Han text`, () => {
    const md = extended();
    for (const [marker, tag] of markers) {
      const cases = [
        [`${marker}内容${punctuationText}${marker}后文`, `<${tag}>内容${punctuationText}</${tag}>后文`, `内容${punctuationText}后文`],
        [`前文${marker}${punctuationText}内容${marker}`, `前文<${tag}>${punctuationText}内容</${tag}>`, `前文${punctuationText}内容`],
        [`前文${marker}${punctuationText}内容${punctuationText}${marker}后文`, `前文<${tag}>${punctuationText}内容${punctuationText}</${tag}>后文`, `前文${punctuationText}内容${punctuationText}后文`],
      ];
      for (const [source, html, preview] of cases) {
        assert.equal(md.renderInline(source), html, source);
        assert.equal(markdownPreview(source), preview, source);
      }
    }
  });
}

test('supplementary Han code points support both emphasis boundaries', () => {
  for (const [marker, tag] of markers) {
    assert.equal(extended().renderInline(`𠀀${marker}（内容）${marker}𠀁`), `𠀀<${tag}>（内容）</${tag}>𠀁`);
  }
});

test('nested emphasis and link labels retain the parser pairing rules', () => {
  for (const [outer, inner] of [['**', '*'], ['__', '_']]) {
    const source = `前文${outer}（外层 ${inner}（内层）${inner}接文）${outer}后文`;
    assert.equal(extended().renderInline(source), '前文<strong>（外层 <em>（内层）</em>接文）</strong>后文');
    assert.equal(markdownPreview(source), '前文（外层 （内层）接文）后文');
  }
  for (const [marker, tag] of markers) {
    const source = `[前文${marker}（标签）${marker}后文](https://example.com/a_**b** "标题 **（原样）**后文")`;
    assert.equal(extended().renderInline(source), `<a href="https://example.com/a_**b**" title="标题 **（原样）**后文">前文<${tag}>（标签）</${tag}>后文</a>`);
    assert.equal(markdownPreview(source), '前文（标签）后文');
  }
  assert.equal(extended().renderInline('前文***（三重）***后文'), '前文<em><strong>（三重）</strong></em>后文');
});

test('English numeric ordinary Markdown and excluded symbols match the stock parser', () => {
  const samples = [
    '**bold** *italic* __bold__ _italic_', 'before**(bold)**after', '**word.**after',
    'before__(word)__after', 'foo_bar_baz', '2**3**4', '2*3*4', '2__3__4',
    '前文__内容。__后文', '中文**普通粗体**后文', '中文*普通斜体*后文',
    '前文**　内容　**后文', '前文**〇内容〇**后文', '前文**〆内容〆**后文',
    '前文**Ａ内容Ａ**后文', '前文**９内容９**后文', '前文**＋内容＋**后文',
    '前文**😀内容😀**后文', '前文**α内容α**后文', '**内容。**Latin', '**内容。**123',
    'Latin**（内容**', '123**（内容**', '前文**（未闭合', '内容。**后文',
    '**outer *inner* outer**', '[English **bold**](https://example.com "Title")',
    '> quote\n\n- **item**\n\n# Heading', '| A | B |\n|---|---|\n| *a* | **b** |',
    '[x](javascript:alert(1))', '<script>alert(1)</script>', 'notes.md www.example.com',
  ];
  const original = stock();
  const md = extended();
  for (const source of samples) assert.equal(md.render(source), original.render(source), source);
});

test('code escapes entities and link destinations keep their stock behavior', () => {
  const samples = [
    '`**（内容）**后文`', '```md\n**（内容）**后文\n```', '    **（内容）**后文',
    '\\*\\*（内容）\\*\\*后文', '\\_\\_（内容）\\_\\_后文', '**内容\\)**后文',
    '**内容&#x3002;**后文', '前文**&#xFF08;内容**', '**内容&rdquo;**后文',
    '[label](https://example.com/**（内容）**后文 "**（title）**后文")',
    '<https://example.com/**（内容）**后文>', 'https://example.com/**（内容）**后文',
    '`。`**后文', '前文**`（`内容**',
  ];
  const original = stock();
  const md = extended();
  for (const source of samples) assert.equal(md.render(source), original.render(source), source);
});

test('the application renderer and server preview share CJK emphasis without changing safety options', () => {
  const md = createMarkdownRenderer(globalThis.markdownit);
  const source = '前文**（粗体）**后文与*“斜体”*后文';
  assert.equal(md.render(source), '<p>前文<strong>（粗体）</strong>后文与<em>“斜体”</em>后文</p>\n');
  assert.equal(markdownPreview(source), '前文（粗体）后文与“斜体”后文');
  assert.doesNotMatch(md.render('<script>alert(1)</script> [x](javascript:alert(1))'), /<script>|href="javascript:/);
  assert.doesNotMatch(md.render('identity.md www.example.com'), /<a /);
  assert.match(md.render('[**（链接）**后文](https://example.com "**（标题）**后文")'), /<a href="https:\/\/example.com" title="\*\*（标题）\*\*后文" target="_blank" rel="noopener noreferrer"><strong>（链接）<\/strong>后文<\/a>/);
});
