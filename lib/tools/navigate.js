/**
 * 导航类工具：页面关系（`ck3wiki_links`）、分类成员（`ck3wiki_category`）、
 * 最近改动（`ck3wiki_recent_changes`）。
 *
 * 用途偏「顺藤摸瓜」：检索只能给命中，链接/反链与分类才能把相关页面一次串起来
 * （例如从 `Modding` 出发找全部 *modding 子页，或看某个模板被谁引用）。
 *
 * 几条与 dsh-prts / dsh-bwiki 对齐的约定：
 * - **标题原样打印**：接口返回的标题本来就带本地化命名空间前缀（`CK3 Wiki:Style` 是 ns 4、
 *   `Template:X/doc` 是 ns 10），再补一次会拼出 `Project:CK3 Wiki:Style` 这种废标题；
 * - **接口错误如实上报**：`{error:{code,info}}` 不能当成「没有成员 / 没有链接」；
 * - **不存在 ≠ 空**：backlinks/categorymembers 对不存在的标题只回空列表，所以 URL 里
 *   额外带了 `prop=info`，用 `missing` 标记区分；
 * - **翻页交给 `continue`**：到上限时回显下一次的游标，而不是建议提高已到配置上限的 `limit`。
 *
 * @module dsh-ck3-wiki/tools/navigate
 */

import {
  alignToCacheWindow,
  backlinksUrl,
  categoryMembersUrl,
  linksUrl,
  mapBacklinks,
  mapCategoryMembers,
  mapLinks,
  mapRecentChanges,
  pageMissing,
  recentChangesUrl,
} from '../mediawiki.js';
import { defineTool } from '../tool-kit.js';
import {
  TEXT_OUTPUT, TOOL_TIMEOUT_MS, alwaysSafe, apiErrorText, apiWarningText, clampLimit,
  createNamespaceResolver, formatAge, header, listedCap, requireText, unwrap,
} from './shared.js';

/** 分类成员的类型过滤值。 */
const CATEGORY_TYPES = new Map([
  ['page', 'page'],
  ['subcat', 'subcat'],
  ['file', 'file'],
  ['all', undefined],
]);

/** 列出条目时的续读提示：游标为空即到头了。 */
function nextContinueHint(token) {
  return token === '' ? '已到末尾' : `下一次 continue=${token}`;
}

/**
 * 从响应的 `continue` 对象里取某个列表的游标。
 * @param {any} data - 解析后的 JSON。
 * @param {string} key - `plcontinue` / `blcontinue` / `cmcontinue` / `rccontinue`。
 * @returns {string} 游标；没有时为空串。
 */
function continueTokenOf(data, key) {
  const token = data?.continue?.[key];
  return typeof token === 'string' && token !== '' ? token : '';
}

/**
 * 注册 3 个导航类工具。
 * @param {{ tools: { register: Function } }} ctx - 插件上下文。
 * @param {Record<string, any>} config - 生效配置。
 * @param {{ reader: { read: Function } }} deps - 依赖。
 * @returns {string[]} 已注册的工具名。
 */
