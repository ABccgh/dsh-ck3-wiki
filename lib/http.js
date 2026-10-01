/**
 * 出网层：只做四件事——带上正确的 User-Agent、管超时与重试、处理 TLS 证书、
 * 在遇到 Fastly 反爬挑战页时提供一条兜底通道。
 *
 * ## 为什么 User-Agent 是这一层最重要的一行
 *
 * `ck3.paradoxwikis.com` 在 Fastly 之后。实测（2026-10-01）：
 *
 * | User-Agent | 结果 |
 * | --- | --- |
 * | `Mozilla/5.0 … Chrome/131 …`（伪装浏览器） | 6/6 返回 `_fs_ch_st_*` 挑战页（HTTP 200 + HTML） |
 * | `node`（undici 默认） | 挑战页 |
 * | `dsh-ck3wiki/0.1`（裸名字） | 挑战页 |
 * | `dsh-ck3wiki/0.1 (+https://github.com/…; read-only)` | 6/6 正常返回 JSON |
 *
 * 结论：**不要伪装浏览器**。带「名字 + 联系地址」的机器人 UA 才是被放行的写法，
 * 这也正好符合 MediaWiki 自己的 UA 政策。所以这里默认就是这种写法，可配置但别改成浏览器。
 *
 * ## 挑战页的识别
 *
 * 关键点是它返回 **HTTP 200**：只看状态码会把它当成成功，然后死在 `JSON.parse` 上，
 * 报出「响应不是合法 JSON」这种毫无指向性的错误。这里先看 `content-type` 与响应体开头，
 * 判定为挑战后给出可执行的修复建议，并（默认）用 DSH 自己的 `web` 服务再取一次同一 URL
 * ——实测那条通道能正常拿到 JSON。
 *
 * 不自己管代理：DSH 已经把 undici 的全局 dispatcher 装好，这里的 `fetch` 自动走同一套策略。
 *
 * @module dsh-ck3-wiki/http
 */

import tls from 'node:tls';

/** 表示「证书链验证不过」的错误码。 */
const CERTIFICATE_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_SIGNATURE_FAILURE',
  'CERT_UNTRUSTED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_HAS_EXPIRED',
]);

/** 合并系统 CA 的结果；进程内只做一次。 */
let systemCaState = { merged: false, added: 0, total: 0, error: undefined };

/**
 * 沿 `cause` 链找到第一个带 `code` 的错误码。undici 会把真实原因藏在 `error.cause.cause`。
 * @param {unknown} cause - 捕获到的异常。
 * @returns {string} 错误码，找不到时为空字符串。
 */
export function findErrorCode(cause) {
  let current = cause;
  for (let depth = 0; depth < 6 && current; depth += 1) {
    if (typeof current === 'object' && 'code' in current && typeof current.code === 'string') return current.code;
    current = typeof current === 'object' && 'cause' in current ? current.cause : undefined;
  }
  return '';
}

/**
 * 沿 `cause` 链找最内层的可读消息。
 * @param {unknown} cause - 捕获到的异常。
 * @returns {string} 消息文本。
 */
function deepestMessage(cause) {
  let current = cause;
  let message = '';
  for (let depth = 0; depth < 6 && current; depth += 1) {
    if (current instanceof Error && current.message) message = current.message;
    current = typeof current === 'object' && 'cause' in current ? current.cause : undefined;
  }
  return message;
}

/**
 * 判断异常是不是证书验证失败。
 * @param {unknown} cause - 捕获到的异常。
 * @returns {boolean} 是否属于证书问题。
 */
export function isCertificateError(cause) {
  return CERTIFICATE_CODES.has(findErrorCode(cause)) || /certificate|self.signed/i.test(deepestMessage(cause));
}

/**
 * 把系统根证书并入 Node 默认的 CA 列表。幂等，进程内只生效一次。
 * @returns {{ merged: boolean, added: number, total: number, error?: string }} 合并结果。
 */
