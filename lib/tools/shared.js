/**
 * 工具层共用件：统一输出形状、上限裁剪、URL 级只读缓存、时间格式化，以及
 * 「HTTP 结果 → 抛错或取值」的归一。
 *
 * @module dsh-ck3-wiki/tools/shared
 */

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
 * 归一「命名空间」参数：接受 id、命名空间名字，或 `*` / `all`（表示全部命名空间）。
 * MediaWiki 这几种写法都认，这里只做透传与默认值。
 * @param {unknown} value - 模型传来的值。
 * @param {number|string} [fallback] - 缺省值（默认 0，即主条目）。
 * @returns {string} 传给接口的值。
 */
export function namespaceParam(value, fallback = 0) {
  if (value === undefined || value === null || value === '') return String(fallback);
  if (typeof value === 'number') return Number.isFinite(value) ? String(Math.trunc(value)) : String(fallback);
  const text = String(value).trim();
  if (text === '') return String(fallback);
  if (text === '*' || /^all$/i.test(text)) return '*';
  return text;
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
 * 把出网层的结果变成「值或异常」。
 * @param {{ ok: boolean, data?: unknown, error?: string, hint?: string, challenge?: boolean, url?: string,
 *   via?: string }} result - `fetchJson` 的结果。
 * @param {string} what - 这次请求在做什么（写进错误消息）。
 * @returns {unknown} 解析后的 JSON。
 * @throws {Error} 失败时抛出带建议的错误。
 */
export function unwrap(result, what) {
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
