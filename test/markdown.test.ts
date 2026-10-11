import { test } from "node:test";
import assert from "node:assert/strict";
import { markdownHtml, markdownQuote, markdownText } from "../client/markdown.js";

const origin = "https://chat.example";
const md = (body: string) => markdownHtml(body, [], origin);
const file = `${origin}/media/${"a".repeat(43)}`;

test("markdown formats emphasis, code, quotes, lists and headings", () => {
  assert.equal(md("plain"), "<p>plain</p>");
  assert.equal(md("one\ntwo\n\nthree"), "<p>one<br>two</p><p>three</p>");
  assert.equal(
    md("**bold** *it* _it_ ~~gone~~ `co*de*` ||secret||"),
    '<p><strong>bold</strong> <em>it</em> <em>it</em> <del>gone</del> <code>co*de*</code> <span class="spoiler" tabindex="0" title="Spoiler: click to show">secret</span></p>',
  );
  assert.equal(md("**bold and *nested***"), "<p><strong>bold and <em>nested</em></strong></p>");
  assert.equal(md("snake_case_name and 2*3*4"), "<p>snake_case_name and 2<em>3</em>4</p>");
  assert.equal(md("\\*not\\* \\_it\\_"), "<p>*not* _it_</p>");
  assert.equal(md("# Title\n## Sub"), '<h3 class="md-h1">Title</h3><h4 class="md-h2">Sub</h4>');
  assert.equal(md("#general is not a heading"), "<p>#general is not a heading</p>");
  assert.equal(md("> quoted\n> more\nafter"), "<blockquote><p>quoted<br>more</p></blockquote><p>after</p>");
  assert.equal(md("- a\n- b\n  - c\n\n1. x\n2. y"), "<ul><li>a</li><li>b<ul><li>c</li></ul></li></ul><ol><li>x</li><li>y</li></ol>");
  assert.equal(md("3. x"), '<ol start="3"><li>x</li></ol>');
  assert.equal(md("---"), "<hr>");
  assert.equal(md("```js\nlet a = `<b>`;\n**x**\n```\nafter"), "<pre><code>let a = `&lt;b&gt;`;\n**x**</code></pre><p>after</p>");
  assert.equal(md("```\nunclosed"), "<pre><code>unclosed</code></pre>");
});

test("markdown escapes markup and only links safe addresses", () => {
  assert.equal(md('<img src=x onerror="alert(1)">'), "<p>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</p>");
  assert.equal(md("[x](javascript:alert(1))"), "<p>[x](javascript:alert(1))</p>");
  assert.equal(md("[x](data:text/html,hi)"), "<p>[x](data:text/html,hi)</p>");
  assert.equal(
    md('[a "b"](https://x.example/?q="1")'),
    '<p><a href="https://x.example/?q=%221%22" target="_blank" rel="noopener noreferrer nofollow">a &quot;b&quot;</a></p>',
  );
  assert.equal(
    md("see https://x.example/a_b(c). Next"),
    '<p>see <a href="https://x.example/a_b(c)" target="_blank" rel="noopener noreferrer nofollow">https://x.example/a_b(c)</a>. Next</p>',
  );
  assert.equal(
    md("<mailto:a@x.example>"),
    '<p><a href="mailto:a@x.example" target="_blank" rel="noopener noreferrer nofollow">mailto:a@x.example</a></p>',
  );
  // A link into this app opens in place.
  assert.equal(md(`[there](${origin}/#/c/1)`), `<p><a href="${origin}/#/c/1">there</a></p>`);
  assert.doesNotMatch(md("`<script>`\n```\n</code><script>\n```"), /<script/);
});

