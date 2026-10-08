import {
  $,
  $$,
  action,
  api,
  avatar,
  canModerate,
  channelIcon,
  clock,
  confirmDialog,
  dayLabel,
  dmHref,
  emojiHtml,
  esc,
  full,
  go,
  icon,
  modeLabel,
  nameButton,
  refreshTimes,
  richHtml,
  sameDay,
  state,
  toast,
  when,
  type Channel,
  type Conversation,
  type Message,
  type Topic,
} from "./shared.js";
import { closePicker, togglePicker } from "./picker.js";
import { renderSidebar, wireSidebar } from "./sidebar.js";
import { attachButton, pickFiles, quoteInto } from "./attach.js";
import { markdownText } from "./markdown.js";

interface Page {
  messages: Message[];
  older_cursor: number | null;
}
// A piece of the conversation: its markup, and what goes in its [data-kids] element.
interface Node {
  key: string;
  html: string;
  kids?: Node[];
}

let current: Channel | null = null,
  messages: Message[] = [],
  olderCursor: number | null = null;
let narrow: string | null = null, // the topic being read on its own
  reply: Message | null = null,
  editing: string | null = null;
let generation = 0,
  lastSignature = "",
  marked = 0, // the newest message the server has been told was read
  painted = false; // whether the frame on the page shows the current channel yet
// Threads folded by the reader; what has been shown already (the rest pops in); what arrived out of sight.
const collapsed = new Set<string>(),
  seen = new Set<string>();
let unseen: string[] = [],
  popped: string[] = [];

export const chatChannel = () => current;
export const chatTopic = () => narrow;
export function resetChat() {
  current = null;
  messages = [];
  generation++;
  renderMembers();
}
// A direct conversation is shown as a two-person timeline: its id is dm:<peer>.
const dmChannel = (c: Conversation): Channel => ({
  id: `dm:${c.peer}`,
  name: c.display_name,
  description: "",
  mode: "timeline",
  visibility: "members",
  admission: "allowlist",
  owner_id: "",
  role: "member",
  readable: true,
  can_join: false,
  member_count: 2,
  topics: [],
  remote_actor: null,
  federation_enabled: 0,
  dm: c,
});
const pagePath = (id: string, before?: number | null) =>
  id.startsWith("dm:")
    ? `/dms/messages?peer=${encodeURIComponent(id.slice(3))}${before ? `&before=${before}` : ""}`
    : `/channels/${id}/messages${before ? `?before=${before}` : ""}`;
async function load(id: string): Promise<[Channel, Page]> {
  if (id.startsWith("dm:")) {
    const data = await api<Page & { conversation: Conversation }>(pagePath(id));
    return [dmChannel(data.conversation), data];
  }
  return Promise.all([
    api<Channel>(`/channels/${id}`),
    api<Page>(pagePath(id)),
  ]);
}
// Having this conversation on screen is reading it.
function markSeen() {
  const last = messages.at(-1)?.seq;
  if (!current?.role || !last || document.hidden) return;
  if (last <= marked && !state.unread[current.id]) return;
  marked = last;
  delete state.unread[current.id];
  void api("/read", "POST", { target: current.id, seq: last }).catch(() => {
    /* The next refresh tries again. */
    marked = 0;
  });
}
const me = () => state.session.user!;
const threaded = () => current?.mode === "threaded";
const topicOf = (id: string | null) =>
  current?.topics?.find((t) => t.id === id);

// Why this account can't write here, if it can't.
function postBlocked() {
  const c = current!,
    s = state.session;
  if (c.dm) return c.dm.blocked || null;
  if (c.mirror === "read-only")
    return "This mirror is read-only until its owner opens it for writing.";
  if (
    c.federation_enabled &&
    (!s.federation_enabled ||
      !s.user?.federation_send ||
      !s.user?.federation_post)
  )
    return "Your administrator must enable sending and posting in federated channels for your role before you can write here.";
  return null;
}
const canPost = () => !!current?.role && !postBlocked();

