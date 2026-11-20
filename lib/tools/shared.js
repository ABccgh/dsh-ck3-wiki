/**
 * 工具层共用件：统一输出形状、上限裁剪、命名空间解析、URL 级只读缓存、时间格式化，以及
 * 「HTTP 结果 → 抛错或取值」的归一。
 *
 * @module dsh-ck3-wiki/tools/shared
 */

import { mapNamespaces, namespaceInfoUrl } from '../mediawiki.js';

/**
 * 每个工具注册时声明的墙钟超时（毫秒）。
 *
 * 只作**卡死兜底**：正常路径由 `http.js` 的单次请求超时与重试预算控制，这个值比单次
 * 请求预算大得多，只在异常卡住时把工具调用截断，避免一次调用永远挂着。
 */
export const TOOL_TIMEOUT_MS = 45_000;

/**
 * 命名空间表缓存 TTL：站点命名空间几乎不变，10 分钟足够，也避免每轮对话都多一次请求。
 */
const NAMESPACE_CACHE_TTL_MS = 600_000;

/**
 * 所有 `ck3wiki_*` 工具的输出形状：一段给模型读的紧凑文本。
 *
 * 这里刻意不返回结构化对象：DSH 的输出值 schema 是简写 spec，嵌套结构一旦写错
 * 会在工具调用时变成校验失败，而模型真正需要的是可读文本。
 */
export const TEXT_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      text: { type: 'string', required: true, description: '给模型阅读的文本结果' },
    },
  },
  render: (_args, value) => [{ type: 'text', text: String(value.text) }],
};

/** 只读工具都可以并发执行。 */
export function alwaysSafe() {
  return true;
}

/**
 * 把可选的 `limit` 参数收进合法范围。
 * @param {unknown} value - 模型传来的值。
 * @param {number} fallback - 默认值。
 * @param {number} max - 上限。
 * @returns {number} 夹紧后的整数。
 */
export function clampLimit(value, fallback, max) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  const fallbackClamped = Math.min(fallback, max);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallbackClamped;
  return Math.min(Math.trunc(parsed), max);
}

/**
 * 把可选的整数参数收进合法范围（用于 `offset` / `section` / `namespace`）。
 * @param {unknown} value - 原始值。
 * @param {number} fallback - 默认值。
 * @returns {number} 整数。
 */
