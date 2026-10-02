/**
 * 真实站点冒烟测试：只有设了 `DSH_CK3WIKI_LIVE=1` 才跑，避免默认测试联网。
 *
 *     $env:DSH_CK3WIKI_LIVE=1; node --test test/live.test.js
 *
 * 这一组用例同时是「User-Agent 反爬规则」的回归测试：默认 UA 必须能拿到 JSON。
 * 如果这里开始失败，先看 ck3wiki_status 的报错——它会把挑战页判定讲清楚。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { apply } from '../lib/index.js';
import { pageUrl } from '../lib/mediawiki.js';

const BASE = 'https://ck3.paradoxwikis.com';

const LIVE = process.env.DSH_CK3WIKI_LIVE === '1';

/** 造一个最小上下文（同 plugin.test.js）。 */
function makeCtx() {
  const tools = new Map();
  return {
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    get() {
      return undefined;
    },
    logger: { info() {}, warn() {} },
    registry: tools,
  };
}

/** 装配插件（真实 fetch），返回工具表。 */
async function boot() {
  const ctx = makeCtx();
  await apply(ctx, { requestTimeoutMs: 30_000, cacheTtlMs: 0 });
  return ctx.registry;
}

/**
 * 调用工具并返回文本。
 * @param {Map<string, any>} tools - 注册表。
 * @param {string} toolName - 工具名。
 * @param {object} [args] - 参数。
 * @returns {Promise<string>} 文本。
 */
async function call(tools, toolName, args = {}) {
  const definition = tools.get(toolName);
  assert.ok(definition, `工具 ${toolName} 没有注册`);
  const value = await definition.execute(args, { signal: AbortSignal.timeout(60_000) });
  return String(value.text);
}

test('live：视频装饰被清掉，但图注保留（Modding）', { skip: !LIVE }, async () => {
  const tools = await boot();
  const text = await call(tools, 'ck3wiki_page', { title: 'Modding' });
  assert.ok(!text.includes('Load video'), `装饰层该被丢掉：\n${text.slice(0, 400)}`);
  assert.ok(!text.includes('might collect personal data'), text.slice(0, 400));
  assert.ok(text.includes('Mr Samuel Streamer'), '图注（视频标题）必须保留');
});

test('live：多视频页也不再有装饰（Downloadable content）', { skip: !LIVE }, async () => {
  const tools = await boot();
  const text = await call(tools, 'ck3wiki_page', { title: 'Downloadable content' });
  assert.ok(!text.includes('might collect personal data'), text.slice(0, 400));
  assert.ok(!text.includes('Load video'), text.slice(0, 400));
  assert.ok(text.length > 1000, text.slice(0, 200));
});

test('live：子页标题的 URL 与站点 fullurl 一致', { skip: !LIVE }, async () => {
  const tools = await boot();
  const title = 'Template:0/doc';
  const expected = pageUrl(BASE, title);

  const info = await call(tools, 'ck3wiki_page_info', { title });
  const urlLine = info.split('\n').find((line) => line.startsWith('URL：'));
  assert.ok(urlLine, `page_info 应给出 URL 行：\n${info}`);
  assert.equal(urlLine.slice('URL：'.length).trim(), expected, 'page_info 的 URL 行应与我们拼的一致');

  const page = await call(tools, 'ck3wiki_page', { title, maxChars: 300 });
  const sourceLine = page.split('\n').find((line) => line.startsWith('来源：'));
  assert.ok(sourceLine, `页面应给出来源行：\n${page}`);
  assert.ok(sourceLine.includes(expected), `来源行应含规范 URL：${sourceLine}`);
});

test('live：ck3wiki_status 能连通并报出站点信息', { skip: !LIVE }, async () => {
  const tools = await boot();
  const text = await call(tools, 'ck3wiki_status', { fresh: true });
  assert.ok(text.includes('CK3 Wiki 连通正常'), text);
  assert.ok(text.includes('MediaWiki'));
  assert.ok(text.includes('页面 '));
  // 默认 UA 必须带联系地址，否则会被 Fastly 挑战页拦下。
  assert.ok(text.includes('dsh-ck3wiki/') && text.includes('http'));
});

