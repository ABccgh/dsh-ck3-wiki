/**
 * 归约器的单元测试（离线）：实体解码、标签剥离、噪声块删除、结构保留与截断。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { decodeEntities, extractParserOutput, removeElements, stripTags, toText, truncateText } from '../lib/html-text.js';
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