// ---- the frame: channels on the left, the conversation and its compose box on the right ----
// The inbox borrows the frame too (inbox.ts): it fills the same heading, feed and toolbar.
export function chatFrame(view: HTMLElement) {
  if (view.querySelector(".workspace")) return;
  view.innerHTML = `<div class="workspace"><aside class="sidebar" id="sidebar" aria-label="Conversations">
      <nav id="channel-list" aria-label="Your conversations"></nav>
      <a class="side-foot" href="#/channels">${icon("compass")}<span>Browse all channels</span></a>
      <a class="side-foot" href="#/settings/federation/remote">${icon("globe")}<span>Join a federated channel</span></a>
      <a class="side-foot" href="#/xmpp">${icon("globe")}<span>Join an XMPP room</span></a>
      <button type="button" class="side-foot" data-new-dm>${icon("pencil")}<span>New direct message</span></button>
      <div class="side-resize" id="side-resize" role="separator" aria-orientation="vertical" aria-label="Sidebar width" aria-valuemin="180" aria-valuemax="520" tabindex="0" title="Drag to resize. Double-click to reset."></div></aside>
      <main class="conversation" id="main"><header class="channel-header"><div id="channel-heading"></div><div class="header-actions" id="channel-actions"></div></header>
      <div class="feed-wrap"><div id="message-list" class="feed" role="log" aria-label="Conversation" tabindex="-1"><div class="feed-inner"><div id="feed-top"></div><div id="rows"></div><div id="feed-empty"></div></div></div>
      <button type="button" id="new-pill" class="new-pill" hidden></button></div>
      <div id="composer-area"></div></main>
      <aside class="members-panel" id="member-panel" aria-label="Members" hidden></aside></div>`;
  painted = false;
  wireSidebar($("#channel-list"));
  wireFeed();
  $("#channel-actions").addEventListener("click", (e) => {
    if ((e.target as Element).closest("#members")) toggleMembers();
  });
  $("#member-panel").addEventListener("click", (e) => {
    if ((e.target as Element).closest("[data-close-members]")) toggleMembers();
  });
}
export async function showChat(
  view: HTMLElement,
  id?: string,
  topicId?: string,
) {
  chatFrame(view);
  if (!id) {
    const saved = localStorage.getItem("archipel-channel");
    if (saved?.startsWith("dm:")) return go(dmHref(saved.slice(3)));
    const first =
      state.channels.find((c) => c.id === saved && c.readable) ||
      state.channels.find((c) => c.role && c.readable);
    if (first) return go(`#/c/${first.id}`);
    resetChat();
    renderSidebar();
    $("#channel-heading").innerHTML = "<h1><strong>Chat</strong></h1>";
    $("#channel-actions").innerHTML = "";
    $("#feed-top").innerHTML = $("#rows").innerHTML = "";
    $("#rows").className = "rows";
    $("#new-pill").hidden = true;
    $("#feed-empty").innerHTML =
      `<div class="card empty"><h2>You haven't joined a channel yet</h2><p class="muted">Browse the channels on ${esc(state.session.instance)}, or start one.</p><p class="row center"><a class="button" href="#/channels">Browse channels</a><a class="button secondary" href="#/channels/new">Create a channel</a></p></div>`;
    $("#composer-area").innerHTML = "";
    return;
  }
  if (current?.id !== id) return selectChannel(id, topicId);
  const next = topicOf(topicId || null) ? topicId! : null;
  if (!painted || next !== narrow) {
    if (next !== narrow) reply = null;
    narrow = next;
    paint();
  }
}
async function selectChannel(id: string, topicId?: string) {
  const token = ++generation;
  let detail: Channel, page: Page;
  try {
    [detail, page] = await load(id);
  } catch (error) {
    if (generation !== token) return;
    current = null;
    localStorage.removeItem("archipel-channel");
    toast((error as Error).message, true);
    return go("#/channels");
  }
  if (generation !== token) return;
  current = detail;
  messages = page.messages;
  olderCursor = page.older_cursor;
  reply = editing = null;
  narrow = topicOf(topicId || null) ? topicId! : null;
  collapsed.clear();
  seen.clear();
  marked = 0;
  lastSignature = JSON.stringify(messages);
  localStorage.setItem("archipel-channel", id);
  markSeen();
  paint();
}
function paint() {
  painted = true;
  unseen = [];
  $("#sidebar").classList.remove("mobile-open");
  $("#rows").innerHTML = "";
  renderSidebar();
  renderHeader();
  renderMembers();
  renderComposer(false);
  render({ bottom: true });
}

// ---- who is here: the channel's members, beside the conversation ----
const MEMBERS = "archipel-members";
function membersOpen() {
  try {
    const saved = localStorage.getItem(MEMBERS);
    return saved ? saved === "1" : innerWidth >= 1100;
  } catch {
    return innerWidth >= 1100;
  }
}
function toggleMembers() {
  try {
    localStorage.setItem(MEMBERS, membersOpen() ? "0" : "1");
  } catch {
    /* Without storage the panel keeps its default. */
  }
  renderHeader();
  renderMembers();
}
const ranks = [
  ["owner", "Owner"],
  ["moderator", "Moderators"],
  ["member", "Members"],
] as const;
function renderMembers() {
  const panel = document.querySelector<HTMLElement>("#member-panel");
  if (!panel) return;
  const c = current,
    show = !!c && !c.dm && membersOpen();
  panel.hidden = !show;
  if (!show) return;
  const members = c.members || [];
  const html = `<div class="panel-head"><h2 class="grow">Members <span class="muted">${members.length}</span></h2><a class="icon-button" href="#/settings/channel/members/${c.id}" aria-label="Manage members" title="Roles, invitations and removal">${icon("settings")}</a><button type="button" class="icon-button" data-close-members aria-label="Hide members" title="Hide members">${icon("x")}</button></div>
    <div class="panel-body">${ranks
      .map(([role, label]) => {
        const list = members.filter((u) => u.role === role);
        return list.length
          ? `<h3 class="side-label">${label}${role === "owner" ? "" : ` · ${list.length}`}</h3><ul class="plain member-rows">${list.map((u) => `<li>${avatar(u, "small")}${nameButton(u, u.actor_url, "member-name")}${u.actor_url?.startsWith("xmpp:") ? '<span class="mode-tag">XMPP</span>' : u.actor_url && !u.actor_url.startsWith(location.origin) ? `<span class="mode-tag" title="On another instance">${icon("globe")}</span>` : ""}</li>`).join("")}</ul>`
          : "";
      })
      .join("")}</div>`;
  if (panel.dataset.html !== html) panel.innerHTML = panel.dataset.html = html;
}