test('live：ck3wiki_search 能检索到内容', { skip: !LIVE }, async () => {
  const tools = await boot();
  const text = await call(tools, 'ck3wiki_search', { query: 'de jure casus belli', limit: 3 });
  assert.ok(/共 \d+ 条命中/.test(text), text);
  assert.ok(text.includes('Titles') || text.includes('Innovation'), text);
});

test('live：ck3wiki_search 支持 CirrusSearch 语法', { skip: !LIVE }, async () => {
  const tools = await boot();
  const text = await call(tools, 'ck3wiki_search', { query: 'incategory:Modding trait', limit: 3 });
  assert.ok(/共 \d+ 条命中/.test(text) || text.includes('没有命中'), text);
});

test('live：ck3wiki_titles 给标题候选', { skip: !LIVE }, async () => {
  const tools = await boot();
  const text = await call(tools, 'ck3wiki_titles', { query: 'casus', limit: 5 });
  assert.ok(/casus belli/i.test(text), text);
  assert.ok(text.includes('ck3.paradoxwikis.com'));
});

test('live：ck3wiki_sections + ck3wiki_page 能分节读页面', { skip: !LIVE }, async () => {
  const tools = await boot();
  const sections = await call(tools, 'ck3wiki_sections', { title: 'Titles', fresh: true });
  assert.ok(sections.includes('section='), sections);

  const page = await call(tools, 'ck3wiki_page', { title: 'Casus belli', section: 0, fresh: true });
  assert.ok(page.includes('# Casus belli'), page);
  assert.ok(page.length > 200, '引言应有实际内容');
});

test('live：ck3wiki_page 的 wikitext 模式可用', { skip: !LIVE }, async () => {
  const tools = await boot();
  const text = await call(tools, 'ck3wiki_page', { title: 'Casus belli', format: 'wikitext', fresh: true });
  assert.ok(text.includes('wikitext 源码'), text);
  assert.ok(text.includes('```wikitext'));
});

test('live：页面不存在时给候选而不是报错', { skip: !LIVE }, async () => {
  const tools = await boot();
  const text = await call(tools, 'ck3wiki_page', { title: 'Casus beli typo xyzzy', fresh: true });
  assert.ok(text.includes('不存在'), text);
});

test('live：ck3wiki_page_info 读到元数据', { skip: !LIVE }, async () => {
  const tools = await boot();
  const text = await call(tools, 'ck3wiki_page_info', { title: 'Titles', fresh: true });
  assert.ok(text.includes('pageid '), text);
  assert.ok(text.includes('字节数 '));
});

test('live：ck3wiki_links 出链与反链', { skip: !LIVE }, async () => {
  const tools = await boot();
  const out = await call(tools, 'ck3wiki_links', { title: 'Casus belli', limit: 10 });
  assert.ok(out.includes('的出链') || out.includes('没有指向别处'), out);
  const back = await call(tools, 'ck3wiki_links', { title: 'Casus belli', direction: 'in', limit: 10 });
  assert.ok(back.includes('链接到') || back.includes('没有页面链接到'), back);
});

test('live：ck3wiki_category 列分类成员', { skip: !LIVE }, async () => {
  const tools = await boot();
  const text = await call(tools, 'ck3wiki_category', { category: 'Modding', limit: 10 });
  assert.ok(text.includes('Category:Modding'), text);
});

test('live：ck3wiki_recent_changes 读到改动', { skip: !LIVE }, async () => {
  const tools = await boot();
  const text = await call(tools, 'ck3wiki_recent_changes', { limit: 5, days: 30 });
  assert.ok(/最近 30 天的改动|没有符合条件的改动/.test(text), text);
});
