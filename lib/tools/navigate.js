/**
 * 导航类工具：页面关系（`ck3wiki_links`）、分类成员（`ck3wiki_category`）、
 * 最近改动（`ck3wiki_recent_changes`）。
 *
 * 用途偏「顺藤摸瓜」：检索只能给命中，链接/反链与分类才能把相关页面一次串起来
 * （例如从 `Modding` 出发找全部 *modding 子页，或看某个模板被谁引用）。
 *
 * 两条与 dsh-bwiki 对齐的约定：
 * - **标题原样打印**：接口返回的标题本来就带本地化命名空间前缀（`CK3 Wiki:Style` 是 ns 4、
 *   `Template:X/doc` 是 ns 10），再补一次会拼出 `Project:CK3 Wiki:Style` 这种废标题；
 * - **接口错误如实上报**：`{error:{code,info}}` 不能当成「没有成员 / 没有链接」。
 *
 * @module dsh-ck3-wiki/tools/navigate
 */

import {
  backlinksUrl,
  categoryMembersUrl,
  linksUrl,
  mapBacklinks,
  mapCategoryMembers,
  mapLinks,
  mapRecentChanges,
  recentChangesUrl,
} from '../mediawiki.js';
import { defineTool } from '../tool-kit.js';
import {
  TEXT_OUTPUT, alwaysSafe, apiErrorText, clampLimit, formatAge, header, namespaceParam, requireText, unwrap,
} from './shared.js';

/** 分类成员的类型过滤值。 */
const CATEGORY_TYPES = new Map([
  ['page', 'page'],
  ['subcat', 'subcat'],
  ['file', 'file'],
  ['all', undefined],
]);

/**
 * 注册 3 个导航类工具。
 * @param {{ tools: { register: Function } }} ctx - 插件上下文。
 * @param {Record<string, any>} config - 生效配置。
 * @param {{ reader: { read: Function } }} deps - 依赖。
 * @returns {string[]} 已注册的工具名。
 */