export function sortedTopics() {
  const last = new Map<string, number>();
  for (const m of messages) if (m.topic_id) last.set(m.topic_id, m.seq);
  return [...(current?.topics || [])].sort(
    (a, b) => (last.get(b.id) || 0) - (last.get(a.id) || 0),
  );
}
function renderHeader() {
  const c = current!,
    topic = topicOf(narrow);
  if (c.dm) {
    $("#channel-heading").innerHTML =
      `<h1>${avatar(c.dm, "small")}<strong>${nameButton(c.dm, c.dm.peer)}</strong></h1><span class="handle">@${esc(c.dm.username)}</span>${c.dm.remote ? '<span class="pill new">Remote</span>' : ""}<span class="desc muted small">Direct messages</span>`;
    $("#channel-actions").innerHTML = "";
    return;
  }
  $("#channel-heading").innerHTML =
    `<h1>${channelIcon(c)}<strong>${esc(c.name)}</strong>${topic ? `${icon("chevron-right", "sep")}<span class="topic-name">${esc(topic.title)}</span>` : ""}</h1><span class="pill">${modeLabel(c.mode)}</span>${c.remote_actor ? '<span class="pill new">Remote</span>' : c.federation_enabled ? '<span class="pill new">Federated</span>' : ""}${c.bridge_room ? `<span class="pill new" title="Bridged with the XMPP room ${esc(c.bridge_room)}">Bridged</span>` : ""}${c.mirror ? `<span class="pill new">${c.mirror === "writable" ? "Fork" : "Mirror"}</span>` : ""}${c.description ? `<span class="desc muted small">${esc(c.description)}</span>` : ""}`;
  $("#channel-actions").innerHTML =
    `<button type="button" class="act" id="members" aria-pressed="${membersOpen()}" title="Show or hide the members of #${esc(c.name)}">${icon("people")}<span>${c.member_count} member${c.member_count === 1 ? "" : "s"}</span></button><a class="icon-button" href="#/settings/channel/overview/${c.id}" aria-label="Channel settings" title="Channel settings">${icon("settings")}</a>`;
}

// ---- messages ----
const excerpt = (body: string) =>
  body.length > 90 ? `${body.slice(0, 90)}…` : body;
const edited = (m: Message) =>
  m.edited_at && !m.deleted_at
    ? `<span class="edited" title="${esc(full(m.edited_at))}">(edited)</span>`
    : "";
function bodyHtml(m: Message, cls = "") {
  if (editing === m.id && !m.deleted_at)
    return `<form class="stack inline-form picker-host" data-edit-form="${m.id}">${m.title !== null ? `<input name="title" maxlength="160" value="${esc(m.title)}" aria-label="Thread title" required>` : ""}<textarea name="body" rows="3" maxlength="8000" aria-label="Edited message" required>${esc(m.body)}</textarea><p class="form-error" role="alert"></p><div class="row"><button class="small">Save changes</button><button type="button" class="small secondary" data-cancel-edit>Cancel</button><button type="button" class="icon-button" data-emoji-for aria-label="Choose emoji" title="Emoji">${icon("smile")}</button>${attachButton("data-attach-for")}</div></form>`;
  return `<div class="message-body${cls ? ` ${cls}` : ""}${m.deleted_at ? " faded" : " markdown"}">${m.deleted_at ? "This message was removed." : richHtml(m.body, m.emojis || [])}</div>`;
}
// Direct messages stay as they were sent.
const mine = (m: Message) =>
  !m.deleted_at && !current!.dm && !!current!.role && m.author_id === me().id;
const removable = (m: Message) =>
  !m.deleted_at &&
  !current!.dm &&
  (m.author_id === me().id || canModerate(current!));
// Occupants of other XMPP servers are marked; their handle is their full address.
const author = (m: Message) =>
  nameButton(m, m.history_placeholder ? undefined : m.author_actor_url) +
  (m.author_actor_url?.startsWith("xmpp:") ? ' <span class="pill new">XMPP</span>' : "");

function chatMessage(m: Message, cont: boolean) {
  const parent = m.parent_id
    ? messages.find((p) => p.id === m.parent_id)
    : null;
  const context = parent
    ? `<button type="button" class="reply-context" data-jump="${parent.id}">${icon("reply")}<strong>${esc(parent.display_name)}</strong><span>${parent.deleted_at ? "removed message" : emojiHtml(excerpt(markdownText(parent.body)), parent.emojis || [])}</span></button>`
    : m.parent_id
      ? `<div class="reply-context">${icon("reply")}<span>Reply to an earlier message</span></div>`
      : "";
  const time = `<time datetime="${esc(m.created_at)}" title="${esc(full(m.created_at))}">${esc(clock(m.created_at))}</time>`;
  const tools = [
    canPost() && !m.deleted_at && current!.mode === "topical"
      ? `<button type="button" class="icon-button reply-button" data-reply="${m.id}" aria-label="Reply to ${esc(m.display_name)}" title="Reply">${icon("reply")}</button>`
      : "",
    canPost() && !m.deleted_at
      ? `<button type="button" class="icon-button quote-button" data-quote="${m.id}" aria-label="Quote ${esc(m.display_name)}" title="Quote">${icon("quote")}</button>`
      : "",
    mine(m)
      ? `<button type="button" class="icon-button edit-button" data-edit="${m.id}" aria-label="Edit message" title="Edit">${icon("pencil")}</button>`
      : "",
    removable(m)
      ? `<button type="button" class="icon-button delete-button" data-delete="${m.id}" aria-label="Remove message" title="Remove">${icon("trash")}</button>`
      : "",
  ].join("");
  return `<article class="message${cont ? " cont" : ""}${m.deleted_at ? " deleted" : ""}" id="m-${m.id}"><div class="msg-gutter">${cont ? time : avatar(m)}</div>
    <div class="message-content">${cont ? "" : `<div class="message-meta">${author(m)}<span class="handle">@${esc(m.username)}</span>${time}${edited(m)}</div>`}${context}${bodyHtml(m)}${cont ? edited(m) : ""}</div>${tools ? `<div class="message-actions">${tools}</div>` : ""}</article>`;
}
// Consecutive messages from one person within ten minutes share a header, as in Zulip.
function chatKids(list: Message[]): Node[] {
  return list.map((m, i) => {
    const prev = list[i - 1];
    const cont =
      !!prev &&
      prev.author_id === m.author_id &&
      !m.parent_id &&
      new Date(m.created_at).getTime() - new Date(prev.created_at).getTime() <
        600000;
    return { key: m.id, html: chatMessage(m, cont) };
  });
}
function chatNodes(list: Message[]): Node[] {
  const c = current!,
    groups: Message[][] = [];
  for (const m of list) {
    const last = groups.at(-1)?.at(-1);
    if (
      last &&
      sameDay(last.created_at, m.created_at) &&
      last.topic_id === m.topic_id
    )
      groups.at(-1)!.push(m);
    else groups.push([m]);
  }
  return groups.map((group) => {
    const first = group[0],
      day = esc(dayLabel(first.created_at));
    const head =
      c.mode === "topical"
        ? `<header class="recipient-bar"><a class="rb-channel" href="#/c/${c.id}">${channelIcon(c)}${esc(c.name)}</a>${icon("chevron-right", "sep")}<a class="rb-topic" href="#/c/${c.id}/t/${first.topic_id}">${esc(topicOf(first.topic_id)?.title || "(no topic)")}</a><span class="rb-date">${day}</span></header>`
        : `<div class="day-divider"><span>${day}</span></div>`;
    return {
      key: `g-${first.id}`,
      html: `<section class="${c.mode === "topical" ? "topic-group" : "day-group"}">${head}<div class="group-body" data-kids></div></section>`,
      kids: chatKids(group),
    };
  });
}

