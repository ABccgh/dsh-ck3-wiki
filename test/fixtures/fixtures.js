/**
 * 测试用固定数据：形状取自 2026-10-01 对 ck3.paradoxwikis.com 的真实响应（已裁剪体积）。
 *
 * 放在一个模块里而不是一堆 JSON：这些数据只在测试里用，集中一处更好对照真实接口。
 *
 * @module dsh-ck3-wiki/test/fixtures
 */

/** `action=query&meta=siteinfo&siprop=general|statistics`。 */
export const SITEINFO = {
  batchcomplete: true,
  query: {
    general: {
      mainpage: 'Crusader Kings III Wiki',
      base: 'https://ck3.paradoxwikis.com/Crusader_Kings_III_Wiki',
      sitename: 'CK3 Wiki',
      generator: 'MediaWiki 1.39.4',
      articlepath: '/$1',
      scriptpath: '',
      server: 'https://ck3.paradoxwikis.com',
      lang: 'en',
    },
    statistics: {
      pages: 7575,
      articles: 486,
      edits: 36232,
      images: 4906,
      users: 2791,
      activeusers: 17,
      admins: 11,
      jobs: 0,
    },
  },
};

/** `list=search`（含 `<span class="searchmatch">` 与 continue）。 */
export const SEARCH = {
  batchcomplete: true,
  continue: { sroffset: 3, continue: '-||' },
  query: {
    searchinfo: { totalhits: 63 },
    search: [
      {
        ns: 0,
        title: 'Innovation',
        pageid: 1256,
        size: 20843,
        wordcount: 785,
        timestamp: '2026-09-28T09:12:00Z',
        snippet: 'missing Can use the Seize <span class="searchmatch">De</span> <span class="searchmatch">Jure</span> County &amp; Duchy <span class="searchmatch">Casus</span> <span class="searchmatch">belli</span>',
      },
      {
        ns: 0,
        title: 'Titles',
        pageid: 239,
        size: 33357,
        wordcount: 1520,
        timestamp: '2026-09-30T13:45:54Z',
        snippet: 'map modes will show all <span class="searchmatch">De</span> <span class="searchmatch">Jure</span> titles.',
      },
      { ns: 10, title: 'Template:Casus belli', pageid: 999, size: 1200, wordcount: 40, timestamp: '2026-08-01T00:00:00Z', snippet: 'template doc' },
    ],
  },
};

/** `action=opensearch`：`[查询词, 标题[], 描述[], URL[]]`。 */
export const OPENSEARCH = [
  'casus',
  ['Casus belli', 'Casus Belli (innovation)'],
  ['', ''],
  ['https://ck3.paradoxwikis.com/Casus_belli', 'https://ck3.paradoxwikis.com/Casus_Belli_(innovation)'],
];

/** `action=parse&prop=sections`。 */
export const SECTIONS = {
  parse: {
    title: 'Titles',
    pageid: 239,
    sections: [
      { toclevel: 1, level: '2', line: 'Title rank', number: '1', index: '1', fromtitle: 'Titles', byteoffset: 1389, anchor: 'Title_rank' },
      { toclevel: 2, level: '3', line: 'Duchy', number: '1.1', index: '2', fromtitle: 'Titles', byteoffset: 8381, anchor: 'Duchy' },
      { toclevel: 1, level: '2', line: 'Succession', number: '2', index: '3', fromtitle: 'Titles', byteoffset: 20111, anchor: 'Succession' },
    ],
  },
};

/** `action=parse&prop=text|revid`：带版本横幅、编辑链接、脚注角标、列表与表格。 */
export const PAGE_TEXT = {
  parse: {
    title: 'Casus belli',
    pageid: 1871,
    revid: 36426,
    text: [
      '<div class="mw-parser-output">',
      '<div class="eu4box metadata" style="float:right">',
      '<p>This article has been verified for the current PC <a href="/CK3_Wiki:Versioning">version</a> (1.20).</p>',
      '</div>',
      '<p>A <b>casus belli</b> is a justification for war &amp; can be gained in several ways.<sup class="reference"><a href="#cite_note-1">[1]</a></sup></p>',
      // 视频嵌入：装饰在 embedvideo-consent 里，真正的视频标题在同级 <figcaption>（实测结构）。
      '<figure class="embedvideo mw-halign-right" data-service="youtube" data-iframeconfig="{&quot;src&quot;:&quot;//www.youtube-nocookie.com/embed/uu_Zxf4ul2g?autoplay=1&quot;}" style="width:640px">',
      '<span class="embedvideo-wrapper" style="height:360px">',
      '<div class="embedvideo-consent" data-show-privacy-notice="1">',
      '<div class="embedvideo-overlay">',
      '<div class="embedvideo-loader" role="button">',
      '<div class="embedvideo-loader__fakeButton">Load video</div>',
      '<div class="embedvideo-loader__footer"><div class="embedvideo-loader__service">YouTube</div></div>',
      '</div>',
      '<div class="embedvideo-privacyNotice hidden">',
      '<div class="embedvideo-privacyNotice__content">YouTube might collect personal data. '
        + '<a href="https://www.youtube.com/howyoutubeworks/user-settings/privacy/" rel="nofollow,noopener" target="_blank" class="embedvideo-privacyNotice__link">Privacy Policy</a></div>',
      '<div class="embedvideo-privacyNotice__buttons"></div>',
      '</div>',
      '</div>',
      '</span>',
      '<figcaption>CK3 Modding #1 -Brief introduction to modding.</figcaption>',
      '</figure>',
      '<div class="mw-heading mw-heading2"><h2 id="Uses">Uses</h2><span class="mw-editsection">[<a href="/index.php?title=Casus_belli&amp;action=edit&amp;section=1">edit</a>]</span></div>',
      '<ul><li>Declare war</li><li>Seize titles',
      '<ol><li>County</li><li>Duchy</li></ol>',
      '</li></ul>',
      '<table class="wikitable"><caption>Costs</caption>',
      '<tr><th>Type</th><th>Cost</th></tr>',
      '<tr><td>Duchy</td><td>100</td></tr>',
      '</table>',
      '<div class="navbox"><table><tr><td>Mechanics</td><td>War</td></tr></table></div>',
      '<p>See also <i>titles</i> and <code>de_jure</code>.</p>',
      '</div>',
    ].join('\n'),
  },
};

