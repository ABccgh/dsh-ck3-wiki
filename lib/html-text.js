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

/** 整块丢掉的 class（命中任一即丢，含其子树）。 */
const DROP_CLASSES = [
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
];

/** 整块丢掉的标签（含其子树）。 */
const DROP_TAGS = new Set(['script', 'style', 'noscript', 'iframe', 'button', 'select', 'option', 'form', 'svg']);

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
 * 去掉所有标签并解码实体——用于检索片段这类单行文本。
 * @param {string} html - HTML 片段。
 * @returns {string} 纯文本。
 */
export function stripTags(html) {
  return decodeEntities(String(html ?? '').replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

/**
 * 提取 `<div class="mw-parser-output">` 的主体；找不到时返回原串。
 * @param {string} html - 页面 HTML。
 * @returns {string} 正文 HTML。
 */
export function extractParserOutput(html) {
  const start = String(html ?? '').search(/<div[^>]*class="[^"]*\bmw-parser-output\b[^"]*"[^>]*>/i);
  if (start < 0) return String(html ?? '');
  const openEnd = html.indexOf('>', start) + 1;
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g;
  re.lastIndex = openEnd;
  let depth = 1;
  let match;
  while ((match = re.exec(html)) !== null) {
    const name = match[2].toLowerCase();
    if (VOID_TAGS.has(name)) continue;
    if (match[1] === '/') {
      depth -= 1;
      if (depth === 0) return html.slice(openEnd, match.index);
    } else {
      depth += 1;
    }
  }
  return html.slice(openEnd);
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
 * @returns {boolean} 是否丢弃。
 */
function isNoise(tag, attrs) {
  if (DROP_TAGS.has(tag)) return true;
  const classMatch = /\bclass\s*=\s*("([^"]*)"|'([^']*)')/i.exec(attrs);
  if (classMatch === null) return false;
  const classes = (classMatch[2] ?? classMatch[3] ?? '').split(/\s+/);
  return classes.some((name) => DROP_CLASSES.includes(name));
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
  const raw = options.parserOutputOnly === false ? String(html ?? '') : extractParserOutput(html);
  let working = removeElements(raw, isNoise);
  working = convertTables(working);
  working = convertLists(working);
  working = convertInlineAndBlocks(working);
  const plain = collapseWhitespace(decodeEntities(working.replace(/<[^>]*>/g, '')));
  return truncateText(plain, options.maxChars);
}