// Threads look like ThreadBNC's: the post in a card, its replies folded on coloured rails below.
function threadActions(m: Message) {
  const parts = [
    canPost() && !m.deleted_at
      ? `<details class="reply-box"><summary aria-label="Reply to ${esc(m.display_name)}">${icon("reply")} Reply</summary><form class="stack inline-form picker-host" data-reply-form="${m.id}"><textarea name="body" rows="3" maxlength="8000" required aria-label="Reply" placeholder="Reply to ${esc(m.display_name)}"></textarea><p class="form-error" role="alert"></p><div class="row"><button class="small">Reply</button><button type="button" class="icon-button" data-emoji-for aria-label="Choose emoji" title="Emoji">${icon("smile")}</button>${attachButton("data-attach-for")}<span class="muted">Ctrl + Enter to send</span></div></form></details>`
      : "",
    mine(m)
      ? `<button type="button" class="link edit-button" data-edit="${m.id}" aria-label="Edit message">Edit</button>`
      : "",
    removable(m)
      ? `<button type="button" class="link bad-text delete-button" data-delete="${m.id}" aria-label="Remove message">Remove</button>`
      : "",
  ].join("");
  return parts ? `<div class="obj-actions small">${parts}</div>` : "";
}
const byline = (m: Message) =>
  `${author(m)} <span class="handle">@${esc(m.username)}</span> · ${when(m.created_at)}${m.edited_at && !m.deleted_at ? ` · ${edited(m)}` : ""}`;
function threadNodes(list: Message[]): Node[] {
  const ids = new Set(list.map((m) => m.id)),
    children = new Map<string, Message[]>();
  for (const m of list)
    if (m.parent_id && ids.has(m.parent_id))
      children.set(m.parent_id, [...(children.get(m.parent_id) || []), m]);
  const count = (m: Message): number =>
    (children.get(m.id) || []).reduce((n, child) => n + 1 + count(child), 0);
  const replies = (n: number) => `${n} repl${n === 1 ? "y" : "ies"}`;
  const comment = (m: Message, depth: number): Node => {
    const n = count(m);
    return {
      key: m.id,
      html: `<details open class="comment message d${depth % 8}" id="m-${m.id}" data-depth="${depth}"><summary class="meta small message-meta"><span class="fold" aria-hidden="true">${icon("chevron-down")}</span>${byline(m)}<span class="collapsed-note">${n ? `${replies(n)} hidden` : "collapsed"}</span></summary>
        <button type="button" class="bar" title="Collapse this thread" aria-label="Collapse this thread"></button>
        <div class="content">${bodyHtml(m, "md")}${threadActions(m)}<div class="replies" data-kids></div></div></details>`,
      kids: (children.get(m.id) || []).map((child) => comment(child, depth + 1)),
    };
  };
  return list
    .filter((m) => !m.parent_id || !ids.has(m.parent_id))
    .map((m) => {
      if (m.parent_id)
        return {
          key: `t-${m.id}`,
          html: '<section class="thread card"><p class="muted small thread-orphan">In reply to an earlier message</p><div class="comments" data-kids></div></section>',
          kids: [comment(m, 0)],
        };
      // The post and everything said under it share one card; the replies fold away together.
      const n = count(m);
      return {
        key: `t-${m.id}`,
        html: `<section class="thread card"><article class="post message" id="m-${m.id}">${m.title && editing !== m.id ? `<h2 class="thread-title">${emojiHtml(m.title, m.emojis || [])}</h2>` : ""}<div class="meta small message-meta">${byline(m)}</div>${bodyHtml(m, "md")}${threadActions(m)}</article>${n ? `<details open class="thread-replies" data-key="r-${m.id}"><summary title="Show or hide every reply in this thread">${icon("chevron-down", "chev")}<span>${replies(n)}</span></summary><div class="comments" data-kids></div></details>` : '<div class="comments" data-kids></div>'}</section>`,
        kids: (children.get(m.id) || []).map((child) => comment(child, 0)),
      };
    });
}

