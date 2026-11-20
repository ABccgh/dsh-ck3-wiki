/**
 * URL 构造器与响应映射器的单元测试（离线，不联网）。
 *
 * 断言的是「接口契约」：参数怎么进 URL、响应怎么变成工具要用的形状。
 * 真实响应形状见 test/fixtures/fixtures.js（取自 2026-10-01 的实测）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  alignToCacheWindow,
  apiUrl,
  backlinksUrl,
  categoryMembersUrl,
  categoryTitle,
  linksUrl,
  mapBacklinks,
  mapCategoryMembers,
  mapLinks,
  mapNamespaces,
  mapOpenSearch,
  mapPageInfo,
  mapPageText,
  mapParseWikitext,
  mapRecentChanges,
  mapSearch,
  mapSections,
  mapSiteInfo,
  mapWikitext,
  namespaceLabel,
  normalizeApiPath,
  openSearchUrl,
  pageInfoUrl,
  pageMissing,
  pageTextUrl,
  pageUrl,
  parseWikitextUrl,
  recentChangesUrl,
  searchUrl,
  sectionsUrl,
  siteInfoUrl,
  wikitextUrl,
} from '../lib/mediawiki.js';

import {
  BACKLINKS,
  CATEGORY_MEMBERS,
  LINKS,
  NAMESPACES,
  OPENSEARCH,
  PAGE_INFO,
  PAGE_INFO_MISSING,
  PAGE_TEXT,
  PARSE_WIKITEXT,
  RECENT_CHANGES,
  SEARCH,
  SECTIONS,
  SITEINFO,
  WIKITEXT,
} from './fixtures/fixtures.js';

const BASE = 'https://ck3.paradoxwikis.com';
const API = '/api.php';

/** 从 URL 里取一个查询参数。 */
function param(url, key) {
  return new URL(url).searchParams.get(key);
}

test('apiUrl 总是带 format=json 与 formatversion=2，并编码参数', () => {
  const url = apiUrl(BASE, API, { action: 'query', titles: 'Casus belli & war' });
  assert.equal(param(url, 'format'), 'json');
  assert.equal(param(url, 'formatversion'), '2');
  assert.equal(param(url, 'titles'), 'Casus belli & war');
  assert.ok(url.includes('Casus+belli+%26+war'));
  assert.ok(url.startsWith('https://ck3.paradoxwikis.com/api.php?'));
});

test('apiUrl 丢掉 undefined/null 参数，但保留 0', () => {
  const url = apiUrl(BASE, API, { action: 'parse', section: 0, prop: undefined, meta: null });
  assert.equal(param(url, 'section'), '0');
  assert.equal(param(url, 'prop'), null);
  assert.equal(param(url, 'meta'), null);
});

test('normalizeApiPath / normalizeBase 容错', () => {
  assert.equal(normalizeApiPath('api.php'), '/api.php');
  assert.equal(normalizeApiPath('/w/api.php'), '/w/api.php');
  assert.equal(normalizeApiPath(''), '/api.php');
  assert.ok(apiUrl('https://example.org/wiki/', API, {}).startsWith('https://example.org/wiki/api.php?'));
});

test('pageUrl 用下划线代替空格并编码', () => {
  assert.equal(pageUrl(BASE, 'Casus belli'), 'https://ck3.paradoxwikis.com/Casus_belli');
  assert.equal(pageUrl(BASE, 'Casus Belli (innovation)'), 'https://ck3.paradoxwikis.com/Casus_Belli_(innovation)');
});

test('pageUrl 与站点 fullurl 逐字一致（子页与命名空间标题）', () => {
  // 期望值取自站点自己的 `prop=info&inprop=url`（2026-10-02 实测），不是我们的约定。
  assert.equal(pageUrl(BASE, 'Template:0/doc'), 'https://ck3.paradoxwikis.com/Template:0/doc');
  assert.equal(pageUrl(BASE, 'Module:Arguments/doc'), 'https://ck3.paradoxwikis.com/Module:Arguments/doc');
  assert.equal(pageUrl(BASE, 'Template:Add/Strategy'), 'https://ck3.paradoxwikis.com/Template:Add/Strategy');
  assert.equal(pageUrl(BASE, 'CK3 Wiki:Style'), 'https://ck3.paradoxwikis.com/CK3_Wiki:Style');
  assert.equal(pageUrl(BASE, 'Modding'), 'https://ck3.paradoxwikis.com/Modding');
});

