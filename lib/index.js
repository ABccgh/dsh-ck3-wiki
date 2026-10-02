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

import { createHttpClient, ensureSystemCaTrusted, systemCaStatus } from './http.js';
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
const DEFAULT_USER_AGENT = 'dsh-ck3wiki/0.1 (+https://github.com/ABccgh/dsh-ck3-wiki; read-only)';

/** `trustSystemCa` 的合法取值。 */
const CA_MODES = new Set(['auto', 'always', 'never']);

/**
 * 配置字段与默认值（无 Schemastery schema，取值由 `normalizeConfig` 兜底）：
 *
 * | 字段 | 默认 | 说明 |
 * | --- | --- | --- |
 * | `wikiBaseUrl` | `https://ck3.paradoxwikis.com` | 站点根 URL（换成别的 Paradox MediaWiki 也能用） |
 * | `apiPath` | `/api.php` | 接口路径 |
 * | `userAgent` | `dsh-ck3wiki/0.1 (+…; read-only)` | 必须保留「名字 + 联系地址」的机器人写法 |
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
 * 这里不抛错：一个写错的字段不应该让整个插件装不上，回退到默认值并留一行日志更合适。
 * @param {Record<string, unknown>} raw - loader 校验后的配置。
 * @returns {{ wikiBaseUrl: string, apiPath: string, userAgent: string, requestTimeoutMs: number,
 *   maxChars: number, maxListedItems: number, cacheTtlMs: number, trustSystemCa: string,
 *   webFallback: boolean, noisePatterns: string[], dropClasses: string[],
 *   extraDropClasses: string[] }} 生效配置。
 */
export function normalizeConfig(raw = {}) {
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

  const configuredBase = text(raw.wikiBaseUrl, DEFAULT_BASE_URL).replace(/\/+$/, '');
  const baseUrl = /^https?:\/\//i.test(configuredBase) ? configuredBase : DEFAULT_BASE_URL;

  return {
    wikiBaseUrl: baseUrl,
    apiPath: normalizeApiPath(text(raw.apiPath, '/api.php')),
    userAgent: text(raw.userAgent, DEFAULT_USER_AGENT),
    requestTimeoutMs: positive(raw.requestTimeoutMs, 15_000),
    maxChars: positive(raw.maxChars, 20_000),
    maxListedItems: positive(raw.maxListedItems, 100),
    cacheTtlMs: nonNegative(raw.cacheTtlMs, 60_000),
    trustSystemCa: CA_MODES.has(raw.trustSystemCa) ? String(raw.trustSystemCa) : 'auto',
    webFallback: raw.webFallback !== false,
    // 注意：显式传 `[]` 就是「关闭行级过滤」，所以这里不能用 `list.length === 0` 回退默认值。
    noisePatterns: patternList(raw.noisePatterns),
    // 同理：`dropClasses: []` = 不做 class 过滤（编辑链接、脚注角标、导航盒都会回来）。
    dropClasses: classList(raw.dropClasses, DEFAULT_DROP_CLASSES),
    extraDropClasses: classList(raw.extraDropClasses, []),
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

  // 只在「配置里确实写了 wikiBaseUrl」且它不合法时警告；字段缺省不是错误。
  const rawBase = typeof config?.wikiBaseUrl === 'string' ? config.wikiBaseUrl.trim() : '';
  if (rawBase !== '' && effective.wikiBaseUrl !== rawBase.replace(/\/+$/, '')) {
    log('warn', `wikiBaseUrl=${rawBase} 看起来不是 http(s) 地址，已回退到 ${effective.wikiBaseUrl}。`);
  }

  const http = createHttpClient({
    timeoutMs: effective.requestTimeoutMs,
    userAgent: effective.userAgent,
    trustSystemCa: effective.trustSystemCa,
    webFallback: effective.webFallback,
    fetchImpl: overrides.fetchImpl,
    getWeb: () => ctx.get?.('web'),
  });

  const reader = createJsonReader(http, { ttlMs: effective.cacheTtlMs, maxEntries: 50 });

  /** 插件级诊断状态：`ck3wiki_status` 会把最近一次探测结果回报出来。 */
  const state = {
    /** @type {{ at: string, ok: boolean, via?: string, error?: string, challenge?: boolean }|undefined} */
    lastProbe: undefined,
    systemCa: systemCaStatus,
  };

  const deps = { http, reader, state, log };
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
