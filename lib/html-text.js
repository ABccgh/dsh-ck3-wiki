/**
 * HTML → 可读文本的归约器（**纯函数、零依赖**）。
 *
 * 为什么要自己写：`action=parse&prop=text` 返回的是整页渲染 HTML——实测 `Modding` 页 85 KB、
 * `Traits` 页 760 KB，其中大头是导航盒、编辑链接、引用角标和层层嵌套的表格。直接丢给模型
 * 既贵又噪声大；只留 wikitext 又会把表格类信息变成难读的模板参数。
 *
 * 这里做的是**有损但可读**的转换：
 * - 丢掉纯装饰/导航块（编辑链接、导航盒、版本横幅、分类链接、隐藏元素、脚注角标）；
 * - 保留结构：标题降级成 `#`，列表带缩进，表格降成 `| 单元格 | 单元格 |` 行；
 * - 行内只保留信息：链接取文本、粗体 `**`、斜体 `*`、等宽 `` ` ``；
 * - 最后展平空白、解码实体，并在 `maxChars` 处按行边界截断。
 *
 * @module dsh-ck3-wiki/html-text
 */

/** 自闭合标签：不会影响标签配对。 */
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

/**
 * 整块丢掉的 class（命中任一即丢，含其子树）。
 *
 * 这是**出厂默认表**，插件配置里可以整体替换（`dropClasses`）或在它之上追加（`extraDropClasses`）。
 * 表里必须有 `embedvideo-consent`，否则视频装饰会回来。
 */
export const DEFAULT_DROP_CLASSES = [
  'mw-editsection',
  'navbox',
  'metadata',
  'catlinks',
  'noprint',
  'mw-jump-link',
  'printfooter',
  'mw-collapsible-toggle',
  'mw-empty-elt',
  'mw-hidden-catlinks',
  'reference',
  'mw-indicators',
  'mw-cite-backlink',
  'toc',
  // 视频嵌入的**装饰层**：Load video / YouTube / 「YouTube might collect personal data」。
  // 刻意**不丢整块 `embedvideo`**：`<figcaption>`（真正的视频标题）是它的同级兄弟，
  // 丢整块会连标题一起丢（2026-10-02 实测：Modding 页图注消失）。
  'embedvideo-consent',
];

/** 整块丢掉的标签（含其子树）。 */
const DROP_TAGS = new Set(['script', 'style', 'noscript', 'iframe', 'button', 'select', 'option', 'form', 'svg']);

/**
 * 行级噪声：锚定整行、命中即丢。
 *
 * 大部分站点装饰已经由 class 定点删掉了（见 `DROP_CLASSES` 的 `embedvideo-consent`），
 * 这里留一份**配置级安全网**：站方换嵌入服务、或 DOM 变了的时候，改配置就能挡掉，
 * 不必改代码。默认只收有实测证据的三条；`noisePatterns: []` 可整体关闭。
 */
export const DEFAULT_NOISE_PATTERNS = [
  '^Load video$',
  '^YouTube$',
  '^YouTube might collect personal data',
];

/** 常用的命名实体。 */
const NAMED_ENTITIES = new Map([
  ['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', "'"], ['nbsp', ' '],
  ['mdash', '—'], ['ndash', '–'], ['minus', '−'], ['hellip', '…'], ['middot', '·'],
  ['bull', '•'], ['deg', '°'], ['times', '×'], ['divide', '÷'], ['plusmn', '±'],
  ['laquo', '«'], ['raquo', '»'], ['ldquo', '“'], ['rdquo', '”'], ['lsquo', '‘'], ['rsquo', '’'],
  ['copy', '©'], ['reg', '®'], ['trade', '™'], ['euro', '€'], ['pound', '£'], ['yen', '¥'],
  ['sect', '§'], ['para', '¶'], ['dagger', '†'], ['Dagger', '‡'], ['prime', '′'], ['Prime', '″'],
  ['larr', '←'], ['rarr', '→'], ['uarr', '↑'], ['darr', '↓'], ['harr', '↔'],
  ['shy', ''], ['ensp', ' '], ['emsp', ' '], ['thinsp', ' '], ['zwnj', ''], ['zwj', ''],
]);