// ---- putting them on the page: only what changed is touched, so new messages arrive in place ----
const sources = new WeakMap<Element, string>();
const slot = (el: Element) =>
  el.matches("[data-kids]") ? el : el.querySelector("[data-kids]");
// Someone is writing in it (an edit, or a reply box): leave it be until they're done.
function busy(el: Element) {
  const own = el.parentElement?.closest("[data-kids]") || null;
  return $$<HTMLTextAreaElement>("textarea", el).some(
    (t) =>
      (t.closest("[data-kids]") || null) === own &&
      (document.activeElement === t || t.value !== t.defaultValue),
  );
}
function sync(parent: Element, nodes: Node[], animate: boolean) {
  const old = new Map<string, HTMLElement>();
  for (const el of [...parent.children] as HTMLElement[])
    if (el.dataset.key) old.set(el.dataset.key, el);
  let ref = parent.firstElementChild;
  for (const node of nodes) {
    let el = old.get(node.key);
    old.delete(node.key);
    if (!el || (sources.get(el) !== node.html && !busy(el))) {
      const template = document.createElement("template");
      template.innerHTML = node.html.trim();
      const made = template.content.firstElementChild as HTMLElement;
      made.dataset.key = node.key;
      sources.set(made, node.html);
      if (el) {
        const from = slot(el),
          to = slot(made);
        if (from && to) to.append(...from.children);
        if (ref === el) ref = made;
        el.replaceWith(made);
      } else if (animate && !seen.has(node.key)) {
        made.classList.add("pop");
        popped.push(node.key);
      }
      el = made;
    }
    seen.add(node.key);
    if (el === ref) ref = ref.nextElementSibling;
    else parent.insertBefore(el, ref);
    const inside = node.kids && slot(el);
    if (inside) sync(inside, node.kids!, animate);
  }
  for (const el of old.values()) el.remove();
}
function render(
  opts: { bottom?: boolean; animate?: boolean; anchor?: boolean } = {},
) {
  if (!current || !document.querySelector("#rows")) return;
  const c = current,
    list = $("#message-list");
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80,
    oldHeight = list.scrollHeight,
    oldTop = list.scrollTop;
  const shown =
    c.mode === "topical" && narrow
      ? messages.filter((m) => m.topic_id === narrow)
      : messages;
  const top = `${
    olderCursor
      ? '<button type="button" id="older-messages" class="secondary small older-button">Load earlier messages</button>'
      : c.dm
        ? `<div class="channel-intro"><h2>${avatar(c.dm)}${esc(c.name)}</h2><p class="muted">The start of your direct messages with ${esc(c.name)}. Only the two of you can read them.</p><p class="muted small"><code>@${esc(c.dm.username)}</code>${c.dm.remote ? " · on another instance" : ""}</p></div>`
        : `<div class="channel-intro"><h2>${channelIcon(c)}${esc(c.name)}</h2><p class="muted">${esc(c.description || "The start of this channel.")}</p><p class="muted small">${c.visibility === "members" ? "Members only" : "Public"} · ${modeLabel(c.mode)} · <code>#${esc(c.name)}@${esc(c.remote_actor ? new URL(c.remote_actor).host : state.session.instance)}</code></p></div>`
  }${c.mode === "threaded" && shown.some((m) => m.parent_id) ? '<div class="toolbar"><button type="button" class="small secondary" data-fold="open">Expand all</button><button type="button" class="small secondary" data-fold="closed">Collapse all</button></div>' : ""}`;
  if ($("#feed-top").innerHTML !== top) $("#feed-top").innerHTML = top;
  popped = [];
  sync(
    $("#rows"),
    c.mode === "threaded" ? threadNodes(shown) : chatNodes(shown),
    !!opts.animate,
  );
  $("#rows").className = `rows mode-${c.mode}`;
  $("#feed-empty").innerHTML = shown.length
    ? ""
    : `<p class="card empty muted">${c.mode === "threaded" ? "No threads yet." : narrow ? "No messages in this topic yet." : "No messages yet."}</p>`;
  for (const d of $$<HTMLDetailsElement>(folds, list))
    d.open = !collapsed.has(d.dataset.key!);
  refreshTimes(list);
  const arrived = popped.filter((key) =>
    messages.some((m) => m.id === key && m.author_id !== me().id),
  );
  if (opts.bottom) list.scrollTop = list.scrollHeight;
  else if (opts.anchor)
    list.scrollTop = oldTop + Math.max(0, list.scrollHeight - oldHeight);
  else if (!threaded() && atBottom)
    list.scrollTo({
      top: list.scrollHeight,
      behavior: opts.animate ? "smooth" : "auto",
    });
  else unseen.push(...arrived);
  updatePill();
}
// What folds in a threaded channel: one reply with those under it, or all of a thread's replies.
const folds = "details.comment, details.thread-replies";
function inView(el: Element) {
  const box = $("#message-list").getBoundingClientRect(),
    r = el.getBoundingClientRect();
  return r.top < box.bottom && r.bottom > box.top;
}
function updatePill() {
  const list = $("#message-list"),
    pill = $<HTMLButtonElement>("#new-pill");
  if (unseen.length) {
    if (
      !threaded() &&
      list.scrollHeight - list.scrollTop - list.clientHeight < 80
    )
      unseen = [];
    else
      unseen = unseen.filter((id) => {
        const el = document.getElementById(`m-${id}`);
        return el && (!threaded() || !inView(el));
      });
  }
  pill.hidden = !unseen.length;
  if (unseen.length)
    pill.innerHTML = `${icon("arrow-down")} ${unseen.length} new ${threaded() ? (unseen.length === 1 ? "reply" : "replies") : `message${unseen.length === 1 ? "" : "s"}`}`;
}
function flash(el: Element) {
  el.classList.add("flash-target");
  setTimeout(() => el.classList.remove("flash-target"), 1400);
}
function reveal(id: string) {
  const el = document.getElementById(`m-${id}`);
  if (!el) return;
  for (
    let p = el.parentElement?.closest<HTMLDetailsElement>(folds);
    p;
    p = p.parentElement?.closest<HTMLDetailsElement>(folds)
  ) {
    collapsed.delete(p.dataset.key!);
    p.open = true;
  }
  el.scrollIntoView({ block: "center" });
  flash(el);
}

async function inline(form: HTMLFormElement, fn: (data: FormData) => Promise<void>) {
  const buttons = $$<HTMLButtonElement>("button:not([type=button])", form),
    error = $(".form-error", form);
  if (buttons.some((b) => b.disabled)) return;
  const data = new FormData(form);
  buttons.forEach((b) => (b.disabled = true));
  error.textContent = "";
  try {
    await fn(data);
  } catch (err) {
    error.textContent = (err as Error).message;
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}
function merge(message: Message) {
  messages = [...messages.filter((m) => m.id !== message.id), message].sort(
    (a, b) => a.seq - b.seq,
  );
}
function wireFeed() {
  const list = $("#message-list");
  let ticking = false;
  list.addEventListener("scroll", () => {
    if (ticking || !unseen.length) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      updatePill();
    });
  });
  $("#new-pill").addEventListener("click", () => {
    if (threaded() && unseen.length) reveal(unseen.shift()!);
    else list.scrollTo({ top: list.scrollHeight, behavior: "smooth" });
    updatePill();
  });
  // Folding is native <details>; remember it so a refresh doesn't undo it.
  list.addEventListener(
    "toggle",
    (e) => {
      const d = e.target as HTMLDetailsElement;
      if (d.matches("details.reply-box") && d.open) $("textarea", d).focus();
      if (!d.matches(folds)) return;
      if (d.open) collapsed.delete(d.dataset.key!);
      else collapsed.add(d.dataset.key!);
    },
    true,
  );
  list.addEventListener("keydown", (e) => {
    const area = (e.target as Element).closest<HTMLTextAreaElement>(
      ".inline-form textarea",
    );
    if (!area) return;
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      area.form!.requestSubmit();
    } else if (e.key === "Escape" && area.form!.dataset.editForm) {
      editing = null;
      area.form!.remove();
      render();
    }
  });
  list.addEventListener("submit", (e) => {
    e.preventDefault();
    const form = e.target as HTMLFormElement,
      id = current!.id,
      token = generation;
    if (form.dataset.editForm) {
      const message = messages.find((m) => m.id === form.dataset.editForm)!;
      void inline(form, async (data) => {
        await api(`/messages/${message.id}`, "PATCH", {
          body: data.get("body"),
          ...(message.title !== null ? { title: data.get("title") } : {}),
          expected_edited_at: message.edited_at,
        });
        editing = null;
        form.remove();
        await refreshCurrent();
      });
    } else if (form.dataset.replyForm)
      void inline(form, async (data) => {
        const message = await api<Message>(`/channels/${id}/messages`, "POST", {
          body: data.get("body"),
          parent_id: form.dataset.replyForm,
        });
        if (generation !== token) return;
        form.reset();
        (document.activeElement as HTMLElement | null)?.blur();
        closePicker();
        (form.parentElement as HTMLDetailsElement).open = false;
        if (message.queued)
          return toast(
            "Message queued for delivery to the channel’s home instance.",
          );
        collapsed.delete(form.dataset.replyForm!);
        merge(message);
        for (let up: Message | undefined = message; up; up = messages.find((m) => m.id === up!.parent_id))
          if (!up.parent_id) collapsed.delete(`r-${up.id}`);
        render();
        document
          .getElementById(`m-${message.id}`)
          ?.scrollIntoView({ block: "nearest" });
      });
  });
  list.addEventListener("click", (e) => {
    const at = e.target as Element;
    const on = <T extends HTMLElement = HTMLElement>(selector: string) =>
      at.closest<T>(selector);
    let hit: HTMLElement | null;
    if ((hit = on(".bar"))) {
      const d = hit.closest<HTMLDetailsElement>("details.comment")!;
      d.open = false;
      if (!inView($("summary", d))) d.scrollIntoView({ block: "nearest" });
    } else if ((hit = on("[data-fold]"))) {
      // Collapsing leaves the posts; expanding opens every reply under them.
      const open = hit.dataset.fold === "open";
      for (const d of $$<HTMLDetailsElement>(open ? folds : "details.thread-replies", list))
        d.open = open;
    } else if ((hit = on("[data-jump]"))) reveal(hit.dataset.jump!);
    else if ((hit = on("[data-emoji-for]")))
      togglePicker(hit, $<HTMLTextAreaElement>("textarea", hit.closest("form")!));
    else if ((hit = on("[data-attach-for]")))
      pickFiles($<HTMLTextAreaElement>("textarea", hit.closest("form")!));
    else if ((hit = on("[data-reply]"))) {
      reply = messages.find((m) => m.id === hit!.dataset.reply) || null;
      renderComposer();
      $("#message-body").focus();
    } else if ((hit = on("[data-quote]"))) {
      // An XMPP room's rows sit in this feed too, and answer for themselves (xmpp-rooms.ts).
      const quoted = messages.find((m) => m.id === hit!.dataset.quote),
        topic = document.querySelector<HTMLInputElement>("#compose-topic");
      if (!quoted) return;
      // The answer belongs with what it quotes, unless it is already a reply to something else.
      if (topic && !reply && quoted.topic_id)
        topic.value = topicOf(quoted.topic_id)?.title || topic.value;
      quoteInto($<HTMLTextAreaElement>("#message-body"), quoted.body);
    } else if ((hit = on("[data-edit]"))) {
      editing = hit.dataset.edit!;
      render();
      const area = document.querySelector<HTMLTextAreaElement>(
        `[data-edit-form="${editing}"] textarea`,
      );
      area?.focus();
      area?.setSelectionRange(area.value.length, area.value.length);
    } else if ((hit = on("[data-cancel-edit]"))) {
      editing = null;
      hit.closest("form")!.remove();
      render();
    } else if ((hit = on("[data-delete]"))) {
      const id = hit.dataset.delete!;
      action(async () => {
        if (
          !(await confirmDialog(
            "Remove this message?",
            "It will be replaced with a removed-message marker. Replies stay in the conversation.",
            "Remove message",
          ))
        )
          return;
        await api(`/messages/${id}`, "DELETE");
        await refreshCurrent();
      });
    } else if (on("#older-messages"))
      action(async () => {
        const id = current!.id,
          token = generation;
        const page = await api<Page>(pagePath(id, olderCursor));
        if (token !== generation) return;
        messages = [...page.messages, ...messages];
        olderCursor = page.older_cursor;
        lastSignature = JSON.stringify(messages);
        render({ anchor: true });
      });
    else if ((hit = on(".group-body > article")) && !on("a, button, form")) {
      // Touch screens have no hover: a tap shows a message's buttons.
      const shown = hit.classList.contains("show-actions");
      for (const el of $$(".show-actions", list))
        el.classList.remove("show-actions");
      hit.classList.toggle("show-actions", !shown);
    }
  });
}

// ---- the compose box ----
function renderComposer(keepDraft = true) {
  const area = document.querySelector<HTMLElement>("#composer-area");
  if (!area) return;
  closePicker();
  if (!current) {
    area.innerHTML = "";
    return;
  }
  const c = current;
  if (!c.role) {
    area.innerHTML = `<div class="composer-wrap"><div class="card join-bar"><div><strong>You're reading #${esc(c.name)} without having joined.</strong><p class="muted small">${c.can_join ? "Join the channel to post in it." : "This channel needs an invitation from a moderator."}</p></div>${c.can_join ? '<button type="button" id="join-channel">Join channel</button>' : ""}</div></div>`;
    document.querySelector("#join-channel")?.addEventListener("click", () =>
      action(async () => {
        await api(`/channels/${c.id}/join`, "POST", {});
        state.channels = await api<Channel[]>("/channels");
        generation++;
        current = null;
        await selectChannel(c.id);
      }),
    );
    return;
  }
  const blocked = postBlocked();
  if (blocked) {
    area.innerHTML = `<div class="composer-wrap"><p class="card composer-hint muted">${esc(blocked)}</p></div>`;
    return;
  }
  const value = (selector: string) =>
    keepDraft
      ? document.querySelector<HTMLInputElement>(selector)?.value || ""
      : "";
  const draft = value("#message-body"),
    title = value("#thread-title"),
    hadFocus = document.activeElement?.id === "message-body";
  let topic = value("#compose-topic");
  if (reply?.topic_id) topic = topicOf(reply.topic_id)?.title || topic;
  else if (narrow && !keepDraft) topic = topicOf(narrow)?.title || "";
  if (c.mode === "topical" && !topic)
    topic = topicOf(narrow || messages.at(-1)?.topic_id || null)?.title || "";
  const place =
    c.mode === "threaded"
      ? "Start the thread…"
      : reply
        ? `Reply to ${reply.display_name}…`
        : `Message ${c.dm ? "" : "#"}${c.name}…`;
  area.innerHTML = `<div class="composer-wrap picker-host"><form id="composer" class="composer">
    ${c.mode === "topical" ? `<div class="compose-to">${channelIcon(c)}<span class="compose-channel">${esc(c.name)}</span>${icon("chevron-right", "sep")}<input id="compose-topic" list="topic-options" maxlength="100" placeholder="Topic" aria-label="Topic" autocomplete="off" required value="${esc(topic)}"><datalist id="topic-options"></datalist></div>` : ""}
    ${c.mode === "threaded" ? `<input id="thread-title" class="thread-input" maxlength="160" placeholder="New thread title" aria-label="Thread title" required value="${esc(title)}">` : ""}
    ${reply ? `<div class="reply-banner small">${icon("reply")}<span>Replying to <strong>${esc(reply.display_name)}</strong></span><button type="button" id="cancel-reply" class="icon-button" aria-label="Cancel reply">${icon("x")}</button></div>` : ""}
    <textarea id="message-body" maxlength="8000" rows="1" placeholder="${esc(place)}" aria-label="Message" required>${esc(draft)}</textarea>
    <div class="composer-bar"><button type="button" id="choose-emoji" class="icon-button" aria-label="Choose emoji" title="Emoji" aria-expanded="false">${icon("smile")}</button>${attachButton('id="attach-file"')}<span class="muted small composer-hint-keys"><kbd>Enter</kbd> to send · <kbd>Shift</kbd> + <kbd>Enter</kbd> for a new line · <span title="**bold**, *italic*, ~~struck~~, \`code\`, &gt; quote, - list, [text](link), ||spoiler||">Markdown</span></span><button id="send-message" type="submit" aria-label="Send message">${icon("send")}<span>${c.mode === "threaded" ? "Post thread" : "Send"}</span></button></div></form></div>`;
  const body = $<HTMLTextAreaElement>("#message-body");
  const grow = () => {
    body.style.height = "auto";
    body.style.height = `${Math.min(body.scrollHeight + 2, 240)}px`;
  };
  body.addEventListener("input", grow);
  grow();
  updateTopicOptions();
  if (hadFocus) body.focus();
  document.querySelector("#cancel-reply")?.addEventListener("click", () => {
    reply = null;
    renderComposer();
    $("#message-body").focus();
  });
  $("#choose-emoji").addEventListener("click", (e) =>
    togglePicker(e.currentTarget as HTMLElement, body),
  );
  document
    .querySelector("#attach-file")
    ?.addEventListener("click", () => pickFiles(body));
  body.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $<HTMLFormElement>("#composer").requestSubmit();
    }
  });
  $("#composer").addEventListener("submit", (e) => {
    e.preventDefault();
    action(async () => {
      const titleInput = document.querySelector<HTMLInputElement>("#thread-title"),
        topicInput = document.querySelector<HTMLInputElement>("#compose-topic");
      if (!body.value.trim()) return;
      const button = $<HTMLButtonElement>("#send-message");
      if (button.disabled) return;
      button.disabled = true;
      const token = generation;
      try {
        if (c.dm) {
          await api("/dms", "POST", { to: c.dm.peer, body: body.value });
          if (generation !== token) return;
          body.value = "";
          await refreshCurrent();
          if (generation !== token) return;
          render({ bottom: true });
          renderComposer();
          $("#message-body").focus();
          return;
        }
        let topicId: string | undefined;
        if (topicInput) {
          const wanted = topicInput.value.trim();
          let found = c.topics?.find(
            (t) => t.title.toLowerCase() === wanted.toLowerCase(),
          );
          if (!found) {
            found = await api<Topic>(`/channels/${c.id}/topics`, "POST", {
              title: wanted,
            });
            if (generation !== token) return;
            c.topics = [...(c.topics || []), found];
          }
          topicId = found.id;
          topicInput.value = found.title;
        }
        const message = await api<Message>(
          `/channels/${c.id}/messages`,
          "POST",
          {
            body: body.value,
            ...(titleInput ? { title: titleInput.value } : {}),
            ...(reply ? { parent_id: reply.id } : {}),
            ...(topicId ? { topic_id: topicId } : {}),
          },
        );
        if (generation !== token) return;
        body.value = "";
        if (titleInput) titleInput.value = "";
        reply = null;
        if (message.queued)
          toast("Message queued for delivery to the channel’s home instance.");
        else merge(message);
        if (narrow && topicId && narrow !== topicId)
          return go(`#/c/${c.id}/t/${topicId}`);
        renderSidebar();
        render({ bottom: true });
        renderComposer();
        $("#message-body").focus();
      } finally {
        button.disabled = false;
      }
    });
  });
}
function updateTopicOptions() {
  const options = document.querySelector("#topic-options");
  if (options)
    options.innerHTML = sortedTopics()
      .map((t) => `<option value="${esc(t.title)}"></option>`)
      .join("");
}

