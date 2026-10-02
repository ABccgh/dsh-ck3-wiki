/**
 * 发现类工具：站点自检（`ck3wiki_status`）、全文检索（`ck3wiki_search`）、
 * 标题候选（`ck3wiki_titles`）。
 *
 * @module dsh-ck3-wiki/tools/discovery
 */

import { mapOpenSearch, mapSearch, mapSiteInfo, namespaceLabel, openSearchUrl, searchUrl, siteInfoUrl } from '../mediawiki.js';
import { cleanSnippet, stripTags } from '../html-text.js';
import { systemCaStatus } from '../http.js';
import { defineTool } from '../tool-kit.js';
import { TEXT_OUTPUT, alwaysSafe, apiErrorText, clampInt, clampLimit, formatAge, header, listTail, namespaceParam, requireText, unwrap } from './shared.js';

/**
 * 注册 3 个发现类工具。
 * @param {{ tools: { register: Function } }} ctx - 插件上下文。
 * @param {Record<string, any>} config - 生效配置。
 * @param {{ reader: { read: Function, stats: Function }, state: Record<string, any> }} deps - 依赖。
 * @returns {string[]} 已注册的工具名。
 */
export function registerDiscoveryTools(ctx, config, deps) {
  const { reader, state } = deps;

  ctx.tools.register(
    defineTool({
      name: 'ck3wiki_status',
      description:
        '检查 CK3 官方 Wiki（ck3.paradoxwikis.com）的连通性与站点概况：站点名、MediaWiki 版本、接口地址、'
        + '页面统计、当前 User-Agent、缓存与证书状态。任何 wiki 工具报错时先调它定位问题。只读，不需要密钥。',
      parameters: {
        fresh: { type: 'boolean', description: '为 true 时绕过缓存，强制访问一次线上接口（默认 false）。' },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: alwaysSafe,
      async execute(args, exec) {
        const url = siteInfoUrl(config.wikiBaseUrl, config.apiPath);
        const result = await reader.read(url, { signal: exec.signal, fresh: args.fresh === true });
        state.lastProbe = {
          at: new Date().toISOString(),
          ok: result?.ok === true,
          via: result?.via,
          error: result?.ok === true ? undefined : result?.error,
          challenge: result?.challenge === true,
        };
        const ca = systemCaStatus();
        const stats = reader.stats();
        const configLines = [
          `配置：wikiBaseUrl=${config.wikiBaseUrl}，maxChars=${config.maxChars}，maxListedItems=${config.maxListedItems}，`
          + `超时 ${config.requestTimeoutMs} ms，缓存 TTL ${config.cacheTtlMs} ms，webFallback=${config.webFallback ? 'on' : 'off'}`,
          `User-Agent：${config.userAgent}`,
          `系统 CA：${ca.merged ? `已并入（+${ca.added}，共 ${ca.total}）` : `未合并${ca.error === undefined ? '（遇到证书错误才会合并）' : `（失败：${ca.error}）`}`}`,
          `缓存：命中 ${stats.hits} / 未命中 ${stats.misses}，当前 ${stats.size} 条`,
        ];

        if (result?.ok !== true) {
          return {
            text: [
              'CK3 Wiki 连通失败。',
              result?.error ?? '未知错误',
              typeof result?.hint === 'string' && result.hint !== '' ? `建议：${result.hint}` : '',
              ...configLines,
            ].filter((line) => line !== '').join('\n'),
          };
        }

        // HTTP 通了，但接口自己报错（参数写错、站点被改配置…）也要如实说。
        const rejected = apiErrorText(result.data, '读取站点信息');
        if (rejected !== '') {
          return { text: [rejected, `接口：${url}`, ...configLines].join('\n') };
        }

        const info = mapSiteInfo(result.data);
        const s = info.statistics ?? {};
        const number = (value) => (typeof value === 'number' ? String(value) : '-');
        return {
          text: [
            'CK3 Wiki 连通正常。',
            `站点：${info.sitename}（${info.generator}），语言 ${info.lang}，首页「${info.mainpage}」`,
            `接口：${url}`,
            `通道：${result.via === 'dsh-web' ? 'DSH web 服务兜底' : '直连'}`,
            `统计：页面 ${number(s.pages)}，条目 ${number(s.articles)}，编辑 ${number(s.edits)}，`
            + `文件 ${number(s.images)}，用户 ${number(s.users)}，活跃用户 ${number(s.activeusers)}`,
            ...configLines,
          ].join('\n'),
        };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'ck3wiki_search',
      description:
        '在 CK3 官方 Wiki 做全文检索（CirrusSearch）。返回标题、pageid、字节数、最后编辑时间与命中片段。'
        + '查询支持站内高级语法：incategory:"Modding"、intitle:modding、prefix:Modding、insource:"de jure"。'
        + '想读正文用 ck3wiki_page。只读。',
      parameters: {
        query: { type: 'string', required: true, description: '检索词，可含 CirrusSearch 语法，例如 incategory:Modding trait。' },
        limit: { type: 'integer', description: `最多返回多少条，默认 10，上限 ${config.maxListedItems}。` },
        namespace: { type: 'string', description: '命名空间 id 或名字，默认 0（主条目）；传 * 表示全部。' },
        offset: { type: 'integer', description: '从第几条开始（翻页用），默认 0。' },
        fresh: { type: 'boolean', description: '为 true 时绕过缓存。' },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: alwaysSafe,
      async execute(args, exec) {
        const query = requireText(args.query, 'query');
        const limit = clampLimit(args.limit, 10, config.maxListedItems);
        const offset = Math.max(0, clampInt(args.offset, 0));
        const ns = namespaceParam(args.namespace, 0);
        const url = searchUrl(config.wikiBaseUrl, config.apiPath, { query, limit, offset, namespace: ns });
        const data = unwrap(await reader.read(url, { signal: exec.signal, fresh: args.fresh === true }), '检索');
        const rejectedSearch = apiErrorText(data, '检索');
        if (rejectedSearch !== '') return { text: `${rejectedSearch}\n请求：${url}` };
        const mapped = mapSearch(data);

        if (mapped.items.length === 0) {
          return {
            text: [
              `检索「${query}」没有命中（命名空间 ${ns}）。`,
              '可试：换关键词、把 namespace 传 * 搜全部命名空间，或用 incategory:/intitle:/prefix: 这类限定语法。',
              `请求：${url}`,
            ].join('\n'),
          };
        }

        const lines = mapped.items.map((item, index) => {
          const meta = [
            item.pageid === undefined ? '' : `pageid ${item.pageid}`,
            item.size === undefined ? '' : `${item.size} 字节`,
            item.timestamp === undefined ? '' : formatAge(item.timestamp),
          ].filter((part) => part !== '').join('，');
          const nsLabel = namespaceLabel(item.ns);
          const snippet = cleanSnippet(item.snippet);
          return `${offset + index + 1}. ${nsLabel === '' ? '' : `${nsLabel}:`}${item.title}${meta === '' ? '' : `（${meta}）`}`
            + `${snippet === '' ? '' : `\n   ${snippet}`}`;
        });
        const nextOffset = mapped.offset ?? offset + mapped.items.length;
        return {
          text: `检索「${query}」：${mapped.totalHits === null ? '' : `共 ${mapped.totalHits} 条命中，`}`
            + `本次 ${mapped.items.length} 条（命名空间 ${ns}）\n`
            + lines.join('\n')
            + listTail(mapped.items.length, null, '条', mapped.hasMore ? `下一页用 offset=${nextOffset}` : '已到末尾'),
        };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'ck3wiki_titles',
      description:
        '按前缀猜页面标题（MediaWiki opensearch）：标题不确定、或搜不到时用它把名字对准，再交给 ck3wiki_page。'
        + '返回标题与规范 URL。只读。',
      parameters: {
        query: { type: 'string', required: true, description: '标题前缀，例如 "casus" 或 "Modding"。' },
        limit: { type: 'integer', description: '最多返回多少条，默认 10，上限 20。' },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: alwaysSafe,
      async execute(args, exec) {
        const query = requireText(args.query, 'query');
        const limit = clampLimit(args.limit, 10, 20);
        const url = openSearchUrl(config.wikiBaseUrl, config.apiPath, { query, limit });
        const data = unwrap(await reader.read(url, { signal: exec.signal }), '标题候选');
        const rejectedTitles = apiErrorText(data, '标题候选');
        if (rejectedTitles !== '') return { text: rejectedTitles };
        const items = mapOpenSearch(data);
        if (items.length === 0) return { text: `没有以「${query}」开头的页面标题。` };
        return {
          text: `${header([`标题候选「${query}」（${items.length} 条）`])}`
            + items.map((item, index) => `${index + 1}. ${item.title}${item.description === '' ? '' : ` — ${stripTags(item.description)}`}\n   ${item.url}`).join('\n'),
        };
      },
    }),
  );

  return ['ck3wiki_status', 'ck3wiki_search', 'ck3wiki_titles'];
}