/**
 * 解码 HTML 实体（命名 + 十进制 + 十六进制）。
 * @param {string} text - 含实体的文本。
 * @returns {string} 解码后的文本。
 */
export function decodeEntities(text) {
  return String(text ?? '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body) => {
    if (body.startsWith('#')) {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    return NAMED_ENTITIES.has(body) ? NAMED_ENTITIES.get(body) : match;
  });
}

/**
 * 摘掉原始文本元素（`<script>` / `<style>` / `<textarea>` / `<title>`）的**内容**。
 *
 * `<script>` / `<style>` 的内容不是 HTML。按标签配对删除时，里面出现的 `'<div>'`、`'</span>'`
 * 这类**字符串**会把配对计数带偏，计数永不归零 → 一次吞掉后面整页
 * （同源代码在 PRTS 上实测：443,192 字符的页面只剩 435 字符，**92.9% 被吃掉**）。
 * 所以这里先按「开标签 → 最近的同名闭合标签」整块摘掉；找不到闭合标签时只摘开标签本身，
 * 其余内容保留（宁可留噪声，不丢正文）。
 * @param {string} html - HTML。
 * @returns {string} 摘掉原始文本元素后的 HTML。
 */
export function stripRawTextBlocks(html) {
  const source = String(html ?? '');
  const open = /<(script|style|textarea|title)\b[^>]*>/gi;
  let out = '';
  let last = 0;
  let match;
  while ((match = open.exec(source)) !== null) {
    const tag = match[1].toLowerCase();
    const close = new RegExp(`</${tag}\\s*>`, 'i').exec(source.slice(match.index + match[0].length));
    out += source.slice(last, match.index) + ' ';
    if (close === null) {
      last = match.index + match[0].length;
      open.lastIndex = last;
      continue;
    }
    last = match.index + match[0].length + close.index + close[0].length;
    open.lastIndex = last;
  }
  return out + source.slice(last);
}

/**
 * 去掉所有标签并解码实体——用于检索片段这类单行文本。
 *
 * **先删 `<script>` / `<style>` 的内容，再剥标签**：只剥标签会把脚本体当正文留下来
 * （bwiki 的检索片段里实测漏出过 `(window.RLQ = window.RLQ || []).push(...)`，
 * 本插件是同一份实现，同源缺陷；注释同理）。
 * @param {string} html - HTML 片段。
 * @returns {string} 纯文本。
 */
export function stripTags(html) {
  return decodeEntities(
    String(html ?? '')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<[^>]*>/g, ''),
  ).replace(/\s+/g, ' ').trim();
}

/**
 * 检索片段里的**行内**噪声：只删这几个字，句子其余部分是真内容。
 *
 * - `Error creating thumbnail: File missing` 与它的截断形态 `Error creating`：图片渲染失败时写进正文的
 *   报错文字。CirrusSearch 的片段有长度上限，实测会被截到只剩 `Error creating`，所以两种长度都列上；
 * - `Meta Modding • Patches • … Jargon`：页面底部那排站内导航，实测在 `Modding` 这类命中里占了相当大的比例。
 */
export const DEFAULT_SNIPPET_PHRASES = [
  'Error creating thumbnail: File missing',
  'Error creating',
  'Meta Modding • Patches • Downloadable content • Developer diaries • Achievements • Jargon',
];

/**
 * 检索片段里的**整句**噪声：命中即丢掉整句。
 *
 * 前三条是站点 cookie 提示（实测片段以 `collect personal data. Privacy Policy ContinueDismiss CK3 …` 开头）；
 * 后两条是 Paradox 站通用的「版本过旧」横幅模板文字（换关键词也躲不掉，因为它印在页面顶部）。
 */
export const DEFAULT_SNIPPET_SENTENCES = [
  'collect personal data',
  'Privacy Policy',
  'ContinueDismiss',
  'Please help with verifying',
  'or updating older sections',
];