test('pageUrl 的边界：空标题、子页里的空格、含 % 的标题', () => {
  assert.equal(pageUrl(BASE, ''), 'https://ck3.paradoxwikis.com/');
  assert.equal(pageUrl(BASE, 'Modding/console commands'), 'https://ck3.paradoxwikis.com/Modding/console_commands');
  assert.equal(pageUrl(BASE, 'Template:50%'), 'https://ck3.paradoxwikis.com/Template:50%25');
  assert.equal(pageUrl(BASE, '  Modding  '), 'https://ck3.paradoxwikis.com/Modding');
});

test('categoryTitle 补前缀且不重复补', () => {
  assert.equal(categoryTitle('Modding'), 'Category:Modding');
  assert.equal(categoryTitle('category:Modding'), 'Category:Modding');
});

test('namespaceLabel 覆盖本站命名空间', () => {
  assert.equal(namespaceLabel(0), '');
  assert.equal(namespaceLabel(10), 'Template');
  assert.equal(namespaceLabel(14), 'Category');
  assert.equal(namespaceLabel(1198), 'Translations');
  assert.equal(namespaceLabel(4242), 'ns4242');
});

test('各端点 URL 带上正确的 action/list/prop', () => {
  assert.equal(param(siteInfoUrl(BASE, API), 'siprop'), 'general|statistics');

  const search = searchUrl(BASE, API, { query: 'de jure', limit: 5, offset: 10, namespace: 0 });
  assert.equal(param(search, 'list'), 'search');
  assert.equal(param(search, 'srsearch'), 'de jure');
  assert.equal(param(search, 'srlimit'), '5');
  assert.equal(param(search, 'sroffset'), '10');
  assert.equal(param(search, 'srnamespace'), '0');

  const open = openSearchUrl(BASE, API, { query: 'casus', limit: 5 });
  assert.equal(param(open, 'action'), 'opensearch');
  assert.equal(param(open, 'search'), 'casus');
  assert.equal(param(open, 'namespace'), '0', '默认在主条目里找');
  assert.equal(param(openSearchUrl(BASE, API, { query: 'x', namespace: '10' }), 'namespace'), '10');

  const sections = sectionsUrl(BASE, API, 'Titles');
  assert.equal(param(sections, 'prop'), 'sections');
  assert.equal(param(sections, 'page'), 'Titles');

  const text = pageTextUrl(BASE, API, { title: 'Titles', section: 2 });
  assert.equal(param(text, 'prop'), 'text|revid');
  assert.equal(param(text, 'section'), '2');
  assert.equal(param(text, 'disableeditsection'), '1');

  assert.equal(param(pageTextUrl(BASE, API, { title: 'Titles' }), 'section'), null);

  const wikitext = wikitextUrl(BASE, API, 'Titles');
  assert.equal(param(wikitext, 'prop'), 'revisions');
  assert.equal(param(wikitext, 'rvslots'), 'main');
  assert.equal(param(wikitext, 'redirects'), '1');

  // 按节取源码必须走 action=parse：prop=revisions 不认 section。
  const sectionSource = parseWikitextUrl(BASE, API, { title: 'Titles', section: 2 });
  assert.equal(param(sectionSource, 'action'), 'parse');
  assert.equal(param(sectionSource, 'page'), 'Titles');
  assert.equal(param(sectionSource, 'prop'), 'wikitext|revid');
  assert.equal(param(sectionSource, 'section'), '2');

  const info = pageInfoUrl(BASE, API, { title: 'Titles', categoryLimit: 50 });
  assert.equal(param(info, 'prop'), 'info|revisions|categories');
  assert.equal(param(info, 'inprop'), 'url|displaytitle');
  assert.equal(param(info, 'rvprop'), 'timestamp|user|comment|ids', '最后编辑要走 revisions，不能只看 touched');
  assert.equal(param(info, 'rvlimit'), '1');

  assert.equal(param(linksUrl(BASE, API, { title: 'Titles' }), 'prop'), 'links');
  assert.equal(param(backlinksUrl(BASE, API, { title: 'Titles' }), 'list'), 'backlinks');
  assert.equal(param(backlinksUrl(BASE, API, { title: 'Titles' }), 'prop'), 'info', '反链要带 missing 探测');

  const category = categoryMembersUrl(BASE, API, { category: 'Modding', limit: 30, type: 'page' });
  assert.equal(param(category, 'list'), 'categorymembers');
  assert.equal(param(category, 'cmtitle'), 'Category:Modding');
  assert.equal(param(category, 'cmtype'), 'page');
  assert.equal(param(category, 'prop'), 'info', '分类成员要带 missing 探测');

  const recent = recentChangesUrl(BASE, API, { limit: 20, days: 7, now: new Date('2026-10-01T00:00:00Z') });
  assert.equal(param(recent, 'list'), 'recentchanges');
  assert.equal(param(recent, 'rcstart'), '2026-10-01T00:00:00.000Z');
  assert.equal(param(recent, 'rcend'), '2026-09-24T00:00:00.000Z');
});

