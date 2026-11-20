/**
 * dsh-ck3-wiki 的 Cordis 插件入口。
 *
 * 把 CK3 官方 Wiki（ck3.paradoxwikis.com，MediaWiki 1.39 + CirrusSearch）接进 DSH，
 * 注册 **9 个只读工具**：
 *
 * - 发现：`ck3wiki_status`、`ck3wiki_search`、`ck3wiki_titles`
 * - 页面：`ck3wiki_page`、`ck3wiki_page_info`、`ck3wiki_sections`
 * - 导航：`ck3wiki_links`、`ck3wiki_category`、`ck3wiki_recent_changes`
 *
 * 全部只读：不改 wiki 内容、不需要登录、不需要任何密钥。
 *
 * **本模块刻意不 import 任何 `@deepseek-ai/*` 包。** 插件是 `link:` 安装的 profile bundle，
 * 代码在 DSH 安装作用域之外，DSH 的 profile 解析路由不会把 bundle 里的 `@deepseek-ai/*`
 * 导入重定向到安装目录——一旦 import 就会让整个插件以 ERR_MODULE_NOT_FOUND 加载失败。
 * 同理这里不导出 `Config`：`resolveConfig` 在没有 `Config` 时会原样透传配置对象，
 * 校验与默认值由下面的 `normalizeConfig` 负责。
 *
 * @module @local/ck3wiki
 */

import { createHttpClient, ensureSystemCaTrusted } from './http.js';
import { DEFAULT_DROP_CLASSES, DEFAULT_NOISE_PATTERNS } from './html-text.js';
import { normalizeApiPath } from './mediawiki.js';
import { registerDiscoveryTools } from './tools/discovery.js';
import { registerNavigateTools } from './tools/navigate.js';
import { registerPageTools } from './tools/page.js';
import { createJsonReader } from './tools/shared.js';

/** 插件名，也是 loader row 的 `name` 里 App 面的标识。 */
export const name = 'ck3wiki';

/** 工具注册表是本插件的硬依赖；`web` 只在兜底时用可选注入。 */
export const inject = ['tools'];

/** 默认站点。 */
const DEFAULT_BASE_URL = 'https://ck3.paradoxwikis.com';

/**
 * 默认 User-Agent。
 *
 * **不要改成浏览器 UA**：该站在 Fastly 之后，实测伪装浏览器的 UA 100% 被挑战页拦下，
 * 而带联系地址的机器人 UA 稳定通过（详见 lib/http.js 的模块注释）。
 */
const DEFAULT_USER_AGENT = 'dsh-ck3wiki/0.2.0 (+https://github.com/ABccgh/dsh-ck3-wiki; read-only)';

/** `trustSystemCa` 的合法取值。 */
const CA_MODES = new Set(['auto', 'always', 'never']);

/**
 * 配置字段与默认值（无 Schemastery schema，取值由 `normalizeConfig` 兜底）：
 *
 * | 字段 | 默认 | 说明 |
 * | --- | --- | --- |
 * | `wikiBaseUrl` | `https://ck3.paradoxwikis.com` | 站点根 URL（换成别的 Paradox MediaWiki 也能用） |
 * | `apiPath` | `/api.php` | 接口路径 |
 * | `userAgent` | `dsh-ck3wiki/0.2.0 (+…; read-only)` | 必须保留「名字 + 联系地址」的机器人写法 |
 * | `requestTimeoutMs` | `15000` | 单次 HTTP 超时 |
 * | `maxChars` | `20000` | 页面文本默认截断上限 |
 * | `maxListedItems` | `100` | 列表类工具硬上限 |
 * | `cacheTtlMs` | `60000` | 只读结果 TTL 缓存（含单飞去重） |
 * | `trustSystemCa` | `auto` | `auto` / `always` / `never` |
 * | `webFallback` | `true` | 直连失败/被挑战时是否用 DSH web 服务再取一次 |
 * | `noisePatterns` | 见 `html-text.js` | 行级噪声正则（锚定整行）；`[]` 关闭。站方换嵌入服务时用它兜底 |
 * | `dropClasses` | 见 `html-text.js` | 整块丢弃的 class 表（**替换**默认表）；`[]` = 不做 class 过滤 |
 * | `extraDropClasses` | `[]` | 在生效表之上**追加**要丢的 class（"只想多丢一个" 用这个，默认表改进也能跟上） |
 */

