/**
 * 归约器的单元测试（离线）：实体解码、标签剥离、噪声块删除、结构保留与截断。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_NOISE_PATTERNS, cleanSnippet, decodeEntities, dropNoiseLines, extractParserOutput, removeElements, stripRawTextBlocks, stripTags, toText, truncateText } from '../lib/html-text.js';
import { PAGE_TEXT } from './fixtures/fixtures.js';

test('decodeEntities 处理命名、十进制与十六进制实体', () => {
  assert.equal(decodeEntities('a &amp; b'), 'a & b');
  assert.equal(decodeEntities('it&#39;s'), "it's");
  assert.equal(decodeEntities('&#x2014;'), '—');
  assert.equal(decodeEntities('&nbsp;'), ' ');
  assert.equal(decodeEntities('&lt;tag&gt;'), '<tag>');
  assert.equal(decodeEntities('&unknownent;'), '&unknownent;');
  assert.equal(decodeEntities('&#0;'), '&#0;');
});

test('stripTags 去标签、解实体、压空白', () => {
  assert.equal(stripTags('Seize <span class="searchmatch">De</span>  Jure\n\ntitles'), 'Seize De Jure titles');
  assert.equal(stripTags('a &amp; b'), 'a & b');
});

test('stripTags 删掉 script/style 的内容与注释', () => {
  // 删块时用空格替换（不是空串）：英文片段里 'a<script>…</script>b' 不能粘成 'ab'。
  const out = stripTags('前<script>(window.RLQ = window.RLQ || []).push([[&quot;jquery&quot;]])</script>后');
  assert.ok(!out.includes('RLQ'), `脚本体必须删掉：${out}`);
  assert.ok(!out.includes('jquery'), out);
  assert.ok(out.includes('前') && out.includes('后'), out);
  assert.equal(stripTags('<style>.a{color:red}</style>正文'), '正文');
  assert.equal(stripTags('<!-- 注释 -->正文'), '正文');
  assert.equal(stripTags('a<script>x</script>b'), 'a b', '英文不能粘词');
});

test('stripRawTextBlocks 摘掉原始文本元素的内容', () => {
  const out = stripRawTextBlocks('<p>前</p><script>var a = 1;</script><style>.a{color:red}</style><p>后</p>');
  assert.ok(!out.includes('var a = 1'), out);
  assert.ok(!out.includes('color:red'), out);
  assert.ok(out.includes('<p>前</p>') && out.includes('<p>后</p>'), out);
});

test('回归：脚本里含 HTML 字符串时不吞正文（PRTS 实测同源缺陷：一次吃掉 92.9%）', () => {
  const html = '<div class="mw-parser-output">'
    + '<script>var tpl = \'<div>\' + \'</div>\' + \'<span class="y">\';</script>'
    + '<h2>Uses</h2><p>A casus belli is a justification for war.</p></div>';
  const { text } = toText(html, { maxChars: 20_000 });
  assert.ok(text.includes('## Uses'), `脚本不该吞掉正文：${text}`);
  assert.ok(text.includes('casus belli'), text);
  assert.ok(!text.includes('var tpl'), text);
});

test('回归：样式里含 </div> 字符串时同样不吞正文', () => {
  const html = '<div class="mw-parser-output"><style>.x::after{content:"</div>"}</style>'
    + '<h2>Costs</h2><p>100 gold</p></div>';
  const { text } = toText(html, { maxChars: 20_000 });
  assert.ok(text.includes('## Costs'), text);
  assert.ok(text.includes('100 gold'), text);
});

test('dropClasses 是替换语义，extraDropClasses 是追加语义', () => {
  const html = '<div class="mw-parser-output"><div class="navbox">导航</div><div class="mine">自定义</div><p>正文</p></div>';

  const byDefault = toText(html, { maxChars: 20_000 });
  assert.ok(!byDefault.text.includes('导航'), byDefault.text);
  assert.ok(byDefault.text.includes('自定义'), '默认表里没有 mine，应当保留');

  const replaced = toText(html, { maxChars: 20_000, dropClasses: ['mine'] });
  assert.ok(!replaced.text.includes('自定义'), replaced.text);
  assert.ok(replaced.text.includes('导航'), '替换语义下默认项不再生效');

  const extended = toText(html, { maxChars: 20_000, extraDropClasses: ['mine'] });
  assert.ok(!extended.text.includes('自定义'), extended.text);
  assert.ok(!extended.text.includes('导航'), '追加语义下默认项仍然生效');

  const off = toText(html, { maxChars: 20_000, dropClasses: [] });
  assert.ok(off.text.includes('导航') && off.text.includes('自定义'), '空表 = 不做 class 过滤');
});

test('class 表的容错：类型写错回退默认，非法项自然不命中', () => {
  const html = '<div class="mw-parser-output"><div class="navbox">导航</div><p>正文</p></div>';
  const fallback = toText(html, { maxChars: 20_000, dropClasses: 'navbox' });
  assert.ok(!fallback.text.includes('导航'), '类型写错应回退默认表');

  const mixed = toText(html, { maxChars: 20_000, dropClasses: ['', 42, 'navbox'] });
  assert.ok(!mixed.text.includes('导航'), '合法项照常生效');

  const junkOnly = toText(html, { maxChars: 20_000, dropClasses: ['', 42] });
  assert.ok(junkOnly.text.includes('导航'), '全是非法项时等于空表（不会误伤）');
});

test('视频嵌入：只丢装饰层，图注必须保留', () => {
  const { text } = toText(PAGE_TEXT.parse.text, { maxChars: 20_000 });
  assert.ok(!text.includes('Load video'), `装饰层该被丢掉：\n${text.slice(0, 400)}`);
  assert.ok(!text.includes('might collect personal data'), text.slice(0, 400));
  assert.ok(!text.includes('Privacy Policy'), text.slice(0, 400));
  assert.ok(text.includes('CK3 Modding #1'), 'figcaption 是真正的视频标题，不能被丢');
});

test('dropNoiseLines：锚定整行、空数组关闭、非法正则忽略', () => {
  const text = ['YouTube', 'YouTube 是视频站', 'Load video', '正片开始'].join('\n');
  const dropped = dropNoiseLines(text, DEFAULT_NOISE_PATTERNS);
  assert.ok(!dropped.split('\n').includes('YouTube'), dropped);
  assert.ok(dropped.includes('YouTube 是视频站'), '锚定整行，不该误伤「包含」的情况');
  assert.ok(!dropped.includes('Load video'), dropped);
  assert.ok(dropped.includes('正片开始'), dropped);

  assert.equal(dropNoiseLines(text, []), text, '空数组 = 关闭行级过滤');
  assert.equal(dropNoiseLines('YouTube', ['([', '^YouTube$']), '', '非法项忽略，合法项照常生效');
});

test('toText：裸行噪声被丢掉，且不留下连续空行', () => {
  const html = '<div class="mw-parser-output"><h2>Uses</h2><p>YouTube</p><p>正文</p><h2>Costs</h2><p>100</p></div>';
  const { text: filtered } = toText(html, { maxChars: 20_000 });
  assert.ok(!filtered.split('\n').includes('YouTube'), `裸行应被丢掉：\n${filtered}`);
  assert.ok(filtered.includes('正文') && filtered.includes('## Uses') && filtered.includes('## Costs'), filtered);
  assert.ok(!/\n{3,}/.test(filtered), `丢行后不该留下连续空行：\n${filtered}`);

  const { text: unfiltered } = toText(html, { maxChars: 20_000, noisePatterns: [] });
  assert.ok(unfiltered.split('\n').includes('YouTube'), '关掉行级过滤后裸行仍在');
});

test('锚定整行的行级噪声不会误伤同名标题', () => {
  const html = '<div class="mw-parser-output"><h2>YouTube</h2><p>正文</p></div>';
  const { text } = toText(html, { maxChars: 20_000 });
  assert.ok(text.includes('## YouTube'), `标题是「## YouTube」，不该被 ^YouTube$ 命中：\n${text}`);
  assert.ok(text.includes('正文'), text);
});

test('cleanSnippet 整句丢掉站点样板（cookie 提示 / 版本横幅）', () => {
  const cookie = 'collect personal data. Privacy Policy ContinueDismiss CK3 Modding #1 -Brief introduction to modding.';
  const cleaned = cleanSnippet(cookie);
  for (const noise of ['collect personal data', 'Privacy Policy', 'ContinueDismiss']) {
    assert.ok(!cleaned.includes(noise), `「${noise}」应被丢掉：${cleaned}`);
  }

  const banner = 'Please help with verifying or updating older sections of this article. A Duchy is a title, granted by a liege.';
  assert.equal(cleanSnippet(banner), 'A Duchy is a title, granted by a liege.');
});

test('cleanSnippet 只按词删行内噪声，句子其余部分照旧', () => {
  const raw = 'having the Error creating thumbnail: File missing Inbred trait, traits that are considered virtues.';
  const out = cleanSnippet(raw);
  assert.ok(!out.includes('Error creating thumbnail'), out);
  assert.ok(out.includes('having the Inbred trait, traits that are considered virtues.'), out);

  // 片段有长度上限，报错文字会被截成 `Error creating`（实测），短词表得兜住它。
  assert.equal(cleanSnippet('1.6 • 1.6.1 • 1.6.1.2 Error creating'), '1.6 • 1.6.1 • 1.6.1.2');

  // 页脚导航整串删掉，别把前面的正文一起带走。
  const footer = 'Way of Kings Modding Meta Modding • Patches • Downloadable content • Developer diaries • Achievements • Jargon';
  assert.equal(cleanSnippet(footer), 'Way of Kings Modding');
});

test('cleanSnippet 不会把 URL 里的点当句号切碎', () => {
  const raw = 'analyzing_how_to_get_hunter_traits/ https://www.reddit.com/r/CrusaderKings/comments/vtfw26/analyzing_how_to_get_reveler_traits/ Mechanics';
  assert.equal(cleanSnippet(raw), raw);
});

test('cleanSnippet 词表可覆盖，空输入安全', () => {
  assert.equal(cleanSnippet('keep me', { sentences: [], phrases: [] }), 'keep me');
  assert.equal(cleanSnippet('', {}), '');
  assert.equal(cleanSnippet(undefined, {}), '');
});

test('extractParserOutput 只取正文容器', () => {
  const html = '<body><div class="mw-parser-output"><p>inside</p></div><footer>outside</footer></body>';
  assert.equal(extractParserOutput(html).trim(), '<p>inside</p>');
  assert.equal(extractParserOutput('<p>no wrapper</p>').trim(), '<p>no wrapper</p>');
});

test('extractParserOutput 正确处理嵌套 div', () => {
  const html = '<div class="mw-parser-output"><div class="inner"><p>x</p></div></div><p>tail</p>';
  assert.equal(extractParserOutput(html), '<div class="inner"><p>x</p></div>');
});

test('removeElements 连子树一起删，并保留自闭合标签', () => {
  const html = '<p>keep<br>me</p><div class="navbox"><p>drop<i>nested</i></p></div><p>after</p>';
  const cleaned = removeElements(html, (_tag, attrs) => attrs.includes('navbox'));
  assert.ok(cleaned.includes('keep<br>me'));
  assert.ok(cleaned.includes('after'));
  assert.ok(!cleaned.includes('drop'));
  assert.ok(!cleaned.includes('nested'));
});

test('toText 保留结构、丢掉导航噪声', () => {
  const { text } = toText(PAGE_TEXT.parse.text, { maxChars: 20_000 });

  // 保留：标题、粗体、列表、嵌套有序列表、表格
  assert.ok(text.includes('## Uses'), '标题应降级成 ##');
  assert.ok(text.includes('A **casus belli** is a justification for war & can be gained in several ways.'), '粗体与实体应被保留');
  assert.ok(text.includes('- Declare war'), '无序列表应有 - 前缀');
  assert.ok(text.includes(' 1. County') || text.includes('1. County'), '嵌套有序列表应带序号');
  assert.ok(text.includes('【表】Costs'), '表格标题应保留');
  assert.ok(text.includes('| Duchy | 100 |'), '表格应降成竖线行');
  assert.ok(text.includes('*titles*'), '斜体应保留');
  assert.ok(text.includes('`de_jure`'), '等宽应保留');

  // 丢弃：版本横幅、编辑链接、脚注角标、导航盒
  assert.ok(!text.includes('has been verified'), '版本横幅（metadata）应被丢掉');
  assert.ok(!text.includes('action=edit'), '编辑链接应被丢掉');
  assert.ok(!text.includes('[1]'), '脚注角标应被丢掉');
  assert.ok(!text.includes('Mechanics'), '导航盒应被丢掉');

  // 空白展平：没有三个以上连续换行
  assert.ok(!/\n{3,}/.test(text), '空白应被展平');
});

test('toText 对空/无正文输入返回空文本而不是抛错', () => {
  assert.equal(toText('').text, '');
  assert.equal(toText('<div class="mw-parser-output"></div>').text, '');
});

test('truncateText 在行边界截断并附提示', () => {
  const long = Array.from({ length: 200 }, (_v, index) => `line ${index} ${'x'.repeat(40)}`).join('\n');
  const result = truncateText(long, 500);
  assert.equal(result.truncated, true);
  assert.equal(result.totalChars, long.length);
  assert.ok(result.text.length < 900);
  assert.ok(result.text.includes('已截断'));
  assert.ok(result.text.includes('ck3wiki_sections'));
  assert.ok(!result.text.includes('line 199'), '超出的部分不应出现');

  const short = truncateText('hello', 500);
  assert.equal(short.truncated, false);
  assert.equal(short.text, 'hello');
});