test('continue 原样透传成各自的游标参数', () => {
  assert.equal(param(linksUrl(BASE, API, { title: 'T', continue: 'War|0|0' }), 'plcontinue'), 'War|0|0');
  assert.equal(param(backlinksUrl(BASE, API, { title: 'T', continue: 'Traits|0' }), 'blcontinue'), 'Traits|0');
  assert.equal(param(categoryMembersUrl(BASE, API, { category: 'M', continue: 'next|abc' }), 'cmcontinue'), 'next|abc');
  assert.equal(param(recentChangesUrl(BASE, API, { continue: 'ts|1' }), 'rccontinue'), 'ts|1');
});

test('alignToCacheWindow 让 recent_changes 的 URL 在同一 TTL 窗口内稳定', () => {
  const aligned = alignToCacheWindow(1_790_000_123_456, 60_000);
  assert.equal(aligned.getTime() % 60_000, 0);
  // 同一分钟内的两个时刻必须落到同一个窗口；跨窗口则不同。
  assert.equal(alignToCacheWindow(1_790_000_120_000, 60_000).getTime(), alignToCacheWindow(1_790_000_150_000, 60_000).getTime());
  assert.notEqual(alignToCacheWindow(1_790_000_120_000, 60_000).getTime(), alignToCacheWindow(1_790_000_190_000, 60_000).getTime());
  // cacheTtlMs=0 时退回每分钟，仍然是稳定窗口。
  assert.equal(alignToCacheWindow(1_790_000_123_456, 0).getTime() % 60_000, 0);
  assert.equal(alignToCacheWindow(1_790_000_001_000, 0).getTime(), alignToCacheWindow(1_790_000_030_000, 0).getTime());
});

test('mapSiteInfo 取出站点与统计', () => {
  const info = mapSiteInfo(SITEINFO);
  assert.equal(info.sitename, 'CK3 Wiki');
  assert.equal(info.generator, 'MediaWiki 1.39.4');
  assert.equal(info.statistics.articles, 486);
});

test('mapSearch 归一命中数、翻页与条目', () => {
  const mapped = mapSearch(SEARCH);
  assert.equal(mapped.totalHits, 63);
  assert.equal(mapped.hasMore, true);
  assert.equal(mapped.offset, 3);
  assert.equal(mapped.items.length, 3);
  assert.equal(mapped.items[0].title, 'Innovation');
  assert.equal(mapped.items[2].ns, 10);
});

test('mapSearch 对空数据不抛错', () => {
  const mapped = mapSearch({});
  assert.deepEqual(mapped.items, []);
  assert.equal(mapped.totalHits, null);
  assert.equal(mapped.hasMore, false);
});

test('mapOpenSearch 按四元数组对齐', () => {
  const items = mapOpenSearch(OPENSEARCH);
  assert.equal(items.length, 2);
  assert.equal(items[1].title, 'Casus Belli (innovation)');
  assert.equal(items[1].url, 'https://ck3.paradoxwikis.com/Casus_Belli_(innovation)');
  assert.deepEqual(mapOpenSearch(null), []);
});

test('mapSections 取出索引、层级与标题', () => {
  const mapped = mapSections(SECTIONS);
  assert.equal(mapped.title, 'Titles');
  assert.equal(mapped.sections.length, 3);
  assert.equal(mapped.sections[1].index, '2');
  assert.equal(mapped.sections[1].line, 'Duchy');
  assert.equal(mapped.sections[1].toclevel, 2);
});

test('mapPageText 取出标题、revid 与 HTML', () => {
  const mapped = mapPageText(PAGE_TEXT);
  assert.equal(mapped.title, 'Casus belli');
  assert.equal(mapped.revid, 36426);
  assert.ok(mapped.html.includes('casus belli'));
});

