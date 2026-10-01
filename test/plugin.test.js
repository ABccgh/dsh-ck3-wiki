/**
 * 插件级测试（离线）：模块契约、配置归一、9 个工具的注册与执行路径、缓存与错误分支。
 *
 * 出网用注入的 `fetchImpl` 顶替（`apply(ctx, config, { fetchImpl })`），所以这些用例
 * 完全不联网；真实站点的冒烟测试在 live.test.js，用 `DSH_CK3WIKI_LIVE=1` 打开。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import * as plugin from '../lib/index.js';
import { CHALLENGE_HTML, PAGE_INFO_MISSING, PARSE_MISSING, SITEINFO } from './fixtures/fixtures.js';
import * as fixtures from './fixtures/fixtures.js';

const { apply, name, normalizeConfig } = plugin;

const EXPECTED_TOOLS = [
  'ck3wiki_category',
  'ck3wiki_links',
  'ck3wiki_page',
  'ck3wiki_page_info',
  'ck3wiki_recent_changes',
  'ck3wiki_search',
  'ck3wiki_sections',
  'ck3wiki_status',
  'ck3wiki_titles',
];

/** 造一个最小的 Cordis 上下文：只需要 `tools.register`、`get` 与 `logger`。 */
function makeCtx() {
  const tools = new Map();
  const ctx = {
    tools: {
      register(definition) {
        if (tools.has(definition.name)) throw new Error(`重复注册工具 ${definition.name}`);
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    get() {
      return undefined;
    },
    logger: { info() {}, warn() {} },
  };
  return { ctx, tools };
}

/** 按 URL 决定返回哪个 fixture。 */
function routeFor(rawUrl) {
  const params = new URL(rawUrl).searchParams;
  if (params.get('meta') === 'siteinfo') return 'SITEINFO';
  if (params.get('action') === 'opensearch') return 'OPENSEARCH';
  if (params.get('list') === 'search') return 'SEARCH';
  if (params.get('action') === 'parse' && String(params.get('prop')).includes('sections')) return 'SECTIONS';
  if (params.get('action') === 'parse') return 'PAGE_TEXT';
  if (String(params.get('prop')).includes('revisions')) return 'WIKITEXT';
  if (String(params.get('prop')).includes('info')) return 'PAGE_INFO';
  if (params.get('prop') === 'links') return 'LINKS';
  if (params.get('list') === 'backlinks') return 'BACKLINKS';
  if (params.get('list') === 'categorymembers') return 'CATEGORY_MEMBERS';
  if (params.get('list') === 'recentchanges') return 'RECENT_CHANGES';
  return 'SITEINFO';
}

/**
 * 造一个假 fetch 与调用记录。
 * @param {Record<string, Function>} [overrides] - 按路由名覆盖返回（返回 Response）。
 */
function makeFetch(overrides = {}) {
  const calls = [];
  const fetchImpl = async (rawUrl) => {
    const url = String(rawUrl);
    calls.push(url);
    const route = routeFor(url);
    if (typeof overrides[route] === 'function') return overrides[route](url);
    return jsonResponse(fixtures[route] ?? SITEINFO);
  };
  return { fetchImpl, calls };
}

/** JSON 响应。 */
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

/** 反爬挑战页响应（HTTP 200 + text/html）。 */
function challengeResponse() {
  return new Response(CHALLENGE_HTML, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

/**
 * 装配插件并返回工具表。
 * @param {Record<string, any>} [config] - 覆盖配置。
 * @param {Record<string, Function>} [overrides] - 路由覆盖。
 * @returns {Promise<{ tools: Map<string, any>, calls: string[] }>} 工具与调用记录。
 */
async function boot(config = {}, overrides = {}) {
  const { ctx, tools } = makeCtx();
  const { fetchImpl, calls } = makeFetch(overrides);
  await apply(ctx, config, { fetchImpl });
  return { tools, calls };
}

/** 调用一个已注册的工具。 */
function call(tools, toolName, args = {}) {
  const definition = tools.get(toolName);
  assert.ok(definition, `工具 ${toolName} 没有注册`);
  return definition.execute(args, { signal: AbortSignal.timeout(10_000) });
}

test('插件导出 name / inject / apply / normalizeConfig，且不导出 Config', () => {
  assert.equal(name, 'ck3wiki');
  assert.deepEqual(plugin.inject, ['tools']);
  assert.equal(typeof apply, 'function');
  assert.equal(typeof normalizeConfig, 'function');
  assert.equal('Config' in plugin, false, '没有 Config 时 cordis 会原样透传配置对象');
});

test('normalizeConfig 给出默认值并夹紧非法值', () => {
  const defaults = normalizeConfig({});
  assert.equal(defaults.wikiBaseUrl, 'https://ck3.paradoxwikis.com');
  assert.equal(defaults.apiPath, '/api.php');
  assert.equal(defaults.requestTimeoutMs, 15_000);
  assert.equal(defaults.maxChars, 20_000);
  assert.equal(defaults.maxListedItems, 100);
  assert.equal(defaults.cacheTtlMs, 60_000);
  assert.equal(defaults.trustSystemCa, 'auto');
  assert.equal(defaults.webFallback, true);
  assert.ok(defaults.userAgent.startsWith('dsh-ck3wiki/'));
  assert.ok(defaults.userAgent.includes('http'), 'UA 必须带联系地址，否则会被反爬挑战页拦下');

  const custom = normalizeConfig({
    wikiBaseUrl: 'https://eu4.paradoxwikis.com/',
    apiPath: 'w/api.php',
    requestTimeoutMs: -1,
    maxChars: 0,
    cacheTtlMs: 0,
    trustSystemCa: 'weird',
    webFallback: false,
  });
  assert.equal(custom.wikiBaseUrl, 'https://eu4.paradoxwikis.com');
  assert.equal(custom.apiPath, '/w/api.php');
  assert.equal(custom.requestTimeoutMs, 15_000, '非法超时应回退默认值');
  assert.equal(custom.maxChars, 20_000, '非法 maxChars 应回退默认值');
  assert.equal(custom.cacheTtlMs, 0, '0 是合法的（关闭缓存）');
  assert.equal(custom.trustSystemCa, 'auto');
  assert.equal(custom.webFallback, false);

  assert.equal(normalizeConfig({ wikiBaseUrl: 'not-a-url' }).wikiBaseUrl, 'https://ck3.paradoxwikis.com');
});

test('注册 9 个只读工具', async () => {
  const { tools } = await boot({});
  assert.deepEqual([...tools.keys()].sort(), EXPECTED_TOOLS);
});

test('apply 不返回任何值（返回值会被 Cordis 当成 effect，数组会让插件激活失败）', async () => {
  const { ctx } = makeCtx();
  const { fetchImpl } = makeFetch();
  const result = await apply(ctx, {}, { fetchImpl });
  assert.equal(result, undefined, 'apply 必须返回 undefined，不能返回工具名数组');
});

test('每个工具的 schema、输出形状与并发标记都完整', async () => {
  const { tools } = await boot({});
  for (const [toolName, definition] of tools) {
    assert.equal(definition.name, toolName);
    assert.ok(definition.description.length > 20, `${toolName} 的描述太短`);
    assert.equal(definition.parameters.type, 'object');
    assert.equal(typeof definition.parameters.properties, 'object');
    assert.equal(definition.output.schema.type, 'object');
    assert.equal(typeof definition.output.render, 'function');
    assert.equal(definition.isConcurrencySafe(), true, `${toolName} 是只读工具，应可并发`);
    const rendered = definition.output.render({}, { text: 'x' });
    assert.deepEqual(rendered, [{ type: 'text', text: 'x' }]);
  }
});

test('每个工具的必填参数都写进了 schema', async () => {
  const { tools } = await boot({});
  const requiredOf = (toolName) => tools.get(toolName).parameters.required ?? [];
  assert.deepEqual(requiredOf('ck3wiki_search'), ['query']);
  assert.deepEqual(requiredOf('ck3wiki_titles'), ['query']);
  assert.deepEqual(requiredOf('ck3wiki_page'), ['title']);
  assert.deepEqual(requiredOf('ck3wiki_sections'), ['title']);
  assert.deepEqual(requiredOf('ck3wiki_page_info'), ['title']);
  assert.deepEqual(requiredOf('ck3wiki_links'), ['title']);
  assert.deepEqual(requiredOf('ck3wiki_category'), ['category']);
  assert.deepEqual(requiredOf('ck3wiki_recent_changes'), []);
});

test('缺少必填参数时抛出可读错误', async () => {
  const { tools } = await boot({});
  await assert.rejects(() => call(tools, 'ck3wiki_search', {}), /缺少必填参数 query/);
  await assert.rejects(() => call(tools, 'ck3wiki_page', { title: '   ' }), /title 不能为空/);
});

test('ck3wiki_status 报告站点概况与配置', async () => {
  const { tools } = await boot({});
  const { text } = await call(tools, 'ck3wiki_status', {});
  assert.ok(text.includes('CK3 Wiki 连通正常'));
  assert.ok(text.includes('MediaWiki 1.39.4'));
  assert.ok(text.includes('页面 7575'));
  assert.ok(text.includes('User-Agent：dsh-ck3wiki/'));
  assert.ok(text.includes('缓存：命中'));
});

test('遇到反爬挑战页时给出可执行的 User-Agent 指引', async () => {
  const { tools } = await boot({}, { SITEINFO: () => challengeResponse() });
  const { text } = await call(tools, 'ck3wiki_status', {});
  assert.ok(text.includes('连通失败'));
  assert.ok(text.includes('反爬挑战页'));
  assert.ok(text.includes('User-Agent'));
  assert.ok(text.includes('userAgent'), '应告诉用户改哪个配置项');
});

test('ck3wiki_search 渲染命中、片段与翻页提示', async () => {
  const { tools } = await boot({});
  const { text } = await call(tools, 'ck3wiki_search', { query: 'de jure casus belli', limit: 2 });
  assert.ok(text.includes('共 63 条命中'));
  assert.ok(text.includes('Innovation'));
  assert.ok(text.includes('pageid 1256'));
  assert.ok(text.includes('offset=3'), '应给出下一页的 offset');
  assert.ok(!text.includes('searchmatch'), 'searchmatch 标签应被剥掉');
  assert.ok(text.includes('&'), '实体应被解码');
});

test('ck3wiki_search 没有命中时给出查询建议', async () => {
  const { tools } = await boot({}, { SEARCH: () => jsonResponse({ query: { searchinfo: { totalhits: 0 }, search: [] } }) });
  const { text } = await call(tools, 'ck3wiki_search', { query: 'zzz' });
  assert.ok(text.includes('没有命中'));
  assert.ok(text.includes('incategory'));
});

test('相同 URL 的重复调用命中缓存，fresh 绕过', async () => {
  const { tools, calls } = await boot({ cacheTtlMs: 60_000 });
  await call(tools, 'ck3wiki_search', { query: 'titles' });
  await call(tools, 'ck3wiki_search', { query: 'titles' });
  const searchCalls = calls.filter((url) => url.includes('list=search'));
  assert.equal(searchCalls.length, 1, '第二次应命中缓存');

  await call(tools, 'ck3wiki_search', { query: 'titles', fresh: true });
  assert.equal(calls.filter((url) => url.includes('list=search')).length, 2, 'fresh=true 应重新取数');
});

test('ck3wiki_titles 给标题候选与 URL', async () => {
  const { tools } = await boot({});
  const { text } = await call(tools, 'ck3wiki_titles', { query: 'casus' });
  assert.ok(text.includes('Casus belli'));
  assert.ok(text.includes('Casus_Belli_(innovation)'));
});

test('ck3wiki_sections 列目录并给出读法', async () => {
  const { tools } = await boot({});
  const { text } = await call(tools, 'ck3wiki_sections', { title: 'Titles' });
  assert.ok(text.includes('共 3 节'));
  assert.ok(text.includes('Title rank'));
  assert.ok(text.includes('section=2'));
  assert.ok(text.includes('ck3wiki_page(title="Titles"'));
});

test('ck3wiki_page 默认返回可读文本', async () => {
  const { tools } = await boot({});
  const { text } = await call(tools, 'ck3wiki_page', { title: 'Casus belli' });
  assert.ok(text.includes('# Casus belli'));
  assert.ok(text.includes('来源：https://ck3.paradoxwikis.com/Casus_belli'));
  assert.ok(text.includes('## Uses'));
  assert.ok(text.includes('- Declare war'));
  assert.ok(text.includes('| Duchy | 100 |'));
  assert.ok(!text.includes('has been verified'));
});

test('ck3wiki_page 支持 section 与 wikitext', async () => {
  const { tools, calls } = await boot({});
  await call(tools, 'ck3wiki_page', { title: 'Titles', section: 2 });
  assert.ok(calls.some((url) => url.includes('section=2')), 'section 应带进请求');

  const { text } = await call(tools, 'ck3wiki_page', { title: 'Casus belli', format: 'wikitext' });
  assert.ok(text.includes('wikitext 源码'));
  assert.ok(text.includes("'''casus belli'''"));
  assert.ok(text.includes('Kami-sama'));
  assert.ok(text.includes('重定向自：Casus Belli'));
});

test('ck3wiki_page 在页面不存在时给候选标题', async () => {
  const { tools } = await boot({}, { PAGE_TEXT: () => jsonResponse(PARSE_MISSING) });
  const { text } = await call(tools, 'ck3wiki_page', { title: 'Casus beli' });
  assert.ok(text.includes('不存在'));
  assert.ok(text.includes('Casus belli'), '应给出相近标题');
});

test('ck3wiki_page 在 section 越界时改列目录', async () => {
  const { tools } = await boot({}, {
    PAGE_TEXT: () => jsonResponse({ error: { code: 'nosuchsection', info: 'There is no section 99.' } }),
  });
  const { text } = await call(tools, 'ck3wiki_page', { title: 'Titles', section: 99 });
  assert.ok(text.includes('超出范围'));
  assert.ok(text.includes('Title rank'));
});

test('ck3wiki_page 按 maxChars 截断并提示分节读', async () => {
  const { tools } = await boot({});
  const { text } = await call(tools, 'ck3wiki_page', { title: 'Traits', maxChars: 120 });
  assert.ok(text.includes('已截断'));
  assert.ok(text.includes('ck3wiki_sections'));
});

test('ck3wiki_page_info 标出消歧义页与分类', async () => {
  const { tools } = await boot({});
  const { text } = await call(tools, 'ck3wiki_page_info', { title: 'Casus belli' });
  assert.ok(text.includes('pageid 1871'));
  assert.ok(text.includes('消歧义'));
  assert.ok(text.includes('1.20'));
  assert.ok(text.includes('重定向自：Casus Belli'));
});

test('ck3wiki_page_info 对不存在的页面给候选', async () => {
  const { tools } = await boot({}, { PAGE_INFO: () => jsonResponse(PAGE_INFO_MISSING) });
  const { text } = await call(tools, 'ck3wiki_page_info', { title: 'Nonexistent page xyzzy' });
  assert.ok(text.includes('不存在'));
});

test('ck3wiki_links 支持出链与反链', async () => {
  const { tools, calls } = await boot({});
  const out = await call(tools, 'ck3wiki_links', { title: 'Casus belli' });
  assert.ok(out.text.includes('的出链'));
  assert.ok(out.text.includes('Template:Version'), '非主命名空间应带前缀');

  const back = await call(tools, 'ck3wiki_links', { title: 'Casus belli', direction: 'in' });
  assert.ok(back.text.includes('链接到「Casus belli」'));
  assert.ok(back.text.includes('经由重定向'));
  assert.ok(calls.some((url) => url.includes('list=backlinks')));
});

test('ck3wiki_category 列成员并提示翻页', async () => {
  const { tools } = await boot({});
  const { text } = await call(tools, 'ck3wiki_category', { category: 'Modding' });
  assert.ok(text.includes('Category:Modding 的成员'));
  assert.ok(text.includes('3D models'));
  assert.ok(text.includes('提高 limit'));
});

test('ck3wiki_category 空分类时给检索建议', async () => {
  const { tools } = await boot({}, { CATEGORY_MEMBERS: () => jsonResponse({ query: { categorymembers: [] } }) });
  const { text } = await call(tools, 'ck3wiki_category', { category: 'Nothing' });
  assert.ok(text.includes('没有成员'));
  assert.ok(text.includes('incategory'));
});

test('ck3wiki_recent_changes 渲染改动、字节差与摘要', async () => {
  const { tools } = await boot({});
  const { text } = await call(tools, 'ck3wiki_recent_changes', { limit: 5, days: 3 });
  assert.ok(text.includes('最近 3 天的改动'));
  assert.ok(text.includes('Template:Tradition/doc'));
  assert.ok(text.includes('+45'));
  assert.ok(text.includes('/* Parameters */'));
  assert.ok(text.includes('新建'));
});

test('网络失败时抛出带建议的错误（而不是裸的 fetch 异常）', async () => {
  const { tools } = await boot({}, {
    SEARCH: () => {
      throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), { code: 'ECONNREFUSED' });
    },
  });
  await assert.rejects(() => call(tools, 'ck3wiki_search', { query: 'x' }), (error) => {
    assert.ok(error.message.includes('检索失败'));
    assert.ok(error.message.includes('建议'));
    assert.ok(error.message.includes('加速器'));
    return true;
  });
});

test('HTTP 503 会重试一次后才回报失败', async () => {
  let attempts = 0;
  const { tools } = await boot({}, {
    SITEINFO: () => {
      attempts += 1;
      return jsonResponse({ error: 'boom' }, 503);
    },
  });
  const { text } = await call(tools, 'ck3wiki_status', {});
  assert.equal(attempts, 2, '503 应重试一次（共两次请求）');
  assert.ok(text.includes('连通失败'));
  assert.ok(text.includes('wiki 侧暂时不可用'));
});