export function clampInt(value, fallback) {
  const parsed = typeof value === 'number' ? Math.trunc(value) : Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * 把「命名空间」参数归一成「数字 id / `*` / 仍是名字」三种形态之一（同步、不联网）。
 *
 * MediaWiki 的 `srnamespace`/`plnamespace`/`rcnamespace` 只认数字 id：
 * 名字会被**静默忽略**（查询退化成全部命名空间，只在响应里留一条 warning）。
 * 名字要换成 id 必须问站点，所以这里只做同步归一，真正的解析在
 * {@link createNamespaceResolver}。
 * @param {unknown} value - 模型传来的值。
 * @param {number|string} [fallback] - 缺省值（默认 0，即主条目）。
 * @returns {string} 归一后的值：数字字符串、`*`，或待解析的名字。
 */
export function namespaceParam(value, fallback = 0) {
  if (value === undefined || value === null || value === '') return String(fallback);
  if (typeof value === 'number') return Number.isFinite(value) ? String(Math.trunc(value)) : String(fallback);
  const text = String(value).trim();
  if (text === '') return String(fallback);
  if (text === '*' || /^all$/i.test(text)) return '*';
  if (/^-?\d+$/.test(text)) return String(Number.parseInt(text, 10));
  return text;
}

/**
 * 造一个命名空间解析器：把名字/别名换成数字 id（结果缓存，默认 10 分钟）。
 *
 * 设计取舍：
 * - 数字与 `*` 直接透传，**不联网**——所有工具的默认参数都是数字，默认路径不会被
 *   额外请求拖慢；
 * - 只有真的给了名字时才取一次 `siteinfo`（`namespaces|namespacealiases`），之后
 *   走进程内缓存（比 URL 缓存更长）；`fresh` 的参数刷新不会冲掉这份表；
 * - 不认识的名字抛**可执行**错误：列出站点返回的全部命名空间名字，让模型自己纠正，
 *   而不是把名字原样传给接口、被静默忽略后拿回一堆「全部命名空间」的结果。
 * @param {{ read: Function }} reader - URL 级缓存读取器。
 * @param {Record<string, any>} config - 生效配置（`wikiBaseUrl` / `apiPath`）。
 * @param {{ ttlMs?: number }} [options] 选项。
 * @returns {{ resolve: (value: unknown, fallback?: number|string,
 *   options?: { signal?: AbortSignal }) => Promise<string> }} 解析器。
 */
export function createNamespaceResolver(reader, config, options = {}) {
  const ttlMs = Number.isFinite(options.ttlMs) ? Math.max(0, Math.trunc(options.ttlMs)) : NAMESPACE_CACHE_TTL_MS;
  /** @type {{ at: number, byName: Map<string, number>, describe: string[] }|undefined} */
  let cache;

  const load = async (signal) => {
    if (cache !== undefined && Date.now() - cache.at < ttlMs) return cache;
    const url = namespaceInfoUrl(config.wikiBaseUrl, config.apiPath);
    const data = unwrap(await reader.read(url, { signal }), '读取站点命名空间表');
    const mapped = mapNamespaces(data);
    if (mapped.list.length === 0) {
      throw new Error('站点没有返回命名空间表，无法把命名空间名字解析成数字 id；请改用数字 id（主条目是 0）。');
    }
    cache = { at: Date.now(), byName: mapped.byName, describe: mapped.describe };
    return cache;
  };

  return {
    async resolve(value, fallback = 0, resolveOptions = {}) {
      const normalized = namespaceParam(value, fallback);
      if (normalized === '*' || /^-?\d+$/.test(normalized)) return normalized;
      const loaded = await load(resolveOptions.signal);
      const key = normalized.replace(/_/g, ' ').trim().toLowerCase();
      const id = loaded.byName.get(key);
      if (id === undefined) {
        const available = [...loaded.describe, '*（全部命名空间）'].join('、');
        throw new Error(
          `无法识别命名空间「${normalized}」。可用：${available}。`
          + '（该站只按数字 id 过滤；也可以直接传数字，或传 * 表示全部。）',
        );
      }
      return String(id);
    },
  };
}

/**
 * 列表类工具的**上限**：读配置 `maxListedItems`，配置里没有/非法时退回该工具的原默认上限。
 *
 * 四个列表工具（titles / links / category / recent_changes）的上限都从这里取，
 * 不再各写一个硬编码常数；`limit` 参数的默认显示条数仍由各工具自己决定。
 * @param {Record<string, any>} config - 生效配置。
 * @param {number} fallback - 配置缺失时的上限（该工具原来的硬编码上限）。
 * @returns {number} 生效上限。
 */
export function listedCap(config, fallback) {
  const configured = config?.maxListedItems;
  return Number.isFinite(configured) && configured > 0 ? Math.trunc(configured) : fallback;
}

/**
 * 取一个必填的非空文本参数。
 * @param {unknown} value - 原始值。
 * @param {string} name - 参数名（写进错误消息）。
 * @returns {string} 去空白后的文本。
 * @throws {Error} 为空时。
 */
export function requireText(value, name) {
  const text = String(value ?? '').trim();
  if (text === '') throw new Error(`${name} 不能为空。`);
  return text;
}

/**
 * MediaWiki 接口错误码 → 可执行建议。
 * @param {string} code - 错误码。
 * @returns {string} 建议文本（可能为空）。
 */
export function hintForApiError(code) {
  switch (code) {
    case 'badvalue':
      return '参数值超出该站允许范围：常见原因是 limit 超过上限（该站实测 100 可用，本插件按 maxListedItems 夹紧），或 namespace 写了一个不存在的名字。';
    case 'nosuchsection':
      return 'section 不存在：先看目录再传（section=0 是引言）。';
    case 'invalidtitle':
      return '标题不合法（空标题、或含不能用于标题的字符）。';
    case 'missingtitle':
    case 'unknown_title':
      return '页面不存在：换一个标题，或先用 ck3wiki_titles 把名字对准。';
    case 'readapidenied':
      return '该站的读取接口被拒绝了：确认 apiPath 配置，以及是否被反爬挑战页顶掉了响应。';
    case 'paraminfo':
      return '接口不认识某个参数：多半是 apiPath 或参数名写错了。';
    case 'cirrussearch-parse-error':
      return '检索语法没被理解：把查询写简单些，或去掉 `insource:/…/` 这类正则再试。';
    default:
      return '';
  }
}

/**
 * 取出接口返回的 `error` 对象。
 * @param {any} data - 解析后的 JSON。
 * @returns {{ code: string, info: string, hint: string }|undefined} 错误；没有则 undefined。
 */
export function apiError(data) {
  const error = data?.error;
  if (error === null || error === undefined) return undefined;
  const code = String(error.code ?? '');
  return { code, info: String(error.info ?? ''), hint: hintForApiError(code) };
}

/**
 * 把接口错误渲染成给模型看的文本；没有错误时返回空串。
 *
 * 为什么需要：MediaWiki 的参数错误（`srlimit` 超过匿名上限、非法 CirrusSearch 语法、
 * `cmtitle` 写错命名空间）会被下游映射器吃掉，表现成「没有命中 / 没有成员 / 页面不存在」，
 * 于是模型以为是自己查询词的问题、反复换关键词。凡 `unwrap` 之后都该过一遍这里。
 * @param {any} data - 解析后的 JSON。
 * @param {string} what - 这次请求在做什么（写进消息）。
 * @returns {string} 错误文本或空串。
 */
export function apiErrorText(data, what) {
  const error = apiError(data);
  if (error === undefined) return '';
  return [
    `${what}被 wiki 拒绝（${error.code === '' ? '未知错误' : error.code}）${error.info === '' ? '' : `：${error.info}`}`,
    error.hint === '' ? '' : `建议：${error.hint}`,
  ].filter((line) => line !== '').join('\n');
}

/**
 * 把接口的 `warnings` 渲染成一行提示；没有 warning 时返回空串。
 *
 * 为什么需要：MediaWiki 对**不认识的参数值**不报错，只回一条 `warnings`。命名空间名字
 * 写错就属于这一类——查询被静默当成「全部命名空间」，模型却以为过滤生效了。
 * 所以每个可能被站的参数过滤影响的工具都要把 warning 带出来。
 *
 * `warnings` 的形状随 MediaWiki 版本变化（`{main:{warnings:'…'}}`、
 * `[{code,text}]`、或 `{'*':'…'}`），这里递归收集所有可读字符串。
 * @param {any} data - 解析后的 JSON。
 * @param {string} what - 这次请求在做什么（例如「检索」）。
 * @returns {string} 一行警告文本，或空串。
 */
export function apiWarningText(data, what) {
  const warnings = data?.warnings;
  if (warnings === undefined || warnings === null) return '';
  /** @type {string[]} */
  const messages = [];
  /** @type {Set<string>} */
  const seen = new Set();
  const walk = (node) => {
    if (node === null || node === undefined) return;
    if (typeof node === 'string') {
      const text = node.trim();
      if (text !== '' && !seen.has(text)) {
        seen.add(text);
        messages.push(text);
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node)) {
      // `code` 只是机器标识，不进人读消息。
      if (key === 'code') continue;
      walk(child);
    }
  };
  walk(warnings);
  const body = messages.length === 0 ? `${what}返回了无法解析的 warning` : messages.slice(0, 3).join('；');
  return `警告：${body}（该站未按参数过滤，请用数字 id）`;
}

/**
 * 造一个按 URL 缓存的只读读取器：TTL 内命中直接返回，同一 URL 的并发请求合并成一次。
 *
 * 为什么需要：一次对话里模型常常反复读同一页（先看目录、再读某节、再回看），
 * 而该站后面是 Fastly，少发重复请求既省时间也更礼貌。缓存的条目有上限，
 * 过期即淘汰，`fresh: true` 可显式绕过。
 * @param {{ json: Function }} http - 出网层取数器。
 * @param {{ ttlMs?: number, maxEntries?: number, onHit?: Function }} [options] 选项。
 * @returns {{ read: (url: string, options?: { signal?: AbortSignal, fresh?: boolean }) => Promise<object>,
 *   stats: () => { hits: number, misses: number, size: number } }} 读取器。
 */
export function createJsonReader(http, options = {}) {
  const ttlMs = Number.isFinite(options.ttlMs) ? Math.max(0, Math.trunc(options.ttlMs)) : 60_000;
  const maxEntries = Number.isFinite(options.maxEntries) ? Math.max(1, Math.trunc(options.maxEntries)) : 50;
  /** @type {Map<string, { at: number, value: object }>} */
  const entries = new Map();
  /** @type {Map<string, Promise<object>>} */
  const inflight = new Map();
  let hits = 0;
  let misses = 0;

  const prune = () => {
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next();
      if (oldest.done) break;
      entries.delete(oldest.value);
    }
  };

  return {
    async read(url, readOptions = {}) {
      const now = Date.now();
      if (readOptions.fresh !== true && ttlMs > 0) {
        const hit = entries.get(url);
        if (hit !== undefined && now - hit.at < ttlMs) {
          hits += 1;
          options.onHit?.(url);
          return hit.value;
        }
      }
      const pending = inflight.get(url);
      if (pending !== undefined) return pending;
      misses += 1;
      const task = Promise.resolve(http.json(url, { signal: readOptions.signal }))
        .then((result) => {
          if (result?.ok === true) {
            entries.set(url, { at: Date.now(), value: result });
            prune();
          }
          return result;
        })
        .finally(() => {
          inflight.delete(url);
        });
      inflight.set(url, task);
      return task;
    },
    stats: () => ({ hits, misses, size: entries.size }),
  };
}