export function registerNavigateTools(ctx, config, deps) {
  const { reader } = deps;
  const maxLinks = 100;
  const maxCategory = 200;
  const maxRecent = 100;

  ctx.tools.register(
    defineTool({
      name: 'ck3wiki_links',
      description:
        '列出 Wiki 页面的出链（direction="out"，页面里指向别的页面的链接）或反向链接（direction="in"，'
        + '哪些页面链接到了它）。用来从一页扩散到相关页，或查某个模板/页面被哪些页面引用。只读。',
      parameters: {
        title: { type: 'string', required: true, description: '页面标题。' },
        direction: { type: 'string', enum: ['out', 'in'], description: 'out（默认，出链）或 in（反向链接）。' },
        namespace: { type: 'string', description: '只看某个命名空间的链接（id 或名字），默认不限。' },
        limit: { type: 'integer', description: `最多返回多少条，默认 30，上限 ${maxLinks}。` },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: alwaysSafe,
      async execute(args, exec) {
        const title = requireText(args.title, 'title');
        const limit = clampLimit(args.limit, 30, maxLinks);
        const direction = args.direction === 'in' ? 'in' : 'out';
        const namespace = args.namespace === undefined ? undefined : namespaceParam(args.namespace, '*');
        const nsFilter = namespace === '*' ? undefined : namespace;

        if (direction === 'in') {
          const url = backlinksUrl(config.wikiBaseUrl, config.apiPath, { title, limit, namespace: nsFilter });
          const data = unwrap(await reader.read(url, { signal: exec.signal }), '读取反向链接');
          const rejected = apiErrorText(data, '读取反向链接');
          if (rejected !== '') return { text: rejected };
          const items = mapBacklinks(data);
          if (items.length === 0) return { text: `没有页面链接到「${title}」（命名空间 ${nsFilter ?? '全部'}）。` };
          const more = data?.continue !== undefined;
          return {
            text: `${header([`# 链接到「${title}」的页面（共 ${items.length} 条${more ? '，还有更多' : ''}）`])}`
              + items.map((item, index) => `${index + 1}. ${item.title}${item.redirect ? '（经由重定向）' : ''}`).join('\n')
              + (more ? `\n\n（已达 limit=${limit}；提高 limit（上限 ${maxLinks}）或用 namespace 过滤继续缩小）` : ''),
          };
        }

        const url = linksUrl(config.wikiBaseUrl, config.apiPath, { title, limit, namespace: nsFilter });
        const data = unwrap(await reader.read(url, { signal: exec.signal }), '读取出链');
        const rejected = apiErrorText(data, '读取出链');
        if (rejected !== '') return { text: rejected };
        const mapped = mapLinks(data, title);
        if (!mapped.found) return { text: `页面「${title}」不存在，出链无法读取（先用 ck3wiki_search 找标题）。` };
        if (mapped.links.length === 0) return { text: `「${mapped.title}」没有指向别处的链接（命名空间 ${nsFilter ?? '全部'}）。` };
        const more = data?.continue !== undefined;
        return {
          text: `${header([`# 「${mapped.title}」的出链（共 ${mapped.links.length} 条${more ? '，还有更多' : ''}）`])}`
            + mapped.links.map((link, index) => `${index + 1}. ${link.title}`).join('\n')
            + (more ? `\n\n（已达 limit=${limit}；提高 limit（上限 ${maxLinks}）或用 namespace 过滤）` : ''),
        };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'ck3wiki_category',
      description:
        '列出某个分类（Category）的成员。type 可选 page（默认，普通页面）、subcat（子分类）、file（文件）、all。'
        + '找「某类东西的全集」时最有用，例如 Category:Modding。只读。',
      parameters: {
        category: { type: 'string', required: true, description: '分类名，可带或不带 Category: 前缀，例如 Modding。' },
        type: { type: 'string', enum: ['page', 'subcat', 'file', 'all'], description: '成员类型，默认 page。' },
        limit: { type: 'integer', description: `最多返回多少条，默认 30，上限 ${maxCategory}。` },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: alwaysSafe,
      async execute(args, exec) {
        const category = requireText(args.category, 'category');
        const limit = clampLimit(args.limit, 30, maxCategory);
        const type = CATEGORY_TYPES.has(String(args.type ?? 'page')) ? CATEGORY_TYPES.get(String(args.type ?? 'page')) : 'page';
        const url = categoryMembersUrl(config.wikiBaseUrl, config.apiPath, { category, limit, type });
        const data = unwrap(await reader.read(url, { signal: exec.signal }), '读取分类');
        const rejected = apiErrorText(data, '读取分类');
        if (rejected !== '') return { text: rejected };
        const items = mapCategoryMembers(data);
        const name = String(category).replace(/^Category:/i, '');
        if (items.length === 0) {
          return {
            text: `分类「Category:${name}」没有成员（type=${args.type ?? 'page'}）。`
              + '\n分类名区分大小写；也可以用 ck3wiki_search 试 incategory:"名字" 检索。',
          };
        }
        const more = data?.continue !== undefined;
        return {
          text: `${header([`# Category:${name} 的成员（type=${args.type ?? 'page'}，共 ${items.length} 条${more ? '，还有更多' : ''}）`])}`
            + items.map((item, index) => `${index + 1}. ${item.title}${item.timestamp === undefined ? '' : `（${formatAge(item.timestamp)}）`}`).join('\n')
            + (more ? `\n\n（已达 limit=${limit}；提高 limit（上限 ${maxCategory}）或用 type=subcat 先看子分类）` : ''),
        };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'ck3wiki_recent_changes',
      description:
        '看 Wiki 最近改动（默认最近 7 天）：类型（新建/编辑）、页面、编辑者、字节变化与编辑摘要。'
        + '想知道某个机制是不是刚改过、或跟着更新走时用它。只读。',
      parameters: {
        limit: { type: 'integer', description: `最多返回多少条，默认 20，上限 ${maxRecent}。` },
        days: { type: 'integer', description: '回溯多少天，默认 7，上限 90。' },
        namespace: { type: 'string', description: '限定命名空间（id 或名字），默认全部。' },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: alwaysSafe,
      async execute(args, exec) {
        const limit = clampLimit(args.limit, 20, maxRecent);
        const days = clampLimit(args.days, 7, 90);
        const namespace = args.namespace === undefined ? undefined : namespaceParam(args.namespace, '*');
        const url = recentChangesUrl(config.wikiBaseUrl, config.apiPath, {
          limit,
          days,
          namespace: namespace === '*' ? undefined : namespace,
        });
        const data = unwrap(await reader.read(url, { signal: exec.signal }), '读取最近改动');
        const rejected = apiErrorText(data, '读取最近改动');
        if (rejected !== '') return { text: rejected };
        const items = mapRecentChanges(data);
        if (items.length === 0) return { text: `最近 ${days} 天内没有符合条件的改动（命名空间 ${namespace ?? '全部'}）。` };
        const lines = items.map((item) => {
          const delta = item.oldlen !== undefined && item.newlen !== undefined
            ? `（${item.oldlen}→${item.newlen}，${item.newlen - item.oldlen >= 0 ? '+' : ''}${item.newlen - item.oldlen}）`
            : '';
          const kind = item.type === 'new' ? '新建' : '编辑';
          const comment = item.comment === '' ? '' : `  ${item.comment}`;
          return `${item.timestamp}（${formatAge(item.timestamp)}）${kind} ${item.title} — ${item.user}${delta}${comment}`;
        });
        return {
          text: `${header([`# 最近 ${days} 天的改动（共 ${items.length} 条，命名空间 ${namespace ?? '全部'}）`])}${lines.join('\n')}`,
        };
      },
    }),
  );

  return ['ck3wiki_category', 'ck3wiki_links', 'ck3wiki_recent_changes'];
}