/** `action=parse` 对不存在页面返回的错误。 */
export const PARSE_MISSING = {
  error: { code: 'missingtitle', info: "The page you specified doesn't exist." },
};

/** `action=query&prop=revisions&rvslots=main`（带一个重定向）。 */
export const WIKITEXT = {
  batchcomplete: true,
  query: {
    redirects: [{ from: 'Casus Belli', to: 'Casus belli' }],
    pages: [
      {
        pageid: 1871,
        ns: 0,
        title: 'Casus belli',
        revisions: [
          {
            revid: 36426,
            parentid: 36000,
            user: 'Kami-sama',
            timestamp: '2026-09-30T13:45:54Z',
            comment: '/* Uses */ add seize duchy',
            slots: { main: { contentmodel: 'wikitext', content: '{{Version|1.20}}\nA \'\'\'casus belli\'\'\' is a justification for war.' } },
          },
        ],
      },
    ],
  },
};

/** `action=query&prop=info|pageprops|categories`（消歧义页 + 分类 + 重定向来源）。 */
export const PAGE_INFO = {
  batchcomplete: true,
  query: {
    redirects: [{ from: 'Casus Belli', to: 'Casus belli' }],
    pages: [
      {
        pageid: 1871,
        ns: 0,
        title: 'Casus belli',
        contentmodel: 'wikitext',
        pagelanguage: 'en',
        touched: '2026-09-30T13:45:54Z',
        lastrevid: 36426,
        length: 12043,
        fullurl: 'https://ck3.paradoxwikis.com/Casus_belli',
        displaytitle: 'Casus belli',
        pageprops: { disambiguation: '' },
        categories: [
          { ns: 14, title: 'Category:1.20', timestamp: '2026-09-30T13:45:54Z' },
          { ns: 14, title: 'Category:War', timestamp: '2026-09-01T00:00:00Z' },
        ],
      },
    ],
  },
};

/** 不存在页面时的 `prop=info` 响应。 */
export const PAGE_INFO_MISSING = {
  batchcomplete: true,
  query: { pages: [{ ns: 0, title: 'Nonexistent page xyzzy', missing: true, contentmodel: 'wikitext' }] },
};

/** `prop=links`。 */
export const LINKS = {
  query: {
    pages: [
      {
        pageid: 1871,
        ns: 0,
        title: 'Casus belli',
        links: [
          { ns: 0, title: 'War' },
          { ns: 0, title: 'Titles' },
          { ns: 10, title: 'Template:Version' },
        ],
      },
    ],
  },
};

/** `list=backlinks`。 */
export const BACKLINKS = {
  query: {
    backlinks: [
      { pageid: 140, ns: 0, title: 'Crusader Kings III Wiki' },
      { pageid: 168, ns: 0, title: 'Traits' },
      { pageid: 5, ns: 4, title: 'CK3 Wiki:Style', redirect: true },
    ],
    continuation: {},
  },
};

/** `list=categorymembers`。 */
export const CATEGORY_MEMBERS = {
  continue: { cmcontinue: 'next|abc' },
  query: {
    categorymembers: [
      { pageid: 1228, ns: 0, title: '3D models', timestamp: '2026-05-01T00:00:00Z', type: 'page' },
      { pageid: 5368, ns: 0, title: 'AI modding', timestamp: '2026-06-01T00:00:00Z', type: 'page' },
      { pageid: 900, ns: 14, title: 'Category:Tutorials', type: 'subcat' },
    ],
  },
};

/** `list=recentchanges`。 */
export const RECENT_CHANGES = {
  query: {
    recentchanges: [
      {
        type: 'edit',
        ns: 10,
        title: 'Template:Tradition/doc',
        pageid: 4000,
        revid: 36500,
        old_revid: 36499,
        user: 'Kami-sama',
        timestamp: '2026-10-01T10:56:52Z',
        oldlen: 1139,
        newlen: 1184,
        comment: '/* Parameters */',
      },
      {
        type: 'new',
        ns: 0,
        title: 'Sicilian culture',
        pageid: 4100,
        revid: 36480,
        user: 'Someone',
        timestamp: '2026-09-30T22:10:00Z',
        oldlen: 0,
        newlen: 900,
        comment: '',
      },
    ],
  },
};

/** Fastly 挑战页（HTTP 200 + text/html）——实测形状。 */
export const CHALLENGE_HTML = [
  '<!DOCTYPE html>',
  '<html lang="en"><head>',
  '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'" />',
  '<link href="/_fs-ch-1T1wmsGaOgGaSxcX/assets/styles.css" rel="stylesheet" />',
  '<title>Please enable JavaScript</title>',
  '</head><body><noscript>Please enable JavaScript to continue.</noscript></body></html>',
].join('');