export function ensureSystemCaTrusted() {
  if (systemCaState.merged || systemCaState.error !== undefined) return systemCaState;
  try {
    const current = tls.getCACertificates('default');
    const system = tls.getCACertificates('system');
    const before = current.length;
    tls.setDefaultCACertificates([...new Set([...current, ...system])]);
    // 读回来的数量才是生效值：setDefaultCACertificates 会丢弃它不接受的条目，
    // 也可能按内容去重，所以不能用拼出来的数组长度当结果。
    const observed = tls.getCACertificates('default').length;
    systemCaState = { merged: true, added: Math.max(0, observed - before), total: observed };
  } catch (cause) {
    systemCaState = {
      merged: false,
      added: 0,
      total: 0,
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
  return systemCaState;
}

/**
 * 当前的系统 CA 合并状态（供 `ck3wiki_status` 诊断用）。
 * @returns {{ merged: boolean, added: number, total: number, error?: string }} 状态快照。
 */
export function systemCaStatus() {
  return { ...systemCaState };
}

/**
 * 针对错误码给出可执行的建议。
 * @param {string} code - 归一化后的错误码。
 * @returns {string} 建议文本（可能为空）。
 */
export function hintForCode(code) {
  if (code === 'ECONNREFUSED') {
    return '连接被拒绝：本机 hosts 可能把该域名指向了 127.0.0.1（Steam++ / Watt Toolkit 之类的加速工具），但加速器当前没有运行。启动加速器，或把它的 hosts 加速模式关掉再试。';
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return '域名解析失败：检查网络与 DNS。';
  if (CERTIFICATE_CODES.has(code)) {
    return 'TLS 证书链无法验证：多半是本机加速器用自签名证书接管了该域名。保持 trustSystemCa 为 auto（默认）或 always。';
  }
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return '连接超时：检查网络或代理。';
  if (code === 'ECONNRESET') return '连接被重置：可能是网络中间设备中断了请求。';
  return '';
}

/**
 * 把 HTTP 状态码翻译成可执行的建议。
 * @param {number} status - 状态码。
 * @returns {string} 建议文本（可能为空）。
 */
export function explainHttpStatus(status) {
  switch (status) {
    case 400:
      return '请求参数被 wiki 拒绝（常见原因：标题里的特殊字符没编码好、section 越界）';
    case 403:
      return '被拒绝：通常是 User-Agent 政策或反爬规则——保留带联系地址的机器人 UA，不要伪装浏览器';
    case 404:
      return '接口路径不存在：检查 apiPath 配置';
    case 429:
      return '被限流，稍后重试';
    case 500:
    case 502:
    case 503:
    case 504:
      return 'wiki 侧暂时不可用';
    default:
      return '';
  }
}

/**
 * 判断响应是不是反爬挑战页（HTTP 200 + HTML）。
 * @param {Response} response - fetch 响应。
 * @param {string} body - 响应体文本。
 * @returns {boolean} 是否为挑战页。
 */
export function isChallengeResponse(response, body) {
  const contentType = String(response.headers?.get?.('content-type') ?? '').toLowerCase();
  if (!contentType.includes('text/html')) return false;
  const head = body.slice(0, 600);
  return /<\!doctype html/i.test(head) || /<html/i.test(head) || /_fs-ch-|cf-chl|challenge/i.test(head);
}

/**
 * 把「挑战页」翻译成一段人能照着做的话。
 * @param {string} url - 出问题的 URL。
 * @param {string} userAgent - 当时用的 UA。
 * @returns {string} 报错正文。
 */
export function challengeMessage(url, userAgent) {
  return [
    '被 wiki 的反爬挑战页拦下了（HTTP 200，但返回的是 HTML 而不是 JSON）。',
    `请求：${url}`,
    `当前 User-Agent：${userAgent}`,
    '该站在 Fastly 之后：伪装成浏览器的 UA（Mozilla/… Chrome/…）必然被挑战；',
    '请保留带联系地址的机器人 UA 写法，例如 dsh-ck3wiki/0.1 (+https://…; read-only)。',
    '改法：cordis.patch.yml 的 userAgent 字段 → 在「插件」页把 ck3wiki 关开一次。',
  ].join('\n');
}

/**
 * 从 DSH `web` 服务的返回里取出可解析的 JSON。
 * @param {{ statusCode?: number, body?: { content?: string } }} result - WebFetchResult。
 * @returns {{ status: number, data: unknown } | undefined} 解析成功时的结果。
 */
export function jsonFromWebFetch(result) {
  const content = result?.body?.content;
  if (typeof content !== 'string') return undefined;
  try {
    return { status: Number(result?.statusCode ?? 0), data: JSON.parse(content) };
  } catch {
    return undefined;
  }
}

/**
 * 取一次 JSON。调用方永远不需要 try/catch。
 * @param {string} url - 完整 URL。
 * @param {{ timeoutMs?: number, userAgent?: string, retries?: number, signal?: AbortSignal,
 *   trustSystemCa?: 'auto'|'always'|'never', fetchImpl?: Function, webFallback?: boolean,
 *   getWeb?: () => any }} options - 选项。`retries` 是**额外**重试次数（默认 1，只在 5xx/网络错误上重试）。
 * @returns {Promise<{ ok: true, status: number, data: unknown, url: string, via: 'http'|'dsh-web' } |
 *   { ok: false, error: string, url: string, hint?: string, code?: string, status?: number, body?: string,
 *   challenge?: boolean, aborted?: boolean, via?: string }>} 归一化结果。
 */
export async function fetchJson(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const userAgent = options.userAgent ?? 'dsh-ck3wiki/0.1';
  const trustSystemCa = options.trustSystemCa ?? 'auto';
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const headers = { Accept: 'application/json', 'User-Agent': userAgent, ...(options.headers ?? {}) };

  if (trustSystemCa === 'always') ensureSystemCaTrusted();

  let remainingRetries = options.retries ?? 1;
  let caRetryUsed = false;
  let challengeSeen = false;
  let lastCode = '';
  let lastMessage = '请求失败';
  let lastHint = '';
  let lastStatus;
  let lastBody;

  for (;;) {
    if (options.signal?.aborted) return { ok: false, error: '请求已被取消', url, aborted: true };

    const signals = [AbortSignal.timeout(timeoutMs)];
    if (options.signal) signals.push(options.signal);
    const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);

    try {
      const response = await fetchImpl(url, { headers, signal, redirect: 'follow' });
      const text = await response.text();
      lastStatus = response.status;

      if (!response.ok) {
        const hint = explainHttpStatus(response.status);
        if (response.status >= 500 && remainingRetries > 0) {
          remainingRetries -= 1;
          lastMessage = `HTTP ${response.status}`;
          lastHint = hint;
          continue;
        }
        if (response.status === 429 && remainingRetries > 0) {
          remainingRetries -= 1;
          lastMessage = 'HTTP 429';
          lastHint = hint;
          await sleep(retryAfterMs(response), signal);
          continue;
        }
        return {
          ok: false,
          status: response.status,
          error: `HTTP ${response.status}${hint === '' ? '' : `：${hint}`}`,
          hint,
          body: text.slice(0, 400),
          url,
        };
      }

      if (isChallengeResponse(response, text)) {
        challengeSeen = true;
        lastBody = text.slice(0, 400);
        break;
      }

      try {
        return { ok: true, status: response.status, data: JSON.parse(text), url, via: 'http' };
      } catch {
        lastMessage = '响应不是合法的 JSON';
        lastHint = '可能是网络中间层把响应替换成了 HTML 页面。';
        lastBody = text.slice(0, 400);
        break;
      }
    } catch (cause) {
      if (options.signal?.aborted) return { ok: false, error: '请求已被取消', url, aborted: true };

      lastCode = findErrorCode(cause);
      lastMessage = deepestMessage(cause) || (cause instanceof Error ? cause.message : String(cause));
      lastHint = hintForCode(lastCode);

      // 证书错误：把系统根证书并进来再试一次。这次重试不占普通重试预算，且最多一次。
      if (trustSystemCa === 'auto' && !caRetryUsed && isCertificateError(cause)) {
        caRetryUsed = true;
        const state = ensureSystemCaTrusted();
        if (state.merged && state.added > 0) continue;
        lastHint = state.error !== undefined
          ? `TLS 证书验证失败，且无法读取系统根证书：${state.error}`
          : 'TLS 证书验证失败；系统根证书已合并但问题依旧，请检查加速器或改用代理。';
      }

      if (lastCode === 'TimeoutError' || lastMessage === 'The operation was aborted due to timeout') {
        lastMessage = '请求超时';
        lastCode = 'ETIMEDOUT';
        lastHint = hintForCode('ETIMEDOUT');
      }

      if (remainingRetries > 0) {
        remainingRetries -= 1;
        continue;
      }
      break;
    }
  }

  // 兜底：同一 URL 交给 DSH 自己的 web 服务再取一次（实测该通道能拿到 JSON）。
  if (options.webFallback !== false && typeof options.getWeb === 'function') {
    const web = safeGetWeb(options.getWeb);
    if (web !== undefined) {
      try {
        const result = await web.fetch({ url }, options.signal);
        const parsed = jsonFromWebFetch(result);
        if (parsed !== undefined) {
          return { ok: true, status: parsed.status || 200, data: parsed.data, url, via: 'dsh-web' };
        }
        return {
          ok: false,
          error: challengeSeen
            ? '被反爬挑战页拦下；改用 DSH web 服务兜底后仍拿不到 JSON。'
            : `${lastMessage}；改用 DSH web 服务兜底后仍拿不到 JSON。`,
          hint: challengeSeen ? 'User-Agent 是首要嫌疑：保留带联系地址的机器人 UA。' : lastHint,
          challenge: challengeSeen,
          body: lastBody,
          url,
          via: 'dsh-web',
        };
      } catch (cause) {
        lastMessage = `${lastMessage}；DSH web 服务兜底也失败：${cause instanceof Error ? cause.message : String(cause)}`;
      }
    }
  }

  if (challengeSeen) {
    return {
      ok: false,
      error: challengeMessage(url, userAgent),
      challenge: true,
      hint: 'User-Agent 是首要嫌疑：保留带联系名字与联系地址的机器人 UA。',
      status: lastStatus,
      body: lastBody,
      url,
    };
  }

  const suffix = lastMessage === '请求超时' ? `（超过 ${timeoutMs} ms）` : '';
  return { ok: false, error: `${lastMessage}${suffix}`, hint: lastHint, code: lastCode, status: lastStatus, body: lastBody, url };
}

/**
 * 读 `Retry-After`（秒或 HTTP 日期），上限 3 秒，避免把工具调用拖死。
 * @param {Response} response - 429 响应。
 * @returns {number} 等待毫秒数。
 */
function retryAfterMs(response) {
  const raw = response.headers?.get?.('retry-after');
  if (raw === null || raw === undefined || raw === '') return 500;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.min(3000, Math.max(0, seconds * 1000));
  const when = Date.parse(raw);
  if (Number.isFinite(when)) return Math.min(3000, Math.max(0, when - Date.now()));
  return 500;
}

/**
 * 可被中断的等待。
 * @param {number} ms - 毫秒。
 * @param {AbortSignal} [signal] - 取消信号。
 * @returns {Promise<void>} 无。
 */
function sleep(ms, signal) {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

/**
 * 安全地拿 `web` 服务：没有该服务、或调用抛错时都返回 undefined，不该因此让工具失败。
 * @param {() => any} getWeb - 取服务函数。
 * @returns {any|undefined} 服务实例。
 */
function safeGetWeb(getWeb) {
  try {
    const web = getWeb();
    return web !== undefined && web !== null && typeof web.fetch === 'function' ? web : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 造一个带上默认超时、UA、证书策略与兜底通道的取数器。
 * @param {{ timeoutMs?: number, userAgent?: string, trustSystemCa?: 'auto'|'always'|'never',
 *   fetchImpl?: Function, webFallback?: boolean, getWeb?: () => any }} [defaults] - 默认值。
 * @returns {{ json: (url: string, options?: object) => Promise<object>, timeoutMs: number,
 *   userAgent: string, trustSystemCa: string }} 取数器。
 */
export function createHttpClient(defaults = {}) {
  const timeoutMs = defaults.timeoutMs ?? 15_000;
  const userAgent = defaults.userAgent ?? 'dsh-ck3wiki/0.1';
  const trustSystemCa = defaults.trustSystemCa ?? 'auto';
  const webFallback = defaults.webFallback !== false;
  return {
    timeoutMs,
    userAgent,
    trustSystemCa,
    json(url, options = {}) {
      return fetchJson(url, {
        timeoutMs,
        userAgent,
        trustSystemCa,
        webFallback,
        getWeb: defaults.getWeb,
        fetchImpl: defaults.fetchImpl,
        ...options,
      });
    },
  };
}