/**
 * 把检索片段洗干净。
 *
 * CirrusSearch 的片段取自**渲染后的文本**，所以站点样板会混进来。这里分两级处理：
 *
 * 1. **行内噪声**（`DEFAULT_SNIPPET_PHRASES`）按词删——缩略图报错就夹在正文中间，
 *    整句删会把真内容一起带走；
 * 2. **整句噪声**（`DEFAULT_SNIPPET_SENTENCES`）按句子删——cookie 提示、版本横幅都是整句样板。
 *
 * 只删词组不删句子会留下「如果是 ~ ，哦～☆」这种残渣（bwiki 实测踩过），所以整句那级必须有。
 * @param {string} html - 片段。
 * @param {{ phrases?: string[], sentences?: string[] }} [options] - 覆盖默认词表（测试用）。
 * @returns {string} 干净文本。
 */
export function cleanSnippet(html, options = {}) {
  const phrases = Array.isArray(options.phrases) ? options.phrases : DEFAULT_SNIPPET_PHRASES;
  const sentences = (Array.isArray(options.sentences) ? options.sentences : DEFAULT_SNIPPET_SENTENCES)
    .filter((item) => typeof item === 'string' && item !== '')
    .map((item) => item.toLowerCase());

  let text = stripTags(html);
  for (const phrase of phrases) {
    if (typeof phrase === 'string' && phrase !== '') text = text.split(phrase).join(' ');
  }

  /** @type {string[]} */
  const kept = [];
  // 句末标点**后面必须跟空白或行尾**才算断句：否则 `https://www.reddit.com/x` 会被切碎
  // （实测 `Traditions` 的命中片段里有 reddit 链接，切成 `www. reddit. com`）。
  for (const segment of text.split(/(?<=[.!?;])(?=\s|$)|\n+/)) {
    const trimmed = segment.trim();
    if (trimmed === '') continue;
    const lowered = trimmed.toLowerCase();
    if (sentences.some((sentence) => lowered.includes(sentence))) continue;
    kept.push(trimmed);
  }
  return kept.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * 提取 `<div class="mw-parser-output">` 的主体；找不到时返回原串。
 * @param {string} html - 页面 HTML。
 * @returns {string} 正文 HTML。
 */
export function extractParserOutput(html) {
  // 先把原始文本元素与注释摘掉：它们的内容里可能有 `</div>` 之类字符串，会把配对计数带偏。
  const source = stripRawTextBlocks(String(html ?? '').replace(/<!--[\s\S]*?-->/g, ' '));
  const start = source.search(/<div[^>]*class="[^"]*\bmw-parser-output\b[^"]*"[^>]*>/i);
  if (start < 0) return source;
  const openEnd = source.indexOf('>', start) + 1;
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g;
  re.lastIndex = openEnd;
  let depth = 1;
  let match;
  while ((match = re.exec(source)) !== null) {
    const name = match[2].toLowerCase();
    if (VOID_TAGS.has(name)) continue;
    if (match[1] === '/') {
      depth -= 1;
      if (depth === 0) return source.slice(openEnd, match.index);
    } else {
      depth += 1;
    }
  }
  return source.slice(openEnd);
}

/**
 * 按断点删除整棵子树（`shouldDrop` 命中的元素连内容一起丢）。
 * @param {string} html - HTML。
 * @param {(tag: string, attrs: string) => boolean} shouldDrop - 断点判定。
 * @returns {string} 清理后的 HTML。
 */
export function removeElements(html, shouldDrop) {
  const source = String(html ?? '');
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g;
  let out = '';
  let last = 0;
  let dropDepth = 0;
  let match;
  while ((match = re.exec(source)) !== null) {
    const [full, closing, rawName, attrs] = match;
    const name = rawName.toLowerCase();
    if (dropDepth === 0) out += source.slice(last, match.index);
    last = match.index + full.length;

    if (VOID_TAGS.has(name)) {
      if (dropDepth === 0) out += full;
      continue;
    }
    if (closing !== '/') {
      if (dropDepth === 0 && shouldDrop(name, attrs)) dropDepth = 1;
      else if (dropDepth > 0) dropDepth += 1;
      else out += full;
      continue;
    }
    if (dropDepth > 0) dropDepth -= 1;
    else out += full;
  }
  if (dropDepth === 0) out += source.slice(last);
  return out;
}

/**
 * 头部噪声判定：装饰/导航块。
 * @param {string} tag - 标签名。
 * @param {string} attrs - 属性串。
 * @param {{ dropClasses: string[] }} options - 生效的 class 表（默认表与追加表已合并）。
 * @returns {boolean} 是否丢弃。
 */
function isNoise(tag, attrs, options) {
  if (DROP_TAGS.has(tag)) return true;
  const classMatch = /\bclass\s*=\s*("([^"]*)"|'([^']*)')/i.exec(attrs);
  if (classMatch === null) return false;
  const classes = (classMatch[2] ?? classMatch[3] ?? '').split(/\s+/);
  return classes.some((name) => options.dropClasses.includes(name));
}