/**
 * 造一个带 `AbortError` 身份的取消错误。
 *
 * DSH 只把「signal 已取消 + 抛出的值没有自己的错误身份且 name 为 AbortError」的
 * 调用记成 `ABORTED`（`dsh-tools` 的 pipeline 判定）；普通 `Error` 会被记成一次
 * 普通工具失败，界面上就看不出是用户取消了。
 * @param {string} [message] - 错误消息。
 * @returns {Error} name 为 AbortError 的错误。
 */
export function abortError(message = '请求已被取消') {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

/**
 * 把出网层的结果变成「值或异常」。
 * @param {{ ok: boolean, data?: unknown, error?: string, hint?: string, challenge?: boolean, url?: string,
 *   via?: string, aborted?: boolean }} result - `fetchJson` 的结果。
 * @param {string} what - 这次请求在做什么（写进错误消息）。
 * @returns {unknown} 解析后的 JSON。
 * @throws {Error} 失败时抛出带建议的错误；取消时抛 AbortError。
 */
export function unwrap(result, what) {
  if (result?.aborted === true) throw abortError();
  if (result?.ok === true) return result.data;
  const lines = [`${what}失败：${result?.error ?? '未知错误'}`];
  if (typeof result?.hint === 'string' && result.hint !== '') lines.push(`建议：${result.hint}`);
  if (typeof result?.url === 'string') lines.push(`请求：${result.url}`);
  throw new Error(lines.join('\n'));
}

/**
 * 把 ISO 时间变成「刚刚 / 12 分钟前 / 3 小时前 / 2 天前 / 日期」。
 * @param {string|undefined} iso - ISO 8601 时间戳。
 * @param {Date} [now] - 当前时间（便于测试）。
 * @returns {string} 可读时间；无法解析时返回空串。
 */
export function formatAge(iso, now) {
  if (typeof iso !== 'string' || iso === '') return '';
  const when = Date.parse(iso);
  if (!Number.isFinite(when)) return '';
  const deltaMs = (now instanceof Date ? now.getTime() : Date.now()) - when;
  const minutes = Math.round(deltaMs / 60_000);
  if (Math.abs(minutes) < 1) return '刚刚';
  if (Math.abs(minutes) < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 36) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 31) return `${days} 天前`;
  return iso.slice(0, 10);
}

/**
 * 「只显示了前 N 条」的尾注。
 * @param {number} shown - 已显示条数。
 * @param {number|null} total - 总数（未知时传 null）。
 * @param {string} unit - 计数单位，例如「个页面」。
 * @param {string} [nextHint] - 继续取下一页的提示。
 * @returns {string} 尾注文本（不需要时为空串）。
 */
export function listTail(shown, total, unit, nextHint = '') {
  const totalText = total === null || total === undefined ? `${shown} ${unit}` : `共 ${total} ${unit}`;
  const hint = nextHint === '' ? '' : `；${nextHint}`;
  return `\n（${totalText}，本次显示 ${shown} 条${hint}）`;
}

/**
 * 输出头：标题 + 来源 + 时间等信息，便于模型引用。
 * @param {Array<string|undefined|null>} lines - 头信息行。
 * @returns {string} 头部文本（每条一行，末尾空行分隔）。
 */
export function header(lines) {
  const kept = lines.filter((line) => typeof line === 'string' && line !== '');
  return kept.length === 0 ? '' : `${kept.join('\n')}\n\n`;
}
