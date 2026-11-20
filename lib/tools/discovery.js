/**
 * 发现类工具：站点自检（`ck3wiki_status`）、全文检索（`ck3wiki_search`）、
 * 标题候选（`ck3wiki_titles`）。
 *
 * 共同约定：
 * - 命名空间参数先用 `siteinfo` 解析成数字 id——MediaWiki 只认数字，名字会被静默忽略；
 * - 接口返回 `warnings` 时如实带出来，避免「过滤没生效」被伪装成空结果；
 * - 每次请求都支持 `fresh: true` 绕过 TTL 缓存。
 *
 * @module dsh-ck3-wiki/tools/discovery
 */

import { mapOpenSearch, mapSearch, mapSiteInfo, openSearchUrl, searchUrl, siteInfoUrl } from '../mediawiki.js';
import { cleanSnippet, stripTags } from '../html-text.js';
import { systemCaStatus } from '../http.js';
import { defineTool } from '../tool-kit.js';
import {
  TEXT_OUTPUT, TOOL_TIMEOUT_MS, alwaysSafe, apiErrorText, apiWarningText, clampInt, clampLimit,
  createNamespaceResolver, formatAge, header, listTail, listedCap, requireText, unwrap,
} from './shared.js';

/**
 * 注册 3 个发现类工具。
 * @param {{ tools: { register: Function } }} ctx - 插件上下文。
 * @param {Record<string, any>} config - 生效配置。
 * @param {{ reader: { read: Function, stats: Function } }} deps - 依赖。
 * @returns {string[]} 已注册的工具名。
 */
