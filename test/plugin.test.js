/**
 * 插件级测试（离线）：模块契约、配置归一、9 个工具的注册与执行路径、缓存与错误分支。
 *
 * 出网用注入的 `fetchImpl` 顶替（`apply(ctx, config, { fetchImpl })`），所以这些用例
 * 完全不联网；真实站点的冒烟测试在 live.test.js，用 `DSH_CK3WIKI_LIVE=1` 打开。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import * as plugin from '../lib/index.js';
import { TOOL_TIMEOUT_MS } from '../lib/tools/shared.js';
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
  /** @type {string[]} */
  const warnings = [];
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
    logger: {
      info() {},
      warn(message) {
        warnings.push(String(message));
      },
    },
  };
  return { ctx, tools, warnings };
}

/** 按 URL 决定返回哪个 fixture。 */
function routeFor(rawUrl) {
  const params = new URL(rawUrl).searchParams;
  const prop = String(params.get('prop') ?? '');
  const list = String(params.get('list') ?? '');
  if (params.get('meta') === 'siteinfo') {
    return String(params.get('siprop') ?? '').includes('namespaces') ? 'NAMESPACES' : 'SITEINFO';
  }
  if (params.get('action') === 'opensearch') return 'OPENSEARCH';
  if (list === 'search') return 'SEARCH';
  // 列表模块优先于 prop：links/backlinks/categorymembers 的 URL 里还带着 prop=info。
  if (list === 'backlinks') return 'BACKLINKS';
  if (list === 'categorymembers') return 'CATEGORY_MEMBERS';
  if (list === 'recentchanges') return 'RECENT_CHANGES';
  if (params.get('action') === 'parse') {
    if (prop.includes('sections')) return 'SECTIONS';
    if (prop.includes('wikitext')) return 'PARSE_WIKITEXT';
    return 'PAGE_TEXT';
  }
  if (prop === 'revisions') return 'WIKITEXT';
  if (prop.includes('info')) return 'PAGE_INFO';
  if (prop === 'links') return 'LINKS';
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
  const { ctx, tools, warnings } = makeCtx();
  const { fetchImpl, calls } = makeFetch(overrides);
  await apply(ctx, config, { fetchImpl });
  return { tools, calls, warnings };
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

test('ck3wiki_status 默认精简，verbose 才输出静态配置与缓存计数', async () => {
  const { tools } = await boot({});
  const { text } = await call(tools, 'ck3wiki_status', {});
  assert.ok(text.includes('CK3 Wiki 连通正常'));
  assert.ok(text.includes('MediaWiki 1.39.4'));
  assert.ok(text.includes('页面 7575'));
  assert.ok(text.includes('User-Agent：dsh-ck3wiki/'));
  assert.ok(text.includes('webFallback=on'));
  assert.ok(text.includes('缓存：开启'));
  assert.ok(!text.includes('requestTimeoutMs'), `默认不该输出静态配置：\n${text}`);
  assert.ok(!text.includes('maxChars'), text);
  assert.ok(!text.includes('缓存计数'), text);

  const verbose = await call(tools, 'ck3wiki_status', { verbose: true });
  assert.ok(verbose.text.includes('requestTimeoutMs=15000'), verbose.text);
  assert.ok(verbose.text.includes('maxChars=20000'), verbose.text);
  assert.ok(verbose.text.includes('maxListedItems=100'), verbose.text);
  assert.ok(verbose.text.includes('cacheTtlMs=60000'), verbose.text);
  assert.ok(verbose.text.includes('缓存计数：命中'), verbose.text);
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

test('ck3wiki_search 清洗片段里的站点样板与缩略图报错', async () => {
  const noisy = {
    query: {
      searchinfo: { totalhits: 1 },
      search: [{
        ns: 0,
        title: 'Casus belli',
        pageid: 1256,
        size: 1000,
        wordcount: 100,
        timestamp: '2026-09-01T00:00:00Z',
        snippet: 'collect personal data. Privacy Policy ContinueDismiss CK3 Seize <span class="searchmatch">De</span> Jure titles. '
          + 'having the Error creating thumbnail: File missing Inbred trait.',
      }],
    },
  };
  const { tools } = await boot({}, { SEARCH: () => jsonResponse(noisy) });
  const { text } = await call(tools, 'ck3wiki_search', { query: 'de jure' });
  assert.ok(!text.includes('Privacy Policy'), text);
  assert.ok(!text.includes('ContinueDismiss'), text);
  assert.ok(!text.includes('collect personal data'), text);
  assert.ok(!text.includes('Error creating thumbnail'), text);
  assert.ok(text.includes('having the Inbred trait.'), '行内噪声之外的正文要保留');
});

test('ck3wiki_search 片段整条都是样板时不输出空行', async () => {
  const allBanner = {
    query: {
      searchinfo: { totalhits: 1 },
      search: [{
        ns: 0,
        title: 'Modding',
        pageid: 1,
        size: 10,
        wordcount: 1,
        timestamp: '2026-09-01T00:00:00Z',
        snippet: 'collect personal data. Privacy Policy ContinueDismiss CK3',
      }],
    },
  };
  const { tools } = await boot({}, { SEARCH: () => jsonResponse(allBanner) });
  const { text } = await call(tools, 'ck3wiki_search', { query: 'x' });
  assert.ok(!/^ {3}$/m.test(text), `不应留下空的片段行：\n${text}`);
  assert.ok(text.includes('1. Modding'), text);
});

test('ck3wiki_search 没有命中时给出查询建议', async () => {
  const { tools } = await boot({}, { SEARCH: () => jsonResponse({ query: { searchinfo: { totalhits: 0 }, search: [] } }) });
  const { text } = await call(tools, 'ck3wiki_search', { query: 'zzz' });
  assert.ok(text.includes('没有命中'));
  assert.ok(text.includes('incategory'));
});

/** 一个通用的接口错误响应（形状取自 MediaWiki 的 `badvalue`）。 */
const API_ERROR_FIXTURE = { error: { code: 'badvalue', info: 'Unrecognized value for parameter "srlimit".' } };

test('接口报错时如实上报（不再伪装成空结果）', async () => {
  const rejected = () => jsonResponse(API_ERROR_FIXTURE);
  const cases = [
    ['ck3wiki_status', {}, 'SITEINFO'],
    ['ck3wiki_search', { query: 'x' }, 'SEARCH'],
    ['ck3wiki_titles', { query: 'x' }, 'OPENSEARCH'],
    ['ck3wiki_links', { title: 'Modding' }, 'LINKS'],
    ['ck3wiki_links', { title: 'Modding', direction: 'in' }, 'BACKLINKS'],
    ['ck3wiki_category', { category: 'Modding' }, 'CATEGORY_MEMBERS'],
    ['ck3wiki_recent_changes', {}, 'RECENT_CHANGES'],
    ['ck3wiki_page_info', { title: 'Modding' }, 'PAGE_INFO'],
    ['ck3wiki_page', { title: 'Modding' }, 'PAGE_TEXT'],
    ['ck3wiki_page', { title: 'Modding', format: 'wikitext' }, 'WIKITEXT'],
    ['ck3wiki_sections', { title: 'Modding' }, 'SECTIONS'],
  ];
  for (const [toolName, args, route] of cases) {
    const { tools } = await boot({}, { [route]: rejected });
    const { text } = await call(tools, toolName, args);
    assert.ok(text.includes('badvalue'), `${toolName} / ${route} 应报出 badvalue：\n${text}`);
    assert.ok(text.includes('建议：'), `${toolName} / ${route} 应给出建议：\n${text}`);
  }
});

test('cirrussearch-parse-error 给出「把查询写简单些」的建议', async () => {
  const parseError = { error: { code: 'cirrussearch-parse-error', info: 'Query was not understood. Please make it simpler.' } };
  const { tools } = await boot({}, { SEARCH: () => jsonResponse(parseError) });
  const { text } = await call(tools, 'ck3wiki_search', { query: 'insource:/[/' });
  assert.ok(text.includes('cirrussearch-parse-error'), text);
  assert.ok(text.includes('写简单些'), text);
});

test('标题原样打印，不再拼出 Project: / Template: 前缀', async () => {
  const { tools } = await boot({});
  const { text: back } = await call(tools, 'ck3wiki_links', { title: 'CK3 Wiki:Style', direction: 'in' });
  assert.ok(back.includes('CK3 Wiki:Style'), `反链标题应原样打印：\n${back}`);
  assert.ok(!back.includes('Project:'), `不该出现二次拼接的前缀：\n${back}`);

  const { text: hits } = await call(tools, 'ck3wiki_search', { query: 'de jure' });
  assert.ok(hits.includes('Template:Casus belli'), `检索命中的标题已带前缀，应原样打印：\n${hits}`);
  assert.ok(!hits.includes('Template:Template:'), `不该二次拼接命名空间前缀：\n${hits}`);

  for (const [toolName, args] of [
    ['ck3wiki_links', { title: 'Casus belli' }],
    ['ck3wiki_category', { category: 'Modding' }],
    ['ck3wiki_recent_changes', {}],
  ]) {
    const { text } = await call(tools, toolName, args);
    assert.ok(!text.includes('Project:'), `${toolName} 不该出现 Project: 前缀：\n${text}`);
  }
});

test('启动日志不再误报 wikiBaseUrl 回退；真写错时才警告', async () => {
  const clean = await boot({});
  assert.deepEqual(clean.warnings, [], `缺省配置不该有警告：${clean.warnings.join(' / ')}`);

  const bad = await boot({ wikiBaseUrl: 'not-a-url' });
  assert.ok(bad.warnings.some((line) => line.includes('wikiBaseUrl')), bad.warnings.join(' / '));
});

test('normalizeConfig：noisePatterns 有默认值，显式空数组=关闭', () => {
  const dflt = plugin.normalizeConfig({});
  assert.ok(Array.isArray(dflt.noisePatterns));
  assert.ok(dflt.noisePatterns.includes('^Load video$'), JSON.stringify(dflt.noisePatterns));
  assert.deepEqual(plugin.normalizeConfig({ noisePatterns: [] }).noisePatterns, [], '显式空数组 = 关闭行级过滤');
  assert.deepEqual(plugin.normalizeConfig({ noisePatterns: ['^X$'] }).noisePatterns, ['^X$']);
  assert.ok(plugin.normalizeConfig({ noisePatterns: 'nope' }).noisePatterns.includes('^Load video$'), '类型写错回退默认');
});

test('ck3wiki_page：视频装饰被清掉，图注（视频标题）保留', async () => {
  const { tools } = await boot({});
  const { text } = await call(tools, 'ck3wiki_page', { title: 'Casus belli' });
  assert.ok(!text.includes('Load video'), text.slice(0, 400));
  assert.ok(!text.includes('might collect personal data'), text.slice(0, 400));
  assert.ok(text.includes('CK3 Modding #1'), 'figcaption 里的视频标题必须保留');
});

test('ck3wiki_page：行级噪声走配置，关掉就不过滤', async () => {
  const payload = {
    parse: { title: 'X', pageid: 1, revid: 1, text: '<div class="mw-parser-output"><p>YouTube</p><h2>Uses</h2><p>正文</p></div>' },
  };
  const on = await boot({}, { PAGE_TEXT: () => jsonResponse(payload) });
  const filtered = await call(on.tools, 'ck3wiki_page', { title: 'X' });
  assert.ok(!filtered.text.split('\n').includes('YouTube'), filtered.text);
  assert.ok(filtered.text.includes('正文'), filtered.text);

  const off = await boot({ noisePatterns: [] }, { PAGE_TEXT: () => jsonResponse(payload) });
  const unfiltered = await call(off.tools, 'ck3wiki_page', { title: 'X' });
  assert.ok(unfiltered.text.split('\n').includes('YouTube'), unfiltered.text);
});

test('normalizeConfig：dropClasses 默认是出厂表，extraDropClasses 默认为空', () => {
  const dflt = plugin.normalizeConfig({});
  assert.ok(Array.isArray(dflt.dropClasses));
  assert.equal(dflt.dropClasses.length, 15, JSON.stringify(dflt.dropClasses));
  assert.ok(dflt.dropClasses.includes('navbox'), JSON.stringify(dflt.dropClasses));
  assert.ok(dflt.dropClasses.includes('embedvideo-consent'), '默认表必须含视频装饰层');
  assert.deepEqual(dflt.extraDropClasses, []);
});

test('normalizeConfig：dropClasses / extraDropClasses 的覆盖与容错', () => {
  assert.deepEqual(plugin.normalizeConfig({ dropClasses: [] }).dropClasses, [], '显式空表 = 不做 class 过滤');
  assert.deepEqual(plugin.normalizeConfig({ dropClasses: ['  a  ', '', 5] }).dropClasses, ['a'], '去空白并过滤非法项');
  assert.ok(plugin.normalizeConfig({ dropClasses: 'nope' }).dropClasses.includes('navbox'), '类型写错回退默认');
  assert.deepEqual(plugin.normalizeConfig({ extraDropClasses: ['x'] }).extraDropClasses, ['x']);
  assert.deepEqual(plugin.normalizeConfig({ extraDropClasses: 'nope' }).extraDropClasses, []);
});

test('ck3wiki_page：extraDropClasses 追加、dropClasses 替换', async () => {
  const payload = {
    parse: {
      title: 'X',
      pageid: 1,
      revid: 1,
      text: '<div class="mw-parser-output"><div class="mine">自定义块</div><div class="navbox">导航块</div><p>正文</p></div>',
    },
  };
  const dflt = await boot({}, { PAGE_TEXT: () => jsonResponse(payload) });
  const plain = await call(dflt.tools, 'ck3wiki_page', { title: 'X' });
  assert.ok(plain.text.includes('自定义块'), plain.text);
  assert.ok(!plain.text.includes('导航块'), plain.text);

  const extra = await boot({ extraDropClasses: ['mine'] }, { PAGE_TEXT: () => jsonResponse(payload) });
  const dropped = await call(extra.tools, 'ck3wiki_page', { title: 'X' });
  assert.ok(!dropped.text.includes('自定义块'), dropped.text);
  assert.ok(!dropped.text.includes('导航块'), dropped.text);

  const replaced = await boot({ dropClasses: ['mine'] }, { PAGE_TEXT: () => jsonResponse(payload) });
  const custom = await call(replaced.tools, 'ck3wiki_page', { title: 'X' });
  assert.ok(!custom.text.includes('自定义块'), custom.text);
  assert.ok(custom.text.includes('导航块'), custom.text);
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

test('ck3wiki_page_info 报真实最后修订（时间/编辑者/摘要/revid）与分类', async () => {
  const { tools } = await boot({});
  const { text } = await call(tools, 'ck3wiki_page_info', { title: 'Casus belli' });
  assert.ok(text.includes('pageid 1871'));
  assert.ok(text.includes('最后编辑：2026-09-30T13:45:54Z'), text);
  assert.ok(text.includes('由 Kami-sama'), text);
  assert.ok(text.includes('revid 36426'), text);
  assert.ok(text.includes('编辑摘要：/* Uses */ add seize duchy'), text);
  assert.ok(text.includes('1.20'));
  assert.ok(text.includes('重定向自：Casus Belli'));
  // touched（链接表被触碰的时间）不是最后编辑时间，不该冒出来当最后编辑。
  assert.ok(!text.includes('2026-10-05'), text);
  // 消歧义/重定向标记已随 pageprops 一起删除，不再承诺。
  assert.ok(!text.includes('消歧义'), text);
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

test('ck3wiki_category 列成员并回显下一次 continue（不再建议提高 limit）', async () => {
  const { tools, calls } = await boot({});
  const { text } = await call(tools, 'ck3wiki_category', { category: 'Modding' });
  assert.ok(text.includes('Category:Modding 的成员'));
  assert.ok(text.includes('3D models'));
  assert.ok(text.includes('下一次 continue=next|abc'), text);
  assert.ok(!text.includes('提高 limit'), `到上限不该再建议提高 limit：\n${text}`);
  assert.ok(!text.includes('上限'), text);

  await call(tools, 'ck3wiki_category', { category: 'Modding', continue: 'next|abc' });
  assert.ok(calls.some((url) => new URL(url).searchParams.get('cmcontinue') === 'next|abc'), 'continue 应原样透传成 cmcontinue');
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

/** 从 URL 里取一个查询参数（测试断言用）。 */
function paramOf(url, key) {
  return new URL(String(url)).searchParams.get(key);
}

/** 一次接口警告响应的形状。 */
const API_WARNINGS = { main: { warnings: 'Unrecognized parameter: srnamespace' } };

test('命名空间名字与别名解析成数字 id；数字与 * 直通不额外请求', async () => {
  const { tools, calls } = await boot({});
  await call(tools, 'ck3wiki_search', { query: 'x', namespace: 'Template' });
  assert.ok(calls.some((url) => paramOf(url, 'srnamespace') === '10'), '本地命名空间名应解析成 10');
  await call(tools, 'ck3wiki_search', { query: 'x', namespace: 'Image' });
  assert.ok(calls.some((url) => paramOf(url, 'srnamespace') === '6'), '别名应交解析成 6');
  await call(tools, 'ck3wiki_search', { query: 'x', namespace: 'CK3 Wiki' });
  assert.ok(calls.some((url) => paramOf(url, 'srnamespace') === '4'), '站点本地项目名应解析成 4');
  await call(tools, 'ck3wiki_links', { title: 'Casus belli', namespace: 'Template' });
  assert.ok(calls.some((url) => paramOf(url, 'plnamespace') === '10'));
  await call(tools, 'ck3wiki_recent_changes', { namespace: 'CK3 Wiki' });
  assert.ok(calls.some((url) => paramOf(url, 'rcnamespace') === '4'));
  await call(tools, 'ck3wiki_titles', { query: 'casus', namespace: 'Template' });
  assert.ok(calls.some((url) => paramOf(url, 'namespace') === '10'), 'titles 的 namespace 参数应带进 opensearch');

  const numeric = await boot({});
  await call(numeric.tools, 'ck3wiki_search', { query: 'x', namespace: 10 });
  assert.ok(!numeric.calls.some((url) => String(paramOf(url, 'siprop') ?? '').includes('namespaces')), '数字 id 不该触发命名空间表请求');
  assert.ok(numeric.calls.some((url) => paramOf(url, 'srnamespace') === '10'));
  await call(numeric.tools, 'ck3wiki_search', { query: 'x', namespace: '*' });
  assert.ok(numeric.calls.some((url) => paramOf(url, 'srnamespace') === '*'));
});

test('不认识的命名空间写可执行错误（列出可用名字）', async () => {
  const { tools } = await boot({});
  await assert.rejects(() => call(tools, 'ck3wiki_search', { query: 'x', namespace: 'Nope' }), (error) => {
    assert.ok(error.message.includes('无法识别命名空间「Nope」'), error.message);
    assert.ok(error.message.includes('Template'), `应列出可用名字：${error.message}`);
    assert.ok(error.message.includes('*'), error.message);
    return true;
  });
});

test('接口 warnings 在各列表工具的输出里如实呈现', async () => {
  const withWarnings = (route) => () => jsonResponse({ ...fixtures[route], warnings: API_WARNINGS });
  const cases = [
    ['ck3wiki_search', { query: 'x' }, 'SEARCH'],
    ['ck3wiki_titles', { query: 'x' }, 'OPENSEARCH'],
    ['ck3wiki_links', { title: 'Casus belli' }, 'LINKS'],
    ['ck3wiki_links', { title: 'Casus belli', direction: 'in' }, 'BACKLINKS'],
    ['ck3wiki_category', { category: 'Modding' }, 'CATEGORY_MEMBERS'],
    ['ck3wiki_recent_changes', {}, 'RECENT_CHANGES'],
  ];
  for (const [toolName, args, route] of cases) {
    const { tools } = await boot({}, { [route]: withWarnings(route) });
    const { text } = await call(tools, toolName, args);
    assert.ok(text.includes('警告：'), `${toolName} 应带出 warning：\n${text}`);
    assert.ok(text.includes('该站未按参数过滤，请用数字 id'), text);
  }
});

test('wikitext 按节取源码走 action=parse，并给出范围与 revid', async () => {
  const { tools, calls } = await boot({});
  const { text } = await call(tools, 'ck3wiki_page', { title: 'Casus belli', format: 'wikitext', section: 2 });
  const url = calls.find((candidate) => paramOf(candidate, 'action') === 'parse' && String(paramOf(candidate, 'prop')).includes('wikitext'));
  assert.ok(url, `按节取源码应走 action=parse：\n${calls.join('\n')}`);
  assert.equal(paramOf(url, 'section'), '2');
  assert.equal(paramOf(url, 'page'), 'Casus belli');
  assert.ok(text.includes('范围：section=2'), text);
  assert.ok(text.includes("'''casus belli'''"), text);
});

test('wikitext 按节越界时改列目录（nosuchsection 走现有映射）', async () => {
  const { tools } = await boot({}, {
    PARSE_WIKITEXT: () => jsonResponse({ error: { code: 'nosuchsection', info: 'There is no section 99.' } }),
  });
  const { text } = await call(tools, 'ck3wiki_page', { title: 'Titles', format: 'wikitext', section: 99 });
  assert.ok(text.includes('超出范围'), text);
  assert.ok(text.includes('Title rank'), text);
});

test('ck3wiki_links / recent_changes 回显下一次 continue，并透传游标', async () => {
  const { tools, calls } = await boot({});
  const out = await call(tools, 'ck3wiki_links', { title: 'Casus belli' });
  assert.ok(out.text.includes('下一次 continue=War|0|0'), out.text);
  const back = await call(tools, 'ck3wiki_links', { title: 'Casus belli', direction: 'in' });
  assert.ok(back.text.includes('下一次 continue=Traits|0'), back.text);
  const recent = await call(tools, 'ck3wiki_recent_changes', {});
  assert.ok(recent.text.includes('下一次 continue=2026-09-30T22:10:00Z|36480'), recent.text);

  await call(tools, 'ck3wiki_links', { title: 'Casus belli', continue: 'War|0|0' });
  assert.ok(calls.some((url) => paramOf(url, 'plcontinue') === 'War|0|0'));
  await call(tools, 'ck3wiki_recent_changes', { continue: 'ts|1' });
  assert.ok(calls.some((url) => paramOf(url, 'rccontinue') === 'ts|1'));
});

test('fresh 参数存在且能绕过缓存（titles / links / category）', async () => {
  const { tools: booted } = await boot({});
  for (const [toolName, definition] of booted) {
    assert.equal(definition.parameters.properties.fresh?.type, 'boolean', `${toolName} 缺 fresh 参数`);
  }

  for (const [toolName, args, marker] of [
    ['ck3wiki_titles', { query: 'casus' }, 'action=opensearch'],
    ['ck3wiki_links', { title: 'Casus belli' }, 'prop=links'],
    ['ck3wiki_category', { category: 'Modding' }, 'list=categorymembers'],
  ]) {
    const { tools, calls } = await boot({});
    const count = () => calls.filter((url) => url.includes(marker)).length;
    await call(tools, toolName, args);
    await call(tools, toolName, args);
    assert.equal(count(), 1, `${toolName} 第二次应命中缓存`);
    await call(tools, toolName, { ...args, fresh: true });
    assert.equal(count(), 2, `${toolName} 的 fresh=true 应重新取数`);
  }
});

test('recent_changes 的 URL 按 TTL 窗口对齐，重复调用命中缓存', async () => {
  const { tools, calls } = await boot({ cacheTtlMs: 3_600_000 });
  await call(tools, 'ck3wiki_recent_changes', { limit: 5 });
  await call(tools, 'ck3wiki_recent_changes', { limit: 5 });
  const recentCalls = calls.filter((url) => url.includes('list=recentchanges'));
  assert.equal(recentCalls.length, 1, '相同参数应命中缓存');
  const rcstart = paramOf(recentCalls[0], 'rcstart');
  assert.equal(rcstart, new Date(Math.floor(new Date(rcstart).getTime() / 3_600_000) * 3_600_000).toISOString());

  await call(tools, 'ck3wiki_recent_changes', { limit: 5, fresh: true });
  assert.equal(calls.filter((url) => url.includes('list=recentchanges')).length, 2);
});

test('search 的 offset 越界与「没有命中」区分开', async () => {
  const { tools } = await boot({}, {
    SEARCH: () => jsonResponse({ query: { searchinfo: { totalhits: 63 }, search: [] } }),
  });
  const { text } = await call(tools, 'ck3wiki_search', { query: 'de jure', offset: 100 });
  assert.ok(text.includes('超出命中范围'), text);
  assert.ok(text.includes('共 63 条命中'), text);
  assert.ok(!text.includes('没有命中'), `不该说成没有命中：\n${text}`);
});

test('页面不存在时 links / category 报「不存在」而不是「空」', async () => {
  const links = await boot({}, { LINKS: () => jsonResponse(fixtures.LINKS_MISSING) });
  const out = await call(links.tools, 'ck3wiki_links', { title: 'Nonexistent page xyzzy' });
  assert.ok(out.text.includes('不存在'), out.text);
  assert.ok(!out.text.includes('没有指向别处'), out.text);

  const back = await boot({}, { BACKLINKS: () => jsonResponse(fixtures.BACKLINKS_MISSING) });
  const incoming = await call(back.tools, 'ck3wiki_links', { title: 'Nonexistent page xyzzy', direction: 'in' });
  assert.ok(incoming.text.includes('不存在'), incoming.text);
  assert.ok(!incoming.text.includes('没有页面链接到'), incoming.text);

  const category = await boot({}, { CATEGORY_MEMBERS: () => jsonResponse(fixtures.CATEGORY_MISSING) });
  const members = await call(category.tools, 'ck3wiki_category', { category: 'Nothing' });
  assert.ok(members.text.includes('不存在'), members.text);
  assert.ok(!members.text.includes('没有成员'), members.text);
});

test('列表工具的上限改读 config.maxListedItems', async () => {
  const { tools, calls } = await boot({ maxListedItems: 7 });
  await call(tools, 'ck3wiki_links', { title: 'Casus belli', limit: 500 });
  assert.equal(paramOf(calls.find((url) => url.includes('prop=links')), 'pllimit'), '7');
  await call(tools, 'ck3wiki_category', { category: 'Modding', limit: 500 });
  assert.equal(paramOf(calls.find((url) => url.includes('list=categorymembers')), 'cmlimit'), '7');
  await call(tools, 'ck3wiki_recent_changes', { limit: 500 });
  assert.equal(paramOf(calls.find((url) => url.includes('list=recentchanges')), 'rclimit'), '7');
  await call(tools, 'ck3wiki_titles', { query: 'casus', limit: 500 });
  assert.equal(paramOf(calls.find((url) => url.includes('action=opensearch')), 'limit'), '7');
  assert.ok(tools.get('ck3wiki_titles').parameters.properties.limit.description.includes('上限 7'));
});

test('category 输出的是生效的 type，非法 enum / 未知参数直接报错', async () => {
  const { tools, calls } = await boot({});
  const { text } = await call(tools, 'ck3wiki_category', { category: 'Modding', type: 'all' });
  assert.ok(text.includes('type=all'), text);
  const allUrl = calls.filter((url) => url.includes('list=categorymembers')).at(-1);
  assert.equal(paramOf(allUrl, 'cmtype'), null, 'type=all 应不传 cmtype（不按类型过滤）');
  await assert.rejects(() => call(tools, 'ck3wiki_category', { category: 'Modding', type: 'nope' }), /只能是/);
  await assert.rejects(() => call(tools, 'ck3wiki_category', { category: 'Modding', unknown: 1 }), /不认识的参数/);
});

test('每个工具声明 TOOL_TIMEOUT_MS 卡死兜底', async () => {
  assert.equal(TOOL_TIMEOUT_MS, 45_000);
  const { tools } = await boot({});
  for (const [toolName, definition] of tools) {
    assert.equal(definition.timeoutMs, TOOL_TIMEOUT_MS, `${toolName} 缺 timeoutMs`);
  }
});

test('工具描述不再重复「只读/不需要密钥」样板，CirrusSearch 语法只留在 query 参数里', async () => {
  const { tools } = await boot({});
  for (const [toolName, definition] of tools) {
    assert.ok(!definition.description.includes('只读'), `${toolName} 描述仍有「只读」样板`);
    assert.ok(!definition.description.includes('不需要密钥'), `${toolName} 描述仍有「不需要密钥」样板`);
  }
  const search = tools.get('ck3wiki_search');
  assert.ok(!search.description.includes('incategory'), 'CirrusSearch 语法应只在 query 参数描述里');
  assert.ok(search.parameters.properties.query.description.includes('incategory'));
  assert.ok(search.parameters.properties.query.description.includes('insource'));
});

test('wikitext 截断注记计入 maxChars 预算', async () => {
  const big = 'x'.repeat(500);
  const wikitext = {
    query: {
      pages: [{
        pageid: 1,
        ns: 0,
        title: 'Big',
        revisions: [{ revid: 1, timestamp: '2026-01-01T00:00:00Z', user: 'u', comment: 'c', slots: { main: { content: big } } }],
      }],
    },
  };
  const { tools } = await boot({}, { WIKITEXT: () => jsonResponse(wikitext) });
  const { text } = await call(tools, 'ck3wiki_page', { title: 'Big', format: 'wikitext', maxChars: 200 });
  const body = text.split('```wikitext\n')[1].split('\n```')[0];
  assert.ok(body.includes('已截断'), body);
  assert.ok(body.length <= 200, `源码块长度 ${body.length} 应 ≤ maxChars=200`);
});

test('normalizeConfig 为每个被拒字段各记一条告警，apply 逐条发出', async () => {
  const config = plugin.normalizeConfig({
    wikiBaseUrl: 'not-a-url',
    requestTimeoutMs: -1,
    maxChars: 'big',
    maxListedItems: 0,
    cacheTtlMs: -5,
    trustSystemCa: 'weird',
    webFallback: 'yes',
    noisePatterns: 'nope',
    dropClasses: 42,
  });
  const joined = config.configWarnings.join('\n');
  for (const field of ['wikiBaseUrl', 'requestTimeoutMs', 'maxChars', 'maxListedItems', 'cacheTtlMs', 'trustSystemCa', 'webFallback', 'noisePatterns', 'dropClasses']) {
    assert.ok(joined.includes(field), `缺少 ${field} 的告警：\n${joined}`);
  }
  assert.equal(config.configWarnings.length, 9, joined);

  const { warnings } = await boot({ requestTimeoutMs: -1, trustSystemCa: 'weird' });
  assert.ok(warnings.some((line) => line.includes('requestTimeoutMs')), warnings.join(' / '));
  assert.ok(warnings.some((line) => line.includes('trustSystemCa')), warnings.join(' / '));
});

test('ck3wiki_search 清洗片段里的裸「File missing」', async () => {
  const noisy = {
    query: {
      searchinfo: { totalhits: 1 },
      search: [{
        ns: 0,
        title: 'X',
        pageid: 1,
        size: 10,
        wordcount: 1,
        timestamp: '2026-09-01T00:00:00Z',
        snippet: 'the trait costs File missing 100 gold to unlock.',
      }],
    },
  };
  const { tools } = await boot({}, { SEARCH: () => jsonResponse(noisy) });
  const { text } = await call(tools, 'ck3wiki_search', { query: 'x' });
  assert.ok(!text.includes('File missing'), text);
  assert.ok(text.includes('the trait costs 100 gold to unlock.'), text);
});
