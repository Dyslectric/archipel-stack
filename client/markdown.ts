import { emojiParts, emojiData, markEmoji, type CustomEmoji } from "../src/emojis.js";
import { mediaUrl } from "../src/media-url.js";

// Messages are stored as written and formatted when shown: Markdown's everyday subset, with
// :emoji: shortcodes. Everything is escaped on the way out, and nothing but http(s), mailto and
// xmpp addresses becomes a link. Pictures and videos, including those on other instances,
// are shown in place. Other uploaded files are offered as downloads.
const esc = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
interface Context {
  emojis: CustomEmoji[];
  origin: string;
  previews: boolean;
}

function emoji(text: string, ctx: Context) {
  return emojiParts(text, ctx.emojis)
    .map((part) =>
      "text" in part
        ? markEmoji(esc(part.text))
        : "emoji" in part
          ? `<span class="emoji" title=":${esc(part.name)}:">${esc(part.emoji)}</span>`
          : `<img class="custom-emoji" src="${esc(part.url)}" alt=":${esc(part.name)}:"${part.kind ? emojiData(part, esc) : ` title=":${esc(part.name)}:"`}>`,
    )
    .join("");
}
function safeUrl(value: string) {
  try {
    const url = new URL(value);
    return ["http:", "https:", "mailto:", "xmpp:"].includes(url.protocol)
      ? url
      : null;
  } catch {
    return null;
  }
}
// Archipel uploads use this address on every instance, including generic file downloads.
const media = /^\/media\/[A-Za-z0-9_-]{43}\.(png|jpg|gif|webp|mp4|webm|bin)$/;
const expandIcon =
  '<svg class="i" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M15 4h5v5M20 4l-6 6M9 20H4v-5M4 20l6-6"/></svg>';
const fileIcon =
  '<svg class="i" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M12 11v6M9 14l3 3 3-3"/></svg>';
function uploadedMedia(url: URL) {
  return !url.search && !url.hash
    ? media.exec(url.pathname)?.[1]
    : undefined;
}
function previewType(url: URL) {
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return;
  return /\.(png|jpe?g|gif|webp|avif|bmp|svg|mp4|webm|ogv|mov|m4v)$/i.exec(url.pathname)?.[1].toLowerCase();
}
function link(url: URL, label: string, ctx: Context) {
  // A link to somewhere in this app opens here; anything else opens beside it.
  const inside = !!ctx.origin && url.origin === ctx.origin && url.pathname === "/";
  return `<a href="${esc(mediaUrl(url, ctx.origin))}"${inside ? "" : ' target="_blank" rel="noopener noreferrer nofollow"'}>${label}</a>`;
}
function image(alt: string, address: string, ctx: Context) {
  const url = safeUrl(address);
  if (!url) return esc(`![${alt}](${address})`);
  if (!ctx.previews || !["http:", "https:"].includes(url.protocol) || url.username || url.password)
    return link(url, esc(alt || address), ctx);
  const type = uploadedMedia(url) || previewType(url),
    href = esc(mediaUrl(url, ctx.origin)),
    name = esc(alt);
  if (type && ["mp4", "webm", "ogv", "mov", "m4v"].includes(type))
    return `<span class="attachment video"><video controls playsinline preload="metadata" src="${href}" title="${name}"></video><button type="button" class="icon-button" data-expand aria-label="Expand video" title="Expand">${expandIcon}</button></span>`;
  // Anything that is not a picture or video is a file to download, under the name it came with.
  if (type === "bin")
    return `<a class="attachment file" href="${href}" download="${name}" title="Download ${name}">${fileIcon}<span>${name || "File"}</span></a>`;
  return `<a class="attachment" href="${href}" target="_blank" rel="noopener noreferrer" aria-haspopup="dialog"><img src="${href}" alt="${name}" title="${name}" loading="lazy" decoding="async" referrerpolicy="no-referrer"></a>`;
}