// ---- keeping up: called every few seconds while the conversation is on screen ----
export function redrawChat(composer = false) {
  if (!current) return;
  render();
  if (composer) renderComposer();
}
export async function refreshCurrent() {
  if (!current) return;
  const id = current.id,
    token = generation;
  const [detail, page] = await load(id);
  if (generation !== token) return;
  const roleChanged = detail.role !== current.role,
    federationChanged =
      detail.federation_enabled !== current.federation_enabled ||
      detail.dm?.blocked !== current.dm?.blocked,
    topicsChanged =
      JSON.stringify(detail.topics) !== JSON.stringify(current.topics),
    headerChanged =
      detail.member_count !== current.member_count ||
      detail.description !== current.description ||
      detail.dm?.avatar_url !== current.dm?.avatar_url ||
      detail.name !== current.name;
  current = detail;
  if (narrow && !topicOf(narrow)) return go(`#/c/${id}`);
  // Refresh earlier loaded pages too so edits/removals never remain visible in cached history.
  let fresh = page.messages,
    cursor = page.older_cursor;
  const oldest = messages[0]?.seq;
  while (cursor && oldest && fresh[0].seq > oldest) {
    const previous = await api<Page>(pagePath(id, cursor));
    if (generation !== token) return;
    fresh = [...previous.messages, ...fresh];
    cursor = previous.older_cursor;
  }
  messages = fresh;
  olderCursor = cursor;
  if (!document.querySelector("#rows")) return;
  markSeen();
  if (roleChanged || federationChanged || headerChanged || topicsChanged)
    renderHeader();
  renderMembers();
  const signature = JSON.stringify(messages);
  if (signature !== lastSignature || roleChanged || federationChanged) {
    lastSignature = signature;
    render({ animate: true });
  } else refreshTimes($("#message-list"));
  renderSidebar();
  if (topicsChanged) updateTopicOptions();
  if (roleChanged || federationChanged) {
    reply = null;
    renderComposer();
  }
}