export function registerDiscoveryTools(ctx, config, deps) {
  const { reader } = deps;
  const namespaces = createNamespaceResolver(reader, config);
  const maxTitles = listedCap(config, 20);

  ctx.tools.register(
    defineTool({
      name: 'ck3wiki_status',
      description:
        '检查 CK3 官方 Wiki（ck3.paradoxwikis.com）的连通性与站点概况：站点名、MediaWiki 版本、接口地址、'
        + '页面统计、当前 User-Agent、缓存与证书状态。任何 wiki 工具报错时先调它定位问题。',
      parameters: {
        fresh: { type: 'boolean', description: '为 true 时绕过 TTL 缓存，强制访问一次线上接口（默认 false）。' },
        verbose: { type: 'boolean', description: '为 true 时额外输出超时/maxChars/maxListedItems/cacheTtlMs 等静态配置与累计缓存计数（默认 false）。' },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: alwaysSafe,
      timeoutMs: TOOL_TIMEOUT_MS,
      async execute(args, exec) {
        const url = siteInfoUrl(config.wikiBaseUrl, config.apiPath);
        const result = await reader.read(url, { signal: exec.signal, fresh: args.fresh === true });
        const ca = systemCaStatus();
        const stats = reader.stats();
        // 静态配置与累计计数只在 verbose 时输出：默认输出保持精简，先给「通不通、是什么站」。
        const verboseLines = args.verbose === true
          ? [
            `配置：requestTimeoutMs=${config.requestTimeoutMs}，maxChars=${config.maxChars}，maxListedItems=${config.maxListedItems}，cacheTtlMs=${config.cacheTtlMs}`,
            `缓存计数：命中 ${stats.hits} / 未命中 ${stats.misses}，当前 ${stats.size} 条`,
          ]
          : [];
        const baseLines = [
          `接口：${url}`,
          `通道：${result?.via === 'dsh-web' ? 'DSH web 服务兜底' : '直连'}（webFallback=${config.webFallback ? 'on' : 'off'}）`,
          `User-Agent：${config.userAgent}`,
          `系统 CA：${ca.merged ? `已并入（+${ca.added}，共 ${ca.total}）` : `未合并${ca.error === undefined ? '（遇到证书错误才会合并）' : `（失败：${ca.error}）`}`}`,
          `缓存：${config.cacheTtlMs > 0 ? '开启' : '关闭'}`,
          ...verboseLines,
        ];

        if (result?.ok !== true) {
          return {
            text: [
              'CK3 Wiki 连通失败。',
              result?.error ?? '未知错误',
              typeof result?.hint === 'string' && result.hint !== '' ? `建议：${result.hint}` : '',
              ...baseLines,
            ].filter((line) => line !== '').join('\n'),
          };
        }

        // HTTP 通了，但接口自己报错（参数写错、站点被改配置…）也要如实说。
        const rejected = apiErrorText(result.data, '读取站点信息');
        if (rejected !== '') {
          return { text: [rejected, ...baseLines].join('\n') };
        }

        const info = mapSiteInfo(result.data);
        const s = info.statistics ?? {};
        const number = (value) => (typeof value === 'number' ? String(value) : '-');
        return {
          text: [
            'CK3 Wiki 连通正常。',
            `站点：${info.sitename}（${info.generator}），语言 ${info.lang}，首页「${info.mainpage}」`,
            ...baseLines,
            `统计：页面 ${number(s.pages)}，条目 ${number(s.articles)}，编辑 ${number(s.edits)}，`
            + `文件 ${number(s.images)}，用户 ${number(s.users)}，活跃用户 ${number(s.activeusers)}`,
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
        + '想读正文用 ck3wiki_page。',
      parameters: {
        query: { type: 'string', required: true, description: '检索词。支持 CirrusSearch 语法，例如 incategory:"Modding"、intitle:modding、prefix:Modding、insource:"de jure"。' },
        limit: { type: 'integer', description: `最多返回多少条，默认 10，上限 ${config.maxListedItems}。` },
        namespace: { type: 'string', description: '命名空间 id 或名字，默认 0（主条目）；传 * 表示全部。' },
        offset: { type: 'integer', description: '从第几条开始（翻页用），默认 0。' },
        fresh: { type: 'boolean', description: '为 true 时绕过 TTL 缓存重取。' },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: alwaysSafe,
      timeoutMs: TOOL_TIMEOUT_MS,
      async execute(args, exec) {
        const query = requireText(args.query, 'query');
        const limit = clampLimit(args.limit, 10, config.maxListedItems);
        const offset = Math.max(0, clampInt(args.offset, 0));
        const ns = await namespaces.resolve(args.namespace, 0, { signal: exec.signal });
        const url = searchUrl(config.wikiBaseUrl, config.apiPath, { query, limit, offset, namespace: ns });
        const data = unwrap(await reader.read(url, { signal: exec.signal, fresh: args.fresh === true }), '检索');
        const rejectedSearch = apiErrorText(data, '检索');
        if (rejectedSearch !== '') return { text: `${rejectedSearch}\n请求：${url}` };
        const warning = apiWarningText(data, '检索');
        const mapped = mapSearch(data);

        if (mapped.items.length === 0) {
          // offset 越界与「真的没有命中」是两件事：前者是翻页翻过了头，别让模型以为查询词没救。
          const total = mapped.totalHits;
          const lines = offset > 0
            ? [
              total === null
                ? `检索「${query}」从 offset=${offset} 起没有更多命中（可能已超出末尾）。`
                : `offset=${offset} 超出命中范围：检索「${query}」共 ${total} 条命中（offset 从 0 开始）。`,
              '用 offset=0 从头看，或换关键词；也可以换 namespace。',
              `请求：${url}`,
            ]
            : [
              `检索「${query}」没有命中（命名空间 ${ns}）。`,
              '可试：换关键词、把 namespace 传 * 搜全部命名空间，或用 incategory:/intitle:/prefix: 这类限定语法。',
              `请求：${url}`,
            ];
          if (warning !== '') lines.push(warning);
          return { text: lines.join('\n') };
        }

        const lines = mapped.items.map((item, index) => {
          const meta = [
            item.pageid === undefined ? '' : `pageid ${item.pageid}`,
            item.size === undefined ? '' : `${item.size} 字节`,
            item.timestamp === undefined ? '' : formatAge(item.timestamp),
          ].filter((part) => part !== '').join('，');
          const snippet = cleanSnippet(item.snippet);
          // 标题原样打印：CirrusSearch 的 title 已带本地化命名空间前缀（`Template:X`），
          // 再按 ns 拼一次会变成 `Template:Template:X`。
          return `${offset + index + 1}. ${item.title}${meta === '' ? '' : `（${meta}）`}`
            + `${snippet === '' ? '' : `\n   ${snippet}`}`;
        });
        const nextOffset = mapped.offset ?? offset + mapped.items.length;
        return {
          text: `检索「${query}」：${mapped.totalHits === null ? '' : `共 ${mapped.totalHits} 条命中，`}`
            + `本次 ${mapped.items.length} 条（命名空间 ${ns}）\n`
            + lines.join('\n')
            + listTail(mapped.items.length, null, '条', mapped.hasMore ? `下一页用 offset=${nextOffset}` : '已到末尾')
            + (warning === '' ? '' : `\n${warning}`),
        };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'ck3wiki_titles',
      description:
        '按前缀猜页面标题（MediaWiki opensearch）：标题不确定、或搜不到时用它把名字对准，再交给 ck3wiki_page。'
        + '返回标题与规范 URL。',
      parameters: {
        query: { type: 'string', required: true, description: '标题前缀，例如 "casus" 或 "Modding"。' },
        limit: { type: 'integer', description: `最多返回多少条，默认 10，上限 ${maxTitles}。` },
        namespace: { type: 'string', description: '在哪个命名空间里找：id 或名字，默认 0（主条目）；传 * 表示全部。' },
        fresh: { type: 'boolean', description: '为 true 时绕过 TTL 缓存重取。' },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: alwaysSafe,
      timeoutMs: TOOL_TIMEOUT_MS,
      async execute(args, exec) {
        const query = requireText(args.query, 'query');
        const limit = clampLimit(args.limit, 10, maxTitles);
        const ns = await namespaces.resolve(args.namespace, 0, { signal: exec.signal });
        const url = openSearchUrl(config.wikiBaseUrl, config.apiPath, { query, limit, namespace: ns });
        const data = unwrap(await reader.read(url, { signal: exec.signal, fresh: args.fresh === true }), '标题候选');
        const rejectedTitles = apiErrorText(data, '标题候选');
        if (rejectedTitles !== '') return { text: rejectedTitles };
        const warning = apiWarningText(data, '标题候选');
        const items = mapOpenSearch(data);
        if (items.length === 0) {
          return {
            text: [
              `没有以「${query}」开头的页面标题（命名空间 ${ns}）。`,
              '可把 namespace 传 * 搜全部命名空间，或缩短前缀。',
              warning,
            ].filter((line) => line !== '').join('\n'),
          };
        }
        return {
          text: `${header([`标题候选「${query}」（${items.length} 条，命名空间 ${ns}）`])}`
            + items.map((item, index) => `${index + 1}. ${item.title}${item.description === '' ? '' : ` — ${stripTags(item.description)}`}\n   ${item.url}`).join('\n')
            + (warning === '' ? '' : `\n\n${warning}`),
        };
      },
    }),
  );

  return ['ck3wiki_status', 'ck3wiki_search', 'ck3wiki_titles'];
}