/**
 * 把 loader 传来的配置收进合法范围。
 *
 * 这里不抛错：一个写错的字段不应该让整个插件装不上，回退到默认值并留一行日志更合适。
 * **每个被拒字段都单独记一条 `configWarnings`**：只报第一个会让用户改一个、重启一次、
 * 再发现一个；`apply` 会逐条 `log('warn', …)`。
 *
 * @param {Record<string, unknown>} raw - loader 校验后的配置。
 * @returns {{ wikiBaseUrl: string, apiPath: string, userAgent: string, requestTimeoutMs: number,
 *   maxChars: number, maxListedItems: number, cacheTtlMs: number, trustSystemCa: string,
 *   webFallback: boolean, noisePatterns: string[], dropClasses: string[],
 *   extraDropClasses: string[], configWarnings: string[] }} 生效配置。
 */
export function normalizeConfig(raw = {}) {
  const source = raw !== null && typeof raw === 'object' ? raw : {};
  /** @type {string[]} */
  const configWarnings = [];
  /** 字段是否真的被配置写了（缺省不算错）。 */
  const configured = (key) => Object.hasOwn(source, key) && source[key] !== undefined && source[key] !== null;
  const bad = (key, fallbackText) => {
    configWarnings.push(`${key}=${JSON.stringify(source[key])} 不合法，已回退到 ${fallbackText}。`);
  };

  const text = (value, fallback) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback);
  const positive = (value, fallback) => (Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback);
  const nonNegative = (value, fallback) => (Number.isFinite(value) && value >= 0 ? Math.trunc(value) : fallback);
  const patternList = (value) => {
    if (!Array.isArray(value)) return [...DEFAULT_NOISE_PATTERNS];
    return value.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim());
  };
  const classList = (value, fallback) => (!Array.isArray(value)
    ? [...fallback]
    : value.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim()));

  const configuredBase = text(source.wikiBaseUrl, DEFAULT_BASE_URL).replace(/\/+$/, '');
  const baseUrl = /^https?:\/\//i.test(configuredBase) ? configuredBase : DEFAULT_BASE_URL;
  if (configured('wikiBaseUrl') && baseUrl !== configuredBase) {
    configWarnings.push(
      `wikiBaseUrl=${typeof source.wikiBaseUrl === 'string' ? source.wikiBaseUrl.trim() : JSON.stringify(source.wikiBaseUrl)}`
      + ` 看起来不是 http(s) 地址，已回退到 ${DEFAULT_BASE_URL}。`,
    );
  }
  if (configured('apiPath') && (typeof source.apiPath !== 'string' || source.apiPath.trim() === '')) bad('apiPath', '/api.php');
  if (configured('userAgent') && (typeof source.userAgent !== 'string' || source.userAgent.trim() === '')) bad('userAgent', '内置机器人 UA');
  if (configured('requestTimeoutMs') && !(Number.isFinite(source.requestTimeoutMs) && source.requestTimeoutMs > 0)) bad('requestTimeoutMs', '15000');
  if (configured('maxChars') && !(Number.isFinite(source.maxChars) && source.maxChars > 0)) bad('maxChars', '20000');
  if (configured('maxListedItems') && !(Number.isFinite(source.maxListedItems) && source.maxListedItems > 0)) bad('maxListedItems', '100');
  if (configured('cacheTtlMs') && !(Number.isFinite(source.cacheTtlMs) && source.cacheTtlMs >= 0)) bad('cacheTtlMs', '60000');
  if (configured('trustSystemCa') && !CA_MODES.has(source.trustSystemCa)) bad('trustSystemCa', 'auto（可选 auto / always / never）');
  if (configured('webFallback') && typeof source.webFallback !== 'boolean') bad('webFallback', 'true');
  if (configured('noisePatterns')) {
    if (!Array.isArray(source.noisePatterns)) bad('noisePatterns', '内置噪声表');
    else {
      const dropped = source.noisePatterns.filter((item) => typeof item !== 'string' || item.trim() === '').length;
      if (dropped > 0) configWarnings.push(`noisePatterns 里有 ${dropped} 项不是非空字符串，已忽略。`);
    }
  }
  for (const field of ['dropClasses', 'extraDropClasses']) {
    if (!configured(field)) continue;
    if (!Array.isArray(source[field])) {
      bad(field, field === 'dropClasses' ? '内置 class 表' : '空表');
      continue;
    }
    const dropped = source[field].filter((item) => typeof item !== 'string' || item.trim() === '').length;
    if (dropped > 0) configWarnings.push(`${field} 里有 ${dropped} 项不是非空字符串，已忽略。`);
  }

  return {
    wikiBaseUrl: baseUrl,
    apiPath: normalizeApiPath(typeof source.apiPath === 'string' && source.apiPath.trim() !== '' ? source.apiPath : '/api.php'),
    userAgent: text(source.userAgent, DEFAULT_USER_AGENT),
    requestTimeoutMs: positive(source.requestTimeoutMs, 15_000),
    maxChars: positive(source.maxChars, 20_000),
    maxListedItems: positive(source.maxListedItems, 100),
    cacheTtlMs: nonNegative(source.cacheTtlMs, 60_000),
    trustSystemCa: CA_MODES.has(source.trustSystemCa) ? String(source.trustSystemCa) : 'auto',
    webFallback: source.webFallback !== false,
    // 注意：显式传 `[]` 就是「关闭行级过滤」，所以这里不能用 `list.length === 0` 回退默认值。
    noisePatterns: patternList(source.noisePatterns),
    // 同理：`dropClasses: []` = 不做 class 过滤（编辑链接、脚注角标、导航盒都会回来）。
    dropClasses: classList(source.dropClasses, DEFAULT_DROP_CLASSES),
    extraDropClasses: classList(source.extraDropClasses, []),
    configWarnings,
  };
}