test("markdown previews local and external media and offers other uploads as downloads", () => {
  assert.equal(
    md(`![cat.png](${file}.png)`),
    `<p><a class="attachment" href="${file}.png" target="_blank" rel="noopener noreferrer" aria-haspopup="dialog"><img src="${file}.png" alt="cat.png" title="cat.png" loading="lazy" decoding="async" referrerpolicy="no-referrer"></a></p>`,
  );
  assert.match(
    md(`![clip](${file}.mp4)`),
    new RegExp(`^<p><span class="attachment video"><video controls playsinline preload="metadata" src="${file}.mp4" title="clip"></video><button type="button" class="icon-button" data-expand aria-label="Expand video" title="Expand"><svg.*</svg></button></span></p>$`),
  );
  // Any other file is offered as a download under its own name.
  assert.match(
    md(`![notes "v2".pdf](${file}.bin)`),
    new RegExp(`^<p><a class="attachment file" href="${file}.bin" download="notes &quot;v2&quot;.pdf" title="Download notes &quot;v2&quot;.pdf"><svg.*</svg><span>notes &quot;v2&quot;.pdf</span></a></p>$`),
  );
  // The same attachment is visible to readers on another instance.
  const remote = md("![cat](https://other.example/media/" + "a".repeat(43) + ".png)");
  assert.match(remote, /<img/);
  assert.match(remote, /href="https:\/\/other\.example\/media\//);
  assert.match(md(`![report.pdf](https://other.example/media/${"a".repeat(43)}.bin)`), /class="attachment file"/);
  assert.match(md(`![x](${file}.png?next=1)`), /<img/);
  assert.equal(md('![a"b](javascript:x)'), "<p>![a&quot;b](javascript:x)</p>");
});

test("external pictures and videos preview from Markdown and direct links", () => {
  assert.match(md("![picture](https://images.example/render?id=1)"), /<img src="https:\/\/images.example\/render\?id=1"/);
  assert.match(md("![clip](https://other.example/clip.MP4?token=a&b=2)"), /<video controls playsinline preload="metadata" src="https:\/\/other.example\/clip.MP4\?token=a&amp;b=2"/);
  for (const ext of ["jpg", "jpeg", "png", "gif", "webp", "avif", "svg"])
    assert.match(md(`https://images.example/picture.${ext}?size=large.`), /<img/);
  for (const ext of ["mp4", "webm", "ogv", "mov", "m4v"])
    assert.match(md(`https://videos.example/clip.${ext}`), /<video/);
  // Text links stay text links, and credentials and non-web schemes never become embeds.
  assert.doesNotMatch(md("[a picture](https://images.example/a.png)"), /<img/);
  assert.doesNotMatch(md("https://example.com/file.pdf"), /<img|<video/);
  for (const url of ["https://user:secret@example.com/a.png", "mailto:a@example.com", "xmpp:a@example.com", "data:image/png,x", "javascript:x"])
    assert.doesNotMatch(md(`![x](${url})`), /<img|<video/);
  assert.doesNotMatch(md("`https://images.example/a.png`\n```\nhttps://videos.example/a.mp4\n```"), /<img|<video/);
  const blocked = markdownHtml("![picture](https://images.example/a.png) https://videos.example/a.mp4", [], origin, false);
  assert.doesNotMatch(blocked, /<img|<video/);
  assert.match(blocked, /href="https:\/\/images.example\/a.png"/);
});

test("markdown renders emoji shortcodes outside code and keeps unknown ones as written", () => {
  const emojis = [{ name: "island_wave", id: "1", url: "/api/emojis/1/image" }];
  const html = markdownHtml(":wave: :island_wave: :nope_this: `:wave:`", emojis, origin);
  assert.match(html, /<span class="emoji" title=":wave:">👋<\/span>/);
  assert.match(html, /<img class="custom-emoji" src="\/api\/emojis\/1\/image" alt=":island_wave:"/);
  assert.match(html, /:nope_this:/);
  assert.match(html, /<code>:wave:<\/code>/);
});

test("a quoted message keeps its lines, paragraphs and formatting", () => {
  assert.equal(markdownQuote("one\r\ntwo\n\n**three**\n"), "> one\n> two\n>\n> **three**");
  assert.equal(
    md(`${markdownQuote("one\n\n> inner")}\n\nanswer`),
    "<blockquote><p>one</p><blockquote><p>inner</p></blockquote></blockquote><p>answer</p>",
  );
});

test("markdown previews are plain text and long inputs stay quick", () => {
  assert.equal(markdownText(`**Hi** ![cat.png](${file}.png) and [a link](https://x.example)\n> quoted`), "Hi [cat.png] and a link quoted");
  const started = Date.now();
  md("**".repeat(4000));
  md("`".repeat(8000));
  md("[".repeat(8000));
  md("> ".repeat(4000));
  assert.ok(Date.now() - started < 2000);
});