test('mapWikitext 取源码、最后编辑与重定向来源', () => {
  const mapped = mapWikitext(WIKITEXT);
  assert.equal(mapped.found, true);
  assert.equal(mapped.title, 'Casus belli');
  assert.equal(mapped.user, 'Kami-sama');
  assert.equal(mapped.revid, 36426);
  assert.deepEqual(mapped.redirectFrom, ['Casus Belli']);
  assert.ok(mapped.content.includes("'''casus belli'''"));
});

test('mapWikitext 认得出不存在的页面', () => {
  const mapped = mapWikitext(PAGE_INFO_MISSING);
  assert.equal(mapped.found, false);
  assert.equal(mapped.content, '');
});

test('mapPageInfo 归一修订元数据、分类与 URL（不碰 touched）', () => {
  const info = mapPageInfo(PAGE_INFO);
  assert.equal(info.found, true);
  assert.equal(info.fullurl, 'https://ck3.paradoxwikis.com/Casus_belli');
  assert.deepEqual(info.categories, ['1.20', 'War']);
  assert.deepEqual(info.redirectFrom, ['Casus Belli']);
  // 最后编辑来自 revisions，不是 touched。
  assert.equal(info.revid, 36426);
  assert.equal(info.timestamp, '2026-09-30T13:45:54Z');
  assert.equal(info.user, 'Kami-sama');
  assert.equal(info.comment, '/* Uses */ add seize duchy');
  for (const dead of ['touched', 'pageprops', 'disambiguation', 'isRedirect', 'lastrevid']) {
    assert.equal(Object.hasOwn(info, dead), false, `死字段 ${dead} 应已删除`);
  }
});

test('mapPageInfo 对缺失页返回 found=false', () => {
  const info = mapPageInfo(PAGE_INFO_MISSING);
  assert.equal(info.found, false);
  assert.equal(info.missing, true);
});

test('mapParseWikitext 取按节源码与 revid', () => {
  const mapped = mapParseWikitext(PARSE_WIKITEXT);
  assert.equal(mapped.found, true);
  assert.equal(mapped.title, 'Casus belli');
  assert.equal(mapped.revid, 36426);
  assert.ok(mapped.wikitext.includes("'''casus belli'''"));
  assert.equal(mapParseWikitext({ parse: { title: 'X' } }).found, false);
});

test('mapNamespaces 认本地名、规范名与别名，并给出可列出的名字表', () => {
  const mapped = mapNamespaces(NAMESPACES);
  assert.equal(mapped.byName.get('template'), 10);
  assert.equal(mapped.byName.get('ck3 wiki'), 4, '本地项目名要能解析');
  assert.equal(mapped.byName.get('project'), 4, '规范名也要能解析');
  assert.equal(mapped.byName.get('image'), 6, '别名要能解析');
  assert.equal(mapped.byName.get('user talk'), undefined);
  assert.ok(mapped.describe.some((line) => line.includes('Template')), mapped.describe.join('、'));
  assert.equal(mapNamespaces({}).list.length, 0);
});

test('pageMissing 认出 prop=info 的 missing 标记', () => {
  assert.equal(pageMissing({ query: { pages: [{ missing: true }] } }), true);
  assert.equal(pageMissing({ query: { pages: [{ pageid: 1 }] } }), false);
  assert.equal(pageMissing({}), false);
});

test('mapLinks / mapBacklinks 归一链接', () => {
  const links = mapLinks(LINKS, 'Casus belli');
  assert.equal(links.found, true);
  assert.equal(links.links.length, 3);
  assert.equal(links.links[2].title, 'Template:Version');

  const backlinks = mapBacklinks(BACKLINKS);
  assert.equal(backlinks.length, 3);
  assert.equal(backlinks[2].redirect, true);
  assert.equal(backlinks[1].title, 'Traits');
});

test('mapCategoryMembers 归一类型与时间戳', () => {
  const items = mapCategoryMembers(CATEGORY_MEMBERS);
  assert.equal(items.length, 3);
  assert.equal(items[0].type, 'page');
  assert.equal(items[2].type, 'subcat');
});

test('mapRecentChanges 归一改动条目', () => {
  const items = mapRecentChanges(RECENT_CHANGES);
  assert.equal(items.length, 2);
  assert.equal(items[0].oldlen, 1139);
  assert.equal(items[0].newlen, 1184);
  assert.equal(items[1].type, 'new');
});
