import { test } from "node:test";
import assert from "node:assert/strict";
import { markdownHtml, markdownText } from "../client/markdown.js";

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

test("markdown shows this instance's attachments in place and links everything else", () => {
  assert.equal(
    md(`![cat.png](${file}.png)`),
    `<p><a class="attachment" href="${file}.png" target="_blank" rel="noopener noreferrer"><img src="${file}.png" alt="cat.png" title="cat.png" loading="lazy" decoding="async"></a></p>`,
  );
  assert.equal(
    md(`![clip](${file}.mp4)`),
    `<p><video class="attachment" controls preload="metadata" src="${file}.mp4" title="clip"></video></p>`,
  );
  // Another host's picture is never fetched by reading a message.
  const remote = md("![cat](https://other.example/media/" + "a".repeat(43) + ".png)");
  assert.doesNotMatch(remote, /<img|<video/);
  assert.match(remote, /<a href="https:\/\/other\.example\/media\//);
  assert.doesNotMatch(md(`![x](${origin}/api/session)`), /<img/);
  assert.doesNotMatch(md(`![x](${file}.png?next=1)`), /<img/);
  assert.equal(md('![a"b](javascript:x)'), "<p>![a&quot;b](javascript:x)</p>");
});

test("markdown renders emoji shortcodes outside code and keeps unknown ones as written", () => {
  const emojis = [{ name: "island_wave", id: "1", url: "/api/emojis/1/image" }];
  const html = markdownHtml(":wave: :island_wave: :nope_this: `:wave:`", emojis, origin);
  assert.match(html, /<span title=":wave:">👋<\/span>/);
  assert.match(html, /<img class="custom-emoji" src="\/api\/emojis\/1\/image" alt=":island_wave:"/);
  assert.match(html, /:nope_this:/);
  assert.match(html, /<code>:wave:<\/code>/);
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