/**
 * 装配插件。
 *
 * @param {object} ctx - Cordis 上下文（硬依赖 `tools`，可选 `web`、`logger`）。
 * @param {Record<string, unknown>} config - loader 校验后的配置。
 * @param {{ fetchImpl?: Function }} [overrides] - 测试用接缝：替换出网实现（生产路径不传）。
 * @returns {Promise<void>} 无。
 *
 * 注意**不要返回任何值**：Cordis 会把 `apply` 的返回值当成 effect 去收集，
 * 返回字符串数组会以「Invalid effect」让整个插件激活失败（实测踩过）。
 * 已注册的工具名只用于日志。
 */
export async function apply(ctx, config, overrides = {}) {
  const effective = normalizeConfig(config);

  /** 记一行日志；日志不可用不该影响插件本身。 */
  const log = (level, message) => {
    try {
      ctx.logger?.[level]?.(`[ck3wiki] ${message}`);
    } catch {
      // 日志失败无所谓。
    }
  };

  // 配置里每个被拒字段都已在 normalizeConfig 里记成一条告警，这里逐条打出来。
  for (const warning of effective.configWarnings) log('warn', warning);

  const http = createHttpClient({
    timeoutMs: effective.requestTimeoutMs,
    userAgent: effective.userAgent,
    trustSystemCa: effective.trustSystemCa,
    webFallback: effective.webFallback,
    fetchImpl: overrides.fetchImpl,
    getWeb: () => ctx.get?.('web'),
  });

  const reader = createJsonReader(http, { ttlMs: effective.cacheTtlMs, maxEntries: 50 });

  const deps = { http, reader, log };
  const names = [
    ...registerDiscoveryTools(ctx, effective, deps),
    ...registerPageTools(ctx, effective, deps),
    ...registerNavigateTools(ctx, effective, deps),
  ];

  if (effective.trustSystemCa === 'always') {
    const ca = ensureSystemCaTrusted();
    log(
      'info',
      ca.error === undefined
        ? `trustSystemCa=always：已并入系统根证书（+${ca.added}，共 ${ca.total}）。`
        : `trustSystemCa=always：并入系统根证书失败——${ca.error}`,
    );
  }

  log(
    'info',
    `就绪：${names.length} 个只读工具；站点 ${effective.wikiBaseUrl}${effective.apiPath}，`
    + `缓存 TTL ${effective.cacheTtlMs} ms，webFallback=${effective.webFallback ? 'on' : 'off'}，`
    + `trustSystemCa=${effective.trustSystemCa}。`,
  );
}
