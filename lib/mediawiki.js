/**
 * MediaWiki 数据层：**纯函数**。每个端点一个 URL 构造器 + 一个响应映射器。
 *
 * 设计约束：
 * - 全部走 `action=query` / `action=parse` / `action=opensearch` 的只读接口，`format=json`
 *   且固定 `formatversion=2`（`formatversion=2` 下 `pages` 是数组、布尔字段是真布尔值，
 *   映射器只按这一种形状写）。
 * - 参数一律用 `URLSearchParams` 拼，不手写查询串：标题里的 `&`、空格、非 ASCII 都交给它。
 * - 映射器对缺字段是宽容的：Wiki 是外部数据，少一个字段不该让工具抛错。
 *
 * 本模块不 import 任何东西，也不做网络 IO——所有 IO 在 `http.js`，工具层只做编排。
 *
 * @module dsh-ck3-wiki/mediawiki
 */

/** 中文语境下最好认的命名空间标签（id 取自本站 siteinfo 实测）。 */
const NAMESPACE_LABELS = new Map([
  [-2, 'Media'],
  [-1, 'Special'],
  [0, ''],
  [1, 'Talk'],
  [2, 'User'],
  [3, 'User talk'],
  [4, 'Project'],
  [5, 'Project talk'],
  [6, 'File'],
  [7, 'File talk'],
  [8, 'MediaWiki'],
  [9, 'MediaWiki talk'],
  [10, 'Template'],
  [11, 'Template talk'],
  [12, 'Help'],
  [13, 'Help talk'],
  [14, 'Category'],
  [15, 'Category talk'],
  [828, 'Module'],
  [829, 'Module talk'],
  [1198, 'Translations'],
  [1199, 'Translations talk'],
  [5140, 'Console'],
  [5141, 'Console talk'],
]);

/**
 * 命名空间的显示标签。
 * @param {number|undefined} ns - 命名空间 id。
 * @returns {string} 标签；未知 id 回退成 `ns<id>`，0 返回空串。
 */
export function namespaceLabel(ns) {
  if (ns === undefined || ns === null) return '';
  if (NAMESPACE_LABELS.has(ns)) return NAMESPACE_LABELS.get(ns) ?? '';
  return `ns${ns}`;
}

/**
 * 去掉 base URL 末尾的斜杠。
 * @param {string} base - 站点根 URL。
 * @returns {string} 归一后的根 URL。
 */
export function normalizeBase(base) {
  return String(base ?? '').trim().replace(/\/+$/, '');
}

/**
 * 归一 `apiPath`：保证以 `/` 开头。
 * @param {string} apiPath - 接口路径。
 * @returns {string} 归一后的路径。
 */
export function normalizeApiPath(apiPath) {
  const value = String(apiPath ?? '').trim();
  if (value === '') return '/api.php';
  return value.startsWith('/') ? value : `/${value}`;
}

/**
 * 拼一个 API URL。值为 `undefined` / `null` 的参数会被丢掉。
 * @param {string} base - 站点根 URL。
 * @param {string} apiPath - 接口路径。
 * @param {Record<string, string|number|boolean|undefined|null>} params - 查询参数。
 * @returns {string} 完整 URL。
 */
export function apiUrl(base, apiPath, params = {}) {
  const query = new URLSearchParams({ format: 'json', formatversion: '2' });
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    query.set(key, String(value));
  }
  return `${normalizeBase(base)}${normalizeApiPath(apiPath)}?${query.toString()}`;
}

/**
 * 文章页的规范 URL（站点 articlepath 是 `/$1`，空格写 `_`）。
 *
 * **按路径段编码**，并且把 `:` 还原成字面量——这两点是为了与站点自己的 `fullurl` 一致：
 * 实测 `Template:0/doc` 的规范 URL 是 `/Template:0/doc`，而整串 `encodeURIComponent`
 * 会给出 `/Template%3A0%2Fdoc`（`%2F` 在部分代理/服务器上还会被直接拒掉）。
 * `encodeURIComponent` 本来就不转义 `! ' ( ) * ~`，与 MediaWiki 的合法标题字符只差 `:`。
 * @param {string} base - 站点根 URL。
 * @param {string} title - 页面标题。
 * @returns {string} 文章 URL。
 */