export function registerNavigateTools(ctx, config, deps) {
  const { reader } = deps;
  const namespaces = createNamespaceResolver(reader, config);
  const maxLinks = listedCap(config, 100);
  const maxCategory = listedCap(config, 200);
  const maxRecent = listedCap(config, 100);

  ctx.tools.register(
    defineTool({
      name: 'ck3wiki_links',
      description:
        '列出 Wiki 页面的出链（direction="out"，页面里指向别的页面的链接）或反向链接（direction="in"，'
        + '哪些页面链接到了它）。用来从一页扩散到相关页，或查某个模板/页面被哪些页面引用。',
      parameters: {
        title: { type: 'string', required: true, description: '页面标题。' },
        direction: { type: 'string', enum: ['out', 'in'], description: 'out（默认，出链）或 in（反向链接）。' },
        namespace: { type: 'string', description: '只看某个命名空间的链接（id 或名字），默认不限。' },
        limit: { type: 'integer', description: `最多返回多少条，默认 30，上限 ${maxLinks}。` },
        continue: { type: 'string', description: '分页游标：把上一次输出里的「下一次 continue=…」原样传回来。' },
        fresh: { type: 'boolean', description: '为 true 时绕过 TTL 缓存重取。' },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: alwaysSafe,
      timeoutMs: TOOL_TIMEOUT_MS,
      async execute(args, exec) {
        const title = requireText(args.title, 'title');
        const limit = clampLimit(args.limit, 30, maxLinks);
        const direction = args.direction === 'in' ? 'in' : 'out';
        const resolved = args.namespace === undefined
          ? '*'
          : await namespaces.resolve(args.namespace, '*', { signal: exec.signal });
        const nsFilter = resolved === '*' ? undefined : resolved;
        const nsText = nsFilter ?? '全部';
        const continueToken = typeof args.continue === 'string' && args.continue !== '' ? args.continue : undefined;
        const fresh = args.fresh === true;

        if (direction === 'in') {
          const url = backlinksUrl(config.wikiBaseUrl, config.apiPath, { title, limit, namespace: nsFilter, continue: continueToken });
          const data = unwrap(await reader.read(url, { signal: exec.signal, fresh }), '读取反向链接');
          const rejected = apiErrorText(data, '读取反向链接');
          if (rejected !== '') return { text: rejected };
          const warning = apiWarningText(data, '反向链接');
          if (pageMissing(data)) {
            return { text: `页面「${title}」不存在，反链无法读取（先用 ck3wiki_search 找标题）。${warning === '' ? '' : `\n${warning}`}` };
          }
          const items = mapBacklinks(data);
          if (items.length === 0) {
            const text = `没有页面链接到「${title}」（命名空间 ${nsText}）。`;
            return { text: warning === '' ? text : `${text}\n${warning}` };
          }
          const token = continueTokenOf(data, 'blcontinue');
          return {
            text: `${header([`# 链接到「${title}」的页面（本次 ${items.length} 条，命名空间 ${nsText}）`])}`
              + items.map((item, index) => `${index + 1}. ${item.title}${item.redirect ? '（经由重定向）' : ''}`).join('\n')
              + `\n\n（${token === '' ? '已到末尾' : '还有更多'}；${nextContinueHint(token)}）`
              + (warning === '' ? '' : `\n${warning}`),
          };
        }

        const url = linksUrl(config.wikiBaseUrl, config.apiPath, { title, limit, namespace: nsFilter, continue: continueToken });
        const data = unwrap(await reader.read(url, { signal: exec.signal, fresh }), '读取出链');
        const rejected = apiErrorText(data, '读取出链');
        if (rejected !== '') return { text: rejected };
        const warning = apiWarningText(data, '出链');
        const mapped = mapLinks(data, title);
        if (!mapped.found) {
          return { text: `页面「${title}」不存在，出链无法读取（先用 ck3wiki_search 找标题）。${warning === '' ? '' : `\n${warning}`}` };
        }
        if (mapped.links.length === 0) {
          const text = `「${mapped.title}」没有指向别处的链接（命名空间 ${nsText}）。`;
          return { text: warning === '' ? text : `${text}\n${warning}` };
        }
        const token = continueTokenOf(data, 'plcontinue');
        return {
          text: `${header([`# 「${mapped.title}」的出链（本次 ${mapped.links.length} 条，命名空间 ${nsText}）`])}`
            + mapped.links.map((link, index) => `${index + 1}. ${link.title}`).join('\n')
            + `\n\n（${token === '' ? '已到末尾' : '还有更多'}；${nextContinueHint(token)}）`
            + (warning === '' ? '' : `\n${warning}`),
        };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'ck3wiki_category',
      description:
        '列出某个分类（Category）的成员。type 可选 page（默认，普通页面）、subcat（子分类）、file（文件）、all。'
        + '找「某类东西的全集」时最有用，例如 Category:Modding。',
      parameters: {
        category: { type: 'string', required: true, description: '分类名，可带或不带 Category: 前缀，例如 Modding。' },
        type: { type: 'string', enum: ['page', 'subcat', 'file', 'all'], description: '成员类型，默认 page。' },
        limit: { type: 'integer', description: `最多返回多少条，默认 30，上限 ${maxCategory}。` },
        continue: { type: 'string', description: '分页游标：把上一次输出里的「下一次 continue=…」原样传回来。' },
        fresh: { type: 'boolean', description: '为 true 时绕过 TTL 缓存重取。' },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: alwaysSafe,
      timeoutMs: TOOL_TIMEOUT_MS,
      async execute(args, exec) {
        const category = requireText(args.category, 'category');
        const limit = clampLimit(args.limit, 30, maxCategory);
        // type 的合法性由 tool-kit 的 enum 校验兜住；`all` 映射成 undefined = 不传 cmtype（不按类型过滤）。
        const typeValue = String(args.type ?? 'page');
        const type = CATEGORY_TYPES.has(typeValue) ? CATEGORY_TYPES.get(typeValue) : 'page';
        const continueToken = typeof args.continue === 'string' && args.continue !== '' ? args.continue : undefined;
        const name = category.replace(/^Category:/i, '');
        const url = categoryMembersUrl(config.wikiBaseUrl, config.apiPath, { category, limit, type, continue: continueToken });
        const data = unwrap(await reader.read(url, { signal: exec.signal, fresh: args.fresh === true }), '读取分类');
        const rejected = apiErrorText(data, '读取分类');
        if (rejected !== '') return { text: rejected };
        const warning = apiWarningText(data, '分类成员');
        const suffix = warning === '' ? '' : `\n${warning}`;
        const items = mapCategoryMembers(data);
        if (pageMissing(data)) {
          return {
            text: `分类「Category:${name}」不存在（该分类页还没被创建）。`
              + '先用 ck3wiki_search 试 incategory:"名字" 检索，或确认分类名（首字母大小写不敏感，其余区分大小写）。'
              + suffix,
          };
        }
        if (items.length === 0) {
          return {
            text: `分类「Category:${name}」没有成员（type=${typeValue}）。`
              + '\n分类名首字母大小写不敏感、其余区分大小写；也可以用 ck3wiki_search 试 incategory:"名字" 检索。'
              + suffix,
          };
        }
        const token = continueTokenOf(data, 'cmcontinue');
        return {
          text: `${header([`# Category:${name} 的成员（type=${typeValue}，本次 ${items.length} 条）`])}`
            + items.map((item, index) => `${index + 1}. ${item.title}${item.timestamp === undefined ? '' : `（${formatAge(item.timestamp)}）`}`).join('\n')
            + `\n\n（${token === '' ? '已到末尾' : '还有更多'}；${nextContinueHint(token)}）`
            + suffix,
        };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'ck3wiki_recent_changes',
      description:
        '看 Wiki 最近改动（默认最近 7 天）：类型（新建/编辑）、页面、编辑者、字节变化与编辑摘要。'
        + '想知道某个机制是不是刚改过、或跟着更新走时用它。',
      parameters: {
        limit: { type: 'integer', description: `最多返回多少条，默认 20，上限 ${maxRecent}。` },
        days: { type: 'integer', description: '回溯多少天，默认 7，上限 90。' },
        namespace: { type: 'string', description: '限定命名空间（id 或名字），默认全部。' },
        continue: { type: 'string', description: '分页游标：把上一次输出里的「下一次 continue=…」原样传回来。' },
        fresh: { type: 'boolean', description: '为 true 时绕过 TTL 缓存重取。' },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: alwaysSafe,
      timeoutMs: TOOL_TIMEOUT_MS,
      async execute(args, exec) {
        const limit = clampLimit(args.limit, 20, maxRecent);
        const days = clampLimit(args.days, 7, 90);
        const resolved = args.namespace === undefined
          ? '*'
          : await namespaces.resolve(args.namespace, '*', { signal: exec.signal });
        const nsFilter = resolved === '*' ? undefined : resolved;
        const nsText = nsFilter ?? '全部';
        const continueToken = typeof args.continue === 'string' && args.continue !== '' ? args.continue : undefined;
        // 时间戳按 TTL 窗口对齐：否则每次 URL 都不同，缓存永远命不中（cacheTtlMs=0 时退回每分钟）。
        const now = alignToCacheWindow(Date.now(), config.cacheTtlMs);
        const url = recentChangesUrl(config.wikiBaseUrl, config.apiPath, {
          limit,
          days,
          namespace: nsFilter,
          now,
          continue: continueToken,
        });
        const data = unwrap(await reader.read(url, { signal: exec.signal, fresh: args.fresh === true }), '读取最近改动');
        const rejected = apiErrorText(data, '读取最近改动');
        if (rejected !== '') return { text: rejected };
        const warning = apiWarningText(data, '最近改动');
        const suffix = warning === '' ? '' : `\n${warning}`;
        const items = mapRecentChanges(data);
        if (items.length === 0) {
          return { text: `最近 ${days} 天内没有符合条件的改动（命名空间 ${nsText}）。${suffix}` };
        }
        const lines = items.map((item) => {
          const delta = item.oldlen !== undefined && item.newlen !== undefined
            ? `（${item.oldlen}→${item.newlen}，${item.newlen - item.oldlen >= 0 ? '+' : ''}${item.newlen - item.oldlen}）`
            : '';
          const kind = item.type === 'new' ? '新建' : '编辑';
          const comment = item.comment === '' ? '' : `  ${item.comment}`;
          return `${item.timestamp}（${formatAge(item.timestamp)}）${kind} ${item.title} — ${item.user}${delta}${comment}`;
        });
        const token = continueTokenOf(data, 'rccontinue');
        return {
          text: `${header([`# 最近 ${days} 天的改动（本次 ${items.length} 条，命名空间 ${nsText}）`])}${lines.join('\n')}`
            + `\n\n（${token === '' ? '已到末尾' : '还有更多'}；${nextContinueHint(token)}）`
            + suffix,
        };
      },
    }),
  );

  return ['ck3wiki_category', 'ck3wiki_links', 'ck3wiki_recent_changes'];
}