// Leftmost first, and where two start together the earlier alternative wins.
const token = new RegExp(
  [
    /\\([\\`*_~|[\]()!#>+\-.:])/, // 1: an escaped character
    /(`+)([^`]|[^`][\s\S]*?[^`])\2(?!`)/, // 2,3: code
    /!\[([^\]\n]*)\]\(([^()\s]+)\)/, // 4,5: attached file
    /\[([^[\]\n]+)\]\(([^()\s]+)\)/, // 6,7: link
    /<((?:https?|mailto|xmpp):[^\s<>]+)>/, // 8: address in angle brackets
    /\b(https?:\/\/[^\s<>]+)/, // 9: bare address
    /(:[a-z0-9_+\-]{1,64}:)/, // 10: emoji shortcode, whole
    /\*\*(?=\S)([\s\S]*?\S)\*\*(?!\*)/, // 11: bold
    /(?<![A-Za-z0-9_])__(?=\S)([\s\S]*?\S)__(?![A-Za-z0-9_])/, // 12: bold
    /\*(?=[^\s*])([^*\n]*?[^\s*])\*/, // 13: italic
    /(?<![A-Za-z0-9_])_(?=[^\s_])([^_\n]*?[^\s_])_(?![A-Za-z0-9_])/, // 14: italic
    /~~(?=\S)([\s\S]*?\S)~~/, // 15: struck through
    /\|\|(?=\S)([\s\S]*?\S)\|\|/, // 16: spoiler
  ]
    .map((part) => part.source)
    .join("|"),
  "g",
);
function inline(text: string, ctx: Context, depth = 0): string {
  if (depth > 6) return emoji(text, ctx);
  let html = "",
    end = 0;
  const wrap = (tag: string, inner: string, attrs = "") =>
    `<${tag}${attrs}>${inline(inner, ctx, depth + 1)}</${tag}>`;
  for (const m of text.matchAll(token)) {
    html += emoji(text.slice(end, m.index), ctx);
    end = m.index + m[0].length;
    if (m[1] !== undefined) html += esc(m[1]);
    else if (m[3] !== undefined)
      html += `<code>${esc(m[3].replace(/^ (.*\S.*) $/s, "$1"))}</code>`;
    else if (m[5] !== undefined) html += image(m[4], m[5], ctx);
    else if (m[7] !== undefined) {
      const url = safeUrl(m[7]);
      html += url ? link(url, inline(m[6], ctx, depth + 1), ctx) : esc(m[0]);
    } else if (m[8] !== undefined) {
      const url = safeUrl(m[8]);
      html += url ? link(url, esc(m[8]), ctx) : esc(m[0]);
    } else if (m[9] !== undefined) {
      // Punctuation that ends the sentence is not part of the address.
      let address = m[9].replace(/[.,;:!?'"*_~|]+$/, "");
      while (
        address.endsWith(")") &&
        address.split("(").length <= address.split(")").length - 1
      )
        address = address.slice(0, -1);
      const url = safeUrl(address);
      end -= m[9].length - address.length;
      html += url ? ctx.previews && previewType(url) ? image("", address, ctx) : link(url, esc(address), ctx) : esc(address);
    } else if (m[10] !== undefined) html += emoji(m[10], ctx);
    else if (m[11] !== undefined) html += wrap("strong", m[11]);
    else if (m[12] !== undefined) html += wrap("strong", m[12]);
    else if (m[13] !== undefined) html += wrap("em", m[13]);
    else if (m[14] !== undefined) html += wrap("em", m[14]);
    else if (m[15] !== undefined) html += wrap("del", m[15]);
    else
      html += wrap(
        "span",
        m[16],
        ' class="spoiler" tabindex="0" title="Spoiler: click to show"',
      );
  }
  return html + emoji(text.slice(end), ctx);
}

const fence = /^ {0,3}(```+|~~~+)\s*([\w+#.-]*)\s*$/;
const bullet = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const rule = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const heading = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const quote = /^ {0,3}>\s?(.*)$/;

function list(lines: string[], ctx: Context, depth: number): string {
  const first = bullet.exec(lines[0])!,
    ordered = /\d/.test(first[2]),
    indent = first[1].length;
  const items: string[][] = [];
  for (const line of lines) {
    const m = bullet.exec(line);
    if (m && m[1].length <= indent + 1) items.push([m[3]]);
    else items.at(-1)!.push(line);
  }
  const start = ordered && parseInt(first[2]) !== 1 ? ` start="${parseInt(first[2])}"` : "";
  return `<${ordered ? `ol${start}` : "ul"}>${items
    .map(([head, ...rest]) => {
      // What follows an item, indented under it, is a list of its own or more of its text.
      const nested = rest.findIndex((line) => bullet.test(line)),
        more = nested < 0 ? rest : rest.slice(0, nested);
      return `<li>${inline([head, ...more.map((l) => l.trim())].join("\n"), ctx).replaceAll("\n", "<br>")}${nested < 0 ? "" : list(rest.slice(nested), ctx, depth + 1)}</li>`;
    })
    .join("")}</${ordered ? "ol" : "ul"}>`;
}
function blocks(lines: string[], ctx: Context, depth: number): string {
  let html = "",
    paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length)
      html += `<p>${inline(paragraph.join("\n"), ctx).replaceAll("\n", "<br>")}</p>`;
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m: RegExpExecArray | null;
    if ((m = fence.exec(line))) {
      flush();
      const body: string[] = [],
        close = new RegExp(`^ {0,3}${m[1][0]}{${m[1].length},}\\s*$`);
      for (i++; i < lines.length && !close.test(lines[i]); i++)
        body.push(lines[i]);
      html += `<pre><code>${esc(body.join("\n"))}</code></pre>`;
    } else if (!line.trim()) flush();
    else if (rule.test(line)) {
      flush();
      html += "<hr>";
    } else if ((m = heading.exec(line))) {
      flush();
      // Never larger than the page's own headings.
      const level = Math.min(m[1].length + 2, 6);
      html += `<h${level} class="md-h${m[1].length}">${inline(m[2], ctx)}</h${level}>`;
    } else if (quote.test(line) && depth < 6) {
      flush();
      const inner: string[] = [];
      for (; i < lines.length && (m = quote.exec(lines[i])); i++)
        inner.push(m[1]);
      i--;
      html += `<blockquote>${blocks(inner, ctx, depth + 1)}</blockquote>`;
    } else if (bullet.test(line) && depth < 6) {
      flush();
      const items: string[] = [];
      // The list runs to the first blank line, or the first line that is neither an item nor indented.
      for (
        ;
        i < lines.length &&
        lines[i].trim() &&
        (bullet.test(lines[i]) || /^\s/.test(lines[i]));
        i++
      )
        items.push(lines[i]);
      i--;
      html += list(items, ctx, depth);
    } else paragraph.push(line);
  }
  flush();
  return html;
}

export function markdownHtml(
  body: string,
  emojis: CustomEmoji[] = [],
  origin = globalThis.location?.origin ?? "",
  previews = true,
) {
  return blocks(body.replace(/\r\n?/g, "\n").split("\n"), { emojis, origin, previews }, 0);
}
// A message as a quotation: each of its lines behind a >, as written.
export function markdownQuote(body: string) {
  return body
    .replace(/\r\n?/g, "\n")
    .trim()
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");
}
// One line of plain text for a preview: what the message says, without its markup.
export function markdownText(body: string) {
  return body
    .replace(/!\[([^\]\n]*)\]\([^()\s]+\)/g, (_m, alt) => `[${alt || "attachment"}]`)
    .replace(/\[([^[\]\n]+)\]\([^()\s]+\)/g, "$1")
    .replace(/(\*\*|__|~~|\|\||`+)/g, "")
    .replace(/^ {0,3}(#{1,6}|>)\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}