export function pageUrl(base, title) {
  const encoded = String(title ?? '')
    .trim()
    .replace(/ /g, '_')
    .split('/')
    .map((segment) => encodeURIComponent(segment).replace(/%3A/gi, ':'))
    .join('/');
  return `${normalizeBase(base)}/${encoded}`;
}

/**
 * 补 `Category:` 前缀。
 * @param {string} category - 分类名（可带可不带前缀）。
 * @returns {string} 带前缀的分类标题。
 */
export function categoryTitle(category) {
  const value = String(category ?? '').trim().replace(/^Category:/i, '');
  return `Category:${value}`;
}

/** siteinfo：站点名、MW 版本、统计。 */
export function siteInfoUrl(base, apiPath) {
  return apiUrl(base, apiPath, { action: 'query', meta: 'siteinfo', siprop: 'general|statistics' });
}

/** 全文检索（CirrusSearch，支持 `incategory:` / `intitle:` / `prefix:` / `insource:`）。 */
export function searchUrl(base, apiPath, { query, limit, offset, namespace } = {}) {
  return apiUrl(base, apiPath, {
    action: 'query',
    list: 'search',
    srsearch: query,
    srlimit: limit,
    sroffset: offset,
    srnamespace: namespace,
    srprop: 'snippet|timestamp|wordcount|size',
    srinterwiki: '1',
  });
}

/** 标题前缀候选（opensearch）。 */
export function openSearchUrl(base, apiPath, { query, limit } = {}) {
  return apiUrl(base, apiPath, { action: 'opensearch', search: query, limit, namespace: '0', redirects: 'resolve' });
}

/** 页面目录（parse sections）。 */
export function sectionsUrl(base, apiPath, title) {
  return apiUrl(base, apiPath, { action: 'parse', page: title, prop: 'sections', redirects: '1' });
}

/** 页面渲染 HTML（parse text），可只取一节。 */
export function pageTextUrl(base, apiPath, { title, section } = {}) {
  return apiUrl(base, apiPath, {
    action: 'parse',
    page: title,
    prop: 'text|revid',
    section,
    redirects: '1',
    disabletoc: '1',
    disableeditsection: '1',
    disablelimitreport: '1',
  });
}

/** 页面原始 wikitext（query revisions）。 */
export function wikitextUrl(base, apiPath, title) {
  return apiUrl(base, apiPath, {
    action: 'query',
    titles: title,
    prop: 'revisions',
    rvslots: 'main',
    rvprop: 'content|ids|timestamp|user|comment',
    rvlimit: '1',
    redirects: '1',
  });
}

/** 页面元数据：pageid、字节数、最后编辑、分类、重定向与消歧义标记。 */
export function pageInfoUrl(base, apiPath, { title, categoryLimit } = {}) {
  return apiUrl(base, apiPath, {
    action: 'query',
    titles: title,
    prop: 'info|pageprops|categories',
    inprop: 'url|displaytitle',
    cllimit: categoryLimit,
    clprop: 'timestamp|sortkey',
    redirects: '1',
  });
}

/** 页面出链（prop=links）。 */
export function linksUrl(base, apiPath, { title, limit, namespace } = {}) {
  return apiUrl(base, apiPath, {
    action: 'query',
    titles: title,
    prop: 'links',
    pllimit: limit,
    plnamespace: namespace,
    redirects: '1',
  });
}

/** 页面反向链接（list=backlinks）。 */
export function backlinksUrl(base, apiPath, { title, limit, namespace } = {}) {
  return apiUrl(base, apiPath, {
    action: 'query',
    list: 'backlinks',
    bltitle: title,
    bllimit: limit,
    blnamespace: namespace,
    blredirect: '1',
  });
}

/** 分类成员（list=categorymembers）。 */
export function categoryMembersUrl(base, apiPath, { category, limit, type } = {}) {
  return apiUrl(base, apiPath, {
    action: 'query',
    list: 'categorymembers',
    cmtitle: categoryTitle(category),
    cmlimit: limit,
    cmtype: type,
    cmprop: 'ids|title|type|timestamp',
  });
}