/**
 * 列表转换：`ul` 用 `- `，`ol` 用递增序号，嵌套按深度缩进两格。
 * @param {string} html - HTML。
 * @returns {string} 转换后的 HTML（保留其余标签）。
 */
function convertLists(html) {
  const re = /<(\/?)(ul|ol|li)((?:"[^"]*"|'[^']*'|[^'">])*)>/gi;
  const stack = [];
  const counters = [];
  let out = '';
  let last = 0;
  let match;
  while ((match = re.exec(html)) !== null) {
    out += html.slice(last, match.index);
    last = match.index + match[0].length;
    const closing = match[1] === '/';
    const name = match[2].toLowerCase();
    if (!closing) {
      if (name === 'li') {
        const kind = stack[stack.length - 1];
        const indent = '  '.repeat(Math.max(0, stack.length - 1));
        if (kind === 'ol') {
          counters[counters.length - 1] += 1;
          out += `\n${indent}${counters[counters.length - 1]}. `;
        } else {
          out += `\n${indent}- `;
        }
      } else {
        stack.push(name);
        counters.push(0);
        out += '\n';
      }
    } else if (name !== 'li' && (name === 'ul' || name === 'ol')) {
      stack.pop();
      counters.pop();
      out += '\n';
    }
  }
  return out + html.slice(last);
}

/**
 * 表格式转换：整行降成 `| 单元格 | 单元格 |`。
 * @param {string} html - HTML。
 * @returns {string} 转换后的 HTML。
 */
function convertTables(html) {
  return html
    .replace(/<caption[^>]*>([\s\S]*?)<\/caption>/gi, (_match, inner) => `\n【表】${stripTags(inner)}\n`)
    .replace(/<tr[^>]*>/gi, '\n| ')
    .replace(/<t[hd][^>]*>/gi, '')
    .replace(/<\/t[hd]>/gi, ' | ');
}

/**
 * 块级与行内标签转换。
 * @param {string} html - HTML。
 * @returns {string} 转换后的 HTML。
 */
function convertInlineAndBlocks(html) {
  return html
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level, inner) => `\n\n${'#'.repeat(Number(level))} ${stripTags(inner)}\n\n`)
    .replace(/<(b|strong)[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _tag, inner) => `**${inner.trim()}**`)
    .replace(/<(i|em)[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _tag, inner) => `*${inner.trim()}*`)
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_m, inner) => `\`${stripTags(inner)}\``)
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_m, inner) => `\n\n\`\`\`\n${decodeEntities(inner).trim()}\n\`\`\`\n\n`)
    .replace(/<figcaption[^>]*>([\s\S]*?)<\/figcaption>/gi, (_m, inner) => `\n${stripTags(inner)}\n`)
    .replace(/<img[^>]*alt\s*=\s*("([^"]*)"|'([^']*)')[^>]*>/gi, (_m, _q, dq, sq) => {
      const alt = (dq ?? sq ?? '').trim();
      return alt === '' ? '' : `[图: ${alt}]`;
    })
    .replace(/<dl[^>]*>/gi, '\n')
    .replace(/<dt[^>]*>/gi, '\n**')
    .replace(/<\/dt>/gi, '**')
    .replace(/<dd[^>]*>/gi, '\n: ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<hr\s*\/?>/gi, '\n---\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<p[^>]*>/gi, '\n\n')
    .replace(/<\/(div|section|figure|blockquote|table)>/gi, '\n\n')
    .replace(/<(div|section|figure|blockquote)[^>]*>/gi, '\n')
    .replace(/<\/?span[^>]*>/gi, '')
    .replace(/<\/?(a|abbr|small|big|u|s|del|ins|sub|sup|font|center|time|data|var|kbd|samp|mark|wbr|bdi|bdo|ruby|rt|rp)[^>]*>/gi, '');
}

