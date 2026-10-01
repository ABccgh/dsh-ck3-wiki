/**
 * URL 构造器与响应映射器的单元测试（离线，不联网）。
 *
 * 断言的是「接口契约」：参数怎么进 URL、响应怎么变成工具要用的形状。
 * 真实响应形状见 test/fixtures/fixtures.js（取自 2026-10-01 的实测）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  apiUrl,
  backlinksUrl,
  categoryMembersUrl,
  categoryTitle,
  linksUrl,
  mapBacklinks,
  mapCategoryMembers,
  mapLinks,
  mapOpenSearch,
  mapPageInfo,
  mapPageText,
  mapRecentChanges,
  mapSearch,
  mapSections,
  mapSiteInfo,
  mapWikitext,
  namespaceLabel,
  normalizeApiPath,
  openSearchUrl,
  pageInfoUrl,
  pageTextUrl,
  pageUrl,
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
  OPENSEARCH,
  PAGE_INFO,
  PAGE_INFO_MISSING,
  PAGE_TEXT,
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

  const info = pageInfoUrl(BASE, API, { title: 'Titles', categoryLimit: 50 });
  assert.equal(param(info, 'prop'), 'info|pageprops|categories');
  assert.equal(param(info, 'inprop'), 'url|displaytitle');

  assert.equal(param(linksUrl(BASE, API, { title: 'Titles' }), 'prop'), 'links');
  assert.equal(param(backlinksUrl(BASE, API, { title: 'Titles' }), 'list'), 'backlinks');

  const category = categoryMembersUrl(BASE, API, { category: 'Modding', limit: 30, type: 'page' });
  assert.equal(param(category, 'list'), 'categorymembers');
  assert.equal(param(category, 'cmtitle'), 'Category:Modding');
  assert.equal(param(category, 'cmtype'), 'page');

  const recent = recentChangesUrl(BASE, API, { limit: 20, days: 7, now: new Date('2026-10-01T00:00:00Z') });
  assert.equal(param(recent, 'list'), 'recentchanges');
  assert.equal(param(recent, 'rcstart'), '2026-10-01T00:00:00.000Z');
  assert.equal(param(recent, 'rcend'), '2026-09-24T00:00:00.000Z');
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

test('mapPageInfo 归一分类、消歧义与 URL', () => {
  const info = mapPageInfo(PAGE_INFO);
  assert.equal(info.found, true);
  assert.equal(info.disambiguation, true);
  assert.equal(info.fullurl, 'https://ck3.paradoxwikis.com/Casus_belli');
  assert.deepEqual(info.categories, ['1.20', 'War']);
  assert.deepEqual(info.redirectFrom, ['Casus Belli']);
});

test('mapPageInfo 对缺失页返回 found=false', () => {
  const info = mapPageInfo(PAGE_INFO_MISSING);
  assert.equal(info.found, false);
  assert.equal(info.missing, true);
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