/**
 * 最近改动（list=recentchanges）。
 *
 * MediaWiki 没有「最近 N 天」参数，这里换算成 `rcstart`/`rcend` 两个时间戳：
 * `rcend` 越早越旧，`rcstart` 是较新的一端。
 * @param {string} base - 站点根 URL。
 * @param {string} apiPath - 接口路径。
 * @param {{ limit?: number, namespace?: number|string, days?: number, now?: Date }} [options] 参数。
 * @returns {string} 完整 URL。
 */
export function recentChangesUrl(base, apiPath, { limit, namespace, days = 7, now } = {}) {
  const end = now instanceof Date ? now : new Date();
  const start = new Date(end.getTime() - Math.max(1, Number(days) || 7) * 86_400_000);
  return apiUrl(base, apiPath, {
    action: 'query',
    list: 'recentchanges',
    rclimit: limit,
    rcnamespace: namespace,
    rcprop: 'title|ids|sizes|flags|user|comment|timestamp',
    rctype: 'edit|new',
    rcstart: end.toISOString(),
    rcend: start.toISOString(),
  });
}

/**
 * `prop=info` 响应里的第一页。
 * @param {any} data - 解析后的 JSON。
 * @returns {any|undefined} 页面对象。
 */
function firstPage(data) {
  return data?.query?.pages?.[0];
}

/**
 * 把 `query.redirects` 里「谁重定向到了这个标题」找出来。
 * @param {any} data - 解析后的 JSON。
 * @param {string} resolvedTitle - 解析后的最终标题。
 * @returns {string[]} 重定向来源标题。
 */
function redirectSources(data, resolvedTitle) {
  const list = data?.query?.redirects;
  if (!Array.isArray(list)) return [];
  return list.filter((entry) => entry?.to === resolvedTitle).map((entry) => String(entry.from));
}

/**
 * 站点信息与统计。
 * @param {any} data - 解析后的 JSON。
 * @returns {{ sitename: string, generator: string, server: string, articlepath: string, lang: string,
 *   mainpage: string, statistics: Record<string, number> }} 站点概况。
 */
export function mapSiteInfo(data) {
  const general = data?.query?.general ?? {};
  const statistics = data?.query?.statistics ?? {};
  return {
    sitename: String(general.sitename ?? ''),
    generator: String(general.generator ?? ''),
    server: String(general.server ?? ''),
    articlepath: String(general.articlepath ?? ''),
    lang: String(general.lang ?? ''),
    mainpage: String(general.mainpage ?? ''),
    statistics,
  };
}

/**
 * 检索结果。
 * @param {any} data - 解析后的 JSON。
 * @returns {{ totalHits: number|null, hasMore: boolean, offset: number|null,
 *   items: Array<{ ns: number, title: string, pageid?: number, size?: number, wordcount?: number,
 *     timestamp?: string, snippet: string }> }} 归一结果。
 */
export function mapSearch(data) {
  const info = data?.query?.searchinfo ?? {};
  const items = Array.isArray(data?.query?.search) ? data.query.search : [];
  const nextOffset = data?.continue?.sroffset;
  return {
    totalHits: typeof info.totalhits === 'number' ? info.totalhits : null,
    hasMore: nextOffset !== undefined,
    offset: typeof nextOffset === 'number' ? nextOffset : null,
    items: items.map((item) => ({
      ns: Number(item.ns ?? 0),
      title: String(item.title ?? ''),
      pageid: typeof item.pageid === 'number' ? item.pageid : undefined,
      size: typeof item.size === 'number' ? item.size : undefined,
      wordcount: typeof item.wordcount === 'number' ? item.wordcount : undefined,
      timestamp: typeof item.timestamp === 'string' ? item.timestamp : undefined,
      snippet: String(item.snippet ?? ''),
    })),
  };
}

/**
 * opensearch 候选：响应是 `[查询词, 标题[], 描述[], URL[]]` 的四元数组。
 * @param {any} data - 解析后的 JSON。
 * @returns {Array<{ title: string, description: string, url: string }>} 候选列表。
 */