/**
 * 空白展平：行尾去空格、折叠行内多空格、连续空行压成一个。
 * @param {string} text - 文本。
 * @returns {string} 清理后的文本。
 */
function collapseWhitespace(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').replace(/^\s+|\s+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 按行丢掉命中的样板文字（行级噪声）。
 *
 * 匹配的是**整行**（用 `^…$` 锚定），所以不会误伤「同一行里有别的内容」的情况。
 * 写错的正则被忽略（配置笔误不该让工具报错）；`patterns` 传 `undefined` 时用
 * {@link DEFAULT_NOISE_PATTERNS}，传空数组则整体关闭。
 * @param {string} text - 已展平空白的文本。
 * @param {Array<string|RegExp>|undefined} patterns - 行级噪声 pattern。
 * @returns {string} 过滤后的文本。
 */
export function dropNoiseLines(text, patterns) {
  const list = patterns === undefined ? DEFAULT_NOISE_PATTERNS : patterns;
  if (!Array.isArray(list) || list.length === 0) return text;
  const matchers = [];
  for (const item of list) {
    const source = typeof item === 'string' ? item.trim() : item instanceof RegExp ? item.source : '';
    if (source === '') continue;
    try {
      matchers.push(item instanceof RegExp ? item : new RegExp(source));
    } catch {
      // 配置里写错的正则直接忽略。
    }
  }
  if (matchers.length === 0) return text;
  const kept = String(text ?? '').split('\n').filter((line) => {
    const trimmed = line.trim();
    return trimmed === '' || !matchers.some((matcher) => matcher.test(trimmed));
  });
  return collapseWhitespace(kept.join('\n'));
}

/**
 * 在行边界截断文本。
 * @param {string} text - 文本。
 * @param {number} maxChars - 字符上限。
 * @returns {{ text: string, truncated: boolean, totalChars: number }} 截断结果。
 */
export function truncateText(text, maxChars) {
  const source = String(text ?? '');
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.trunc(maxChars) : 20_000;
  if (source.length <= limit) return { text: source, truncated: false, totalChars: source.length };
  const head = source.slice(0, limit);
  const cut = head.lastIndexOf('\n');
  const kept = cut > limit * 0.6 ? head.slice(0, cut) : head;
  return {
    text: `${kept}\n\n[已截断：本页共 ${source.length} 字符，以上为前 ${kept.length} 字符。用 ck3wiki_sections 看目录，再用 ck3wiki_page(section=N) 分节读取。]`,
    truncated: true,
    totalChars: source.length,
  };
}

/**
 * 页面 HTML → 可读文本。
 * @param {string} html - `action=parse&prop=text` 的 `parse.text`。
 * @param {{ maxChars?: number, parserOutputOnly?: boolean }} [options] 选项。
 * @returns {{ text: string, truncated: boolean, totalChars: number }} 归约结果。
 */
export function toText(html, options = {}) {
  // class 表每次调用只组装一次（不是每个元素一次）：替换表 + 追加表。
  // 传 `dropClasses: []` 就是「不做 class 过滤」；传 `undefined` 用出厂默认表。
  const dropClasses = [
    ...(Array.isArray(options.dropClasses) ? options.dropClasses : DEFAULT_DROP_CLASSES),
    ...(Array.isArray(options.extraDropClasses) ? options.extraDropClasses : []),
  ];
  const prepared = options.parserOutputOnly === false
    ? stripRawTextBlocks(String(html ?? '').replace(/<!--[\s\S]*?-->/g, ' '))
    : extractParserOutput(html);
  const raw = prepared;
  let working = removeElements(raw, (tag, attrs) => isNoise(tag, attrs, { dropClasses }));
  working = convertTables(working);
  working = convertLists(working);
  working = convertInlineAndBlocks(working);
  const plain = dropNoiseLines(collapseWhitespace(decodeEntities(working.replace(/<[^>]*>/g, ''))), options.noisePatterns);
  return truncateText(plain, options.maxChars);
}
