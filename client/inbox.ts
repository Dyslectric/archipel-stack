import {
  $,
  action,
  api,
  avatar,
  channelIcon,
  clock,
  dayLabel,
  dmHref,
  emojiHtml,
  esc,
  full,
  handleTag,
  icon,
  richHtml,
  nameButton,
  state,
  type Channel,
  type Conversation,
  type Message,
} from "./shared.js";
import { chatFrame, resetChat } from "./chat.js";
import { renderSidebar } from "./sidebar.js";

// The inbox: what was said since you last looked, in the channels you've joined and in your
// direct messages, a block per conversation with the latest on top. It is drawn in the chat frame.
type Item = Message & {
  target: string;
  topic_title?: string | null;
} & (
    | { kind: "channel"; channel: Channel }
    | { kind: "dm"; conversation: Conversation }
  );
const filters = [
  ["all", "All"],
  ["channels", "Channels"],
  ["dms", "Direct messages"],
] as const;
type Filter = (typeof filters)[number][0];
const SHOWN = 5; // messages per conversation; the rest are a click away

let items: Item[] = [],
  signature = "",
  generation = 0;
function filter(): Filter {
  try {
    const saved = localStorage.getItem("archipel-inbox-filter");
    return saved === "channels" || saved === "dms" ? saved : "all";
  } catch {
    return "all";
  }
}
const onScreen = () => !!document.querySelector("#rows.inbox");

function messageHtml(m: Item) {
  const time = `<time datetime="${esc(m.created_at)}" title="${esc(full(m.created_at))}">${esc(dayLabel(m.created_at))}, ${esc(clock(m.created_at))}</time>`;
  const topic =
    m.kind === "channel" && m.topic_id
      ? `<a class="pill" href="#/c/${m.channel.id}/t/${m.topic_id}">${esc(m.topic_title || "Topic")}</a>`
      : "";
  return `<article class="message"><div class="msg-gutter">${avatar(m)}</div><div class="message-content"><div class="message-meta">${nameButton(m, m.author_actor_url)}${handleTag(m.username)}${time}${topic}</div>${m.title ? `<div class="inbox-title">${emojiHtml(m.title, m.emojis || [])}</div>` : ""}<div class="message-body markdown">${richHtml(m.body, m.emojis || [], m.author_actor_url)}</div></div></article>`;
}
function draw() {
  const kind = filter(),
    shown = items.filter(
      (m) => kind === "all" || (kind === "dms") === (m.kind === "dm"),
    );
  // Newest first, so conversations come out in the order they last spoke.
  const groups = new Map<string, Item[]>();
  for (const m of shown)
    groups.set(m.target, [...(groups.get(m.target) || []), m]);
  $("#feed-top").innerHTML =
    `<div class="toolbar inbox-bar"><div class="seg" role="group" aria-label="Show">${filters.map(([key, label]) => `<button type="button" data-inbox-filter="${key}" class="${key === kind ? "on" : ""}" aria-pressed="${key === kind}">${label}</button>`).join("")}</div><span class="grow"></span>${shown.length ? `<button type="button" class="small secondary" data-inbox-read="all">${icon("check")} Mark all as read</button>` : ""}</div>`;
  const rows = $("#rows");
  rows.className = "rows inbox";
  rows.innerHTML = [...groups]
    .map(([target, list]) => {
      const first = list[0],
        total = Math.max(state.unread[target] || 0, list.length),
        href =
          first.kind === "dm"
            ? dmHref(first.conversation.peer)
            : `#/c/${first.channel.id}`,
        name =
          first.kind === "dm"
            ? `${avatar(first.conversation, "small")}${esc(first.conversation.display_name)}`
            : `${channelIcon(first.channel)}${esc(first.channel.name)}`;
      return `<section class="topic-group inbox-group" data-kind="${first.kind}"><header class="recipient-bar"><a class="rb-channel" href="${esc(href)}">${name}</a><span class="count" aria-label="${total} new">${total}</span><span class="rb-date"><button type="button" class="link" data-inbox-read="${esc(target)}" data-seq="${first.seq}">Mark as read</button></span></header>
        <div class="group-body">${total > SHOWN ? `<a class="inbox-more muted small" href="${esc(href)}">${total - SHOWN} earlier new message${total - SHOWN === 1 ? "" : "s"}. Open the conversation to read them.</a>` : ""}${list.slice(0, SHOWN).reverse().map(messageHtml).join("")}</div></section>`;
    })
    .join("");
  $("#feed-empty").innerHTML = shown.length
    ? ""
    : `<div class="card empty"><h2>You're all caught up</h2><p class="muted">${kind === "channels" ? "Nothing new in the channels you've joined." : kind === "dms" ? "No new direct messages." : "New messages in your channels and direct messages will show up here."}</p></div>`;
}
async function load() {
  const token = ++generation,
    fresh = await api<Item[]>("/inbox");
  if (token !== generation || !onScreen()) return;
  const next = JSON.stringify(fresh);
  if (next === signature) return;
  signature = next;
  items = fresh;
  draw();
}
export async function showInbox(view: HTMLElement) {
  chatFrame(view);
  resetChat();
  renderSidebar();
  $("#sidebar").classList.remove("mobile-open");
  $("#channel-heading").innerHTML =
    `<h1>${icon("inbox")}<strong>Inbox</strong></h1><span class="desc muted small">New in your channels and direct messages</span>`;
  $("#channel-actions").innerHTML = $("#composer-area").innerHTML = "";
  $("#new-pill").hidden = true;
  if (!onScreen()) {
    items = [];
    signature = "";
    $("#rows").className = "rows inbox";
    $("#rows").innerHTML = $("#feed-top").innerHTML = "";
    $("#feed-empty").innerHTML = "";
  }
  await load();
  $("#message-list").scrollTop = 0;
}
// Kept up to date while it's on screen.
export async function tickInbox() {
  if (onScreen()) await load();
}
document.addEventListener("click", (e) => {
  const at = e.target as Element,
    pick = at.closest<HTMLElement>("[data-inbox-filter]"),
    read = at.closest<HTMLElement>("[data-inbox-read]");
  if (pick) {
    try {
      localStorage.setItem("archipel-inbox-filter", pick.dataset.inboxFilter!);
    } catch {
      /* Without storage the choice lasts until the page is reloaded. */
    }
    draw();
  } else if (read)
    action(async () => {
      const target = read.dataset.inboxRead!;
      await api(
        "/read",
        "POST",
        target === "all"
          ? { all: filter() }
          : { target, seq: Number(read.dataset.seq) },
      );
      // Gone from the page at once; the next refresh confirms it.
      const kind = filter();
      items = items.filter((m) =>
        target === "all"
          ? kind !== "all" && (kind === "dms") !== (m.kind === "dm")
          : m.target !== target,
      );
      for (const id of Object.keys(state.unread))
        if (
          target === "all"
            ? kind === "all" || (kind === "dms") === id.startsWith("dm:")
            : id === target
        )
          delete state.unread[id];
      signature = "";
      if (onScreen()) draw();
      renderSidebar();
    });
});