export function mapOpenSearch(data) {
  if (!Array.isArray(data)) return [];
  const titles = Array.isArray(data[1]) ? data[1] : [];
  const descriptions = Array.isArray(data[2]) ? data[2] : [];
  const urls = Array.isArray(data[3]) ? data[3] : [];
  return titles.map((title, index) => ({
    title: String(title),
    description: String(descriptions[index] ?? ''),
    url: String(urls[index] ?? ''),
  }));
}

/**
 * 页面目录。
 * @param {any} data - 解析后的 JSON。
 * @returns {{ title: string, pageid?: number, sections: Array<{ index: string, level: string,
 *   number: string, line: string, anchor: string }> }} 目录。
 */
export function mapSections(data) {
  const parse = data?.parse ?? {};
  const sections = Array.isArray(parse.sections) ? parse.sections : [];
  return {
    title: String(parse.title ?? ''),
    pageid: typeof parse.pageid === 'number' ? parse.pageid : undefined,
    sections: sections.map((section) => ({
      index: String(section.index ?? ''),
      level: String(section.level ?? ''),
      number: String(section.number ?? ''),
      line: String(section.line ?? ''),
      anchor: String(section.anchor ?? ''),
      toclevel: Number(section.toclevel ?? 0),
    })),
  };
}

/**
 * `action=parse&prop=text` 的结果。
 * @param {any} data - 解析后的 JSON。
 * @returns {{ title: string, pageid?: number, revid?: number, html: string }} 结果。
 */
export function mapPageText(data) {
  const parse = data?.parse ?? {};
  return {
    title: String(parse.title ?? ''),
    pageid: typeof parse.pageid === 'number' ? parse.pageid : undefined,
    revid: typeof parse.revid === 'number' ? parse.revid : undefined,
    html: typeof parse.text === 'string' ? parse.text : '',
  };
}

/**
 * 原始 wikitext。
 * @param {any} data - 解析后的 JSON。
 * @returns {{ found: boolean, title: string, pageid?: number, ns?: number, revid?: number,
 *   timestamp?: string, user?: string, comment?: string, content: string, redirectFrom: string[] }} 结果。
 */
export function mapWikitext(data) {
  const page = firstPage(data) ?? {};
  const revision = page.revisions?.[0] ?? {};
  const title = String(page.title ?? '');
  return {
    found: page.missing !== true && typeof page.pageid === 'number',
    title,
    pageid: typeof page.pageid === 'number' ? page.pageid : undefined,
    ns: typeof page.ns === 'number' ? page.ns : undefined,
    revid: typeof revision.revid === 'number' ? revision.revid : undefined,
    timestamp: typeof revision.timestamp === 'string' ? revision.timestamp : undefined,
    user: typeof revision.user === 'string' ? revision.user : undefined,
    comment: typeof revision.comment === 'string' ? revision.comment : undefined,
    content: typeof revision.slots?.main?.content === 'string' ? revision.slots.main.content : '',
    redirectFrom: redirectSources(data, title),
  };
}

/**
 * 页面元数据。
 * @param {any} data - 解析后的 JSON。
 * @returns {{ found: boolean, title: string, missing?: boolean, pageid?: number, ns?: number,
 *   length?: number, touched?: string, lastrevid?: number, fullurl?: string, displaytitle?: string,
 *   redirectFrom: string[], isRedirect: boolean, disambiguation: boolean, categories: string[],
 *   pageprops: Record<string, unknown> }} 结果。
 */
export function mapPageInfo(data) {
  const page = firstPage(data) ?? {};
  const title = String(page.title ?? '');
  const pageprops = page.pageprops && typeof page.pageprops === 'object' ? page.pageprops : {};
  const categories = Array.isArray(page.categories)
    ? page.categories.map((entry) => String(entry.title ?? '').replace(/^Category:/, '')).filter((name) => name !== '')
    : [];
  return {
    found: page.missing !== true && typeof page.pageid === 'number',
    title,
    missing: page.missing === true,
    pageid: typeof page.pageid === 'number' ? page.pageid : undefined,
    ns: typeof page.ns === 'number' ? page.ns : undefined,
    length: typeof page.length === 'number' ? page.length : undefined,
    touched: typeof page.touched === 'string' ? page.touched : undefined,
    lastrevid: typeof page.lastrevid === 'number' ? page.lastrevid : undefined,
    fullurl: typeof page.fullurl === 'string' ? page.fullurl : undefined,
    displaytitle: typeof page.displaytitle === 'string' ? page.displaytitle : undefined,
    redirectFrom: redirectSources(data, title),
    isRedirect: typeof page.redirect === 'string' || page.redirect === true,
    disambiguation: Object.hasOwn(pageprops, 'disambiguation'),
    categories,
    pageprops,
  };
}

/**
 * 出链（prop=links）。
 * @param {any} data - 解析后的 JSON。
 * @param {string} requestedTitle - 调用方给的标题（用于在响应里找回对应页面）。
 * @returns {{ found: boolean, title: string, links: Array<{ ns: number, title: string }> }} 结果。
 */
export function mapLinks(data, requestedTitle = '') {
  const pages = Array.isArray(data?.query?.pages) ? data.query.pages : [];
  const page = pages.find((entry) => entry?.title === requestedTitle) ?? pages[0] ?? {};
  const links = Array.isArray(page.links) ? page.links : [];
  return {
    found: page.missing !== true && typeof page.pageid === 'number',
    title: String(page.title ?? ''),
    links: links.map((link) => ({ ns: Number(link.ns ?? 0), title: String(link.title ?? '') })),
  };
}

/**
 * 反向链接（list=backlinks）。
 * @param {any} data - 解析后的 JSON。
 * @returns {Array<{ pageid?: number, ns: number, title: string, redirect: boolean }>} 结果。
 */
export function mapBacklinks(data) {
  const items = Array.isArray(data?.query?.backlinks) ? data.query.backlinks : [];
  return items.map((item) => ({
    pageid: typeof item.pageid === 'number' ? item.pageid : undefined,
    ns: Number(item.ns ?? 0),
    title: String(item.title ?? ''),
    redirect: item.redirect === true,
  }));
}

/**
 * 分类成员。
 * @param {any} data - 解析后的 JSON。
 * @returns {Array<{ pageid?: number, ns: number, title: string, type: string, timestamp?: string }>} 结果。
 */
export function mapCategoryMembers(data) {
  const items = Array.isArray(data?.query?.categorymembers) ? data.query.categorymembers : [];
  return items.map((item) => ({
    pageid: typeof item.pageid === 'number' ? item.pageid : undefined,
    ns: Number(item.ns ?? 0),
    title: String(item.title ?? ''),
    type: String(item.type ?? (item.ns === 14 ? 'subcat' : item.ns === 6 ? 'file' : 'page')),
    timestamp: typeof item.timestamp === 'string' ? item.timestamp : undefined,
  }));
}

/**
 * 最近改动。
 * @param {any} data - 解析后的 JSON。
 * @returns {Array<{ type: string, ns: number, title: string, user: string, timestamp: string,
 *   comment: string, oldlen?: number, newlen?: number, revid?: number, redirect: boolean }>} 结果。
 */
export function mapRecentChanges(data) {
  const items = Array.isArray(data?.query?.recentchanges) ? data.query.recentchanges : [];
  return items.map((item) => ({
    type: String(item.type ?? 'edit'),
    ns: Number(item.ns ?? 0),
    title: String(item.title ?? ''),
    user: String(item.user ?? ''),
    timestamp: String(item.timestamp ?? ''),
    comment: String(item.comment ?? ''),
    oldlen: typeof item.oldlen === 'number' ? item.oldlen : undefined,
    newlen: typeof item.newlen === 'number' ? item.newlen : undefined,
    revid: typeof item.revid === 'number' ? item.revid : undefined,
    redirect: item.redirect === true,
  }));
}

/**
 * 把 `dates` 里的时间戳按「最新在前」排好再截断（recentchanges 已排序，这里只是保险）。
 * @param {Array<{ timestamp: string }>} items - 带时间戳的条目。
 * @param {number} limit - 上限。
 * @returns {Array<object>} 截断后的条目。
 */
export function takeNewest(items, limit) {
  const sorted = [...items].sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
  return sorted.slice(0, limit);
}
