import {
  $,
  $$,
  action,
  adoptable,
  adoptEmojiDialog,
  api,
  avatar,
  canModerate,
  channelCan,
  channelIcon,
  channelShares,
  clock,
  confirmDialog,
  hooks,
  dayLabel,
  dmHref,
  emojiHtml,
  esc,
  full,
  go,
  handleTag,
  icon,
  modeLabel,
  nameButton,
  popup,
  promptDialog,
  refreshTimes,
  richHtml,
  emojiOnly,
  roleLabel,
  sameDay,
  shareDialog,
  state,
  toast,
  touch,
  when,
  type Channel,
  type Conversation,
  type Message,
  type Reaction,
  type Topic,
  type User,
} from "./shared.js";
import { closePicker, suggestShortcodes, togglePicker } from "./picker.js";
import { renderSidebar, sidebarFrame } from "./sidebar.js";
import { attachButton, pickFiles, quoteInto } from "./attach.js";
import { markdownText } from "./markdown.js";
import { appStyle, isFusion } from "./appearance.js";
import { isHidden, notifies, pickPref, prefItems, prefMenu, type PrefKind } from "./prefs.js";

interface Page {
  messages: Message[];
  older_cursor: number | null;
  pending?: Message[];
  refresh_cursor?: number;
  refresh_stamp?: string;
  incremental?: boolean;
}
// A piece of the conversation: its markup, and what goes in its [data-kids] element.
interface Node {
  key: string;
  html: string;
  kids?: Node[];
}

let current: Channel | null = null,
  messages: Message[] = [],
  pending: Message[] = [], // written here, still on their way to the channel's home instance
  olderCursor: number | null = null;
let refreshCursor: number | undefined, refreshStamp: string | undefined, historyExpanded = false;
// The page holds a window of a few server pages around what is being read, however long the
// history. Scrolling fetches the next page at either end and lets go of the far one. What was
// let go below is remembered by the cursor that fetches it again, nearest the window last.
const PAGE = 100, WINDOW = 300;
let newer: { before: number | null; first: number }[] = [],
  paging = false;
const live = () => !newer.length; // the window reaches the newest message
const ceiling = () => newer.at(-1)?.first ?? Infinity;
const inWindow = (m: Message) => m.seq >= (olderCursor ?? -Infinity) && m.seq < ceiling();
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
let showHidden = false, // hidden threads are on the page for now
  lastPrefs = "";
let selectedMessage: string | null = null, messageSearch = "";
let threadTitleDraft = "";

export const fusionToolbarHtml = () => `<div class="fusion-toolbar" id="fusion-toolbar"><div id="fusion-chat-tools" class="fusion-tool-group picker-host"><button type="button" data-fusion-action="new">${icon("pencil")}<span id="fusion-new-label">New message</span></button><a class="fusion-tool" href="#/channels" data-open-window="channel">${icon("plus")} Join channel</a><span class="tool-separator"></span><button type="button" id="fusion-reply" data-fusion-action="reply" disabled>${icon("reply")} Reply</button><button type="button" id="fusion-react" data-fusion-action="react" disabled>${icon("smile")} React</button><button type="button" id="fusion-quote" data-fusion-action="quote" disabled>${icon("quote")} Quote</button><button type="button" id="fusion-collapse" data-fusion-action="collapse">${icon("collapse")} Collapse all</button><button type="button" id="fusion-members" data-fusion-action="members" aria-pressed="false">${icon("people")} Members</button><span class="grow"></span><input type="search" id="fusion-search" aria-label="Search messages" placeholder="Search messages" title="Search messages loaded in this conversation"></div><div id="fusion-directory-tools" class="fusion-tool-group"></div></div>`;
export function updateFusionToolbar() {
  const tools = document.querySelector<HTMLElement>("#fusion-chat-tools");
  if (!tools) return;
  const c = current, selected = messages.find(m => m.id === selectedMessage);
  const active = !!c && !!document.querySelector("#rows.mode-timeline, #rows.mode-topical, #rows.mode-threaded");
  $("#fusion-new-label", tools).textContent = c?.mode === "threaded" ? "New thread" : "New message";
  $("[data-fusion-action=new]", tools).setAttribute("aria-label", c?.mode === "threaded" ? "New thread" : "New message");
  for (const command of ["reply", "react", "quote"] as const) {
    const b = $<HTMLButtonElement>(`#fusion-${command}`, tools);
    b.disabled = !active || !selected || !!selected.deleted_at || !!selected.queued || !canPost() || (command === "reply" && !!c?.dm) || (command === "react" && !c?.reactions);
  }
  $("#fusion-collapse", tools).hidden = c?.mode !== "threaded";
  const members = $<HTMLButtonElement>("#fusion-members", tools);
  members.hidden = !c?.sees_members || !!c?.dm;
  members.setAttribute("aria-pressed", String(membersOpen()));
  const search = $<HTMLInputElement>("#fusion-search", tools);
  if (document.activeElement !== search) search.value = messageSearch;
  search.placeholder = c?.mode === "threaded" ? "Search threads" : "Search messages";
  const status = document.querySelector("#fusion-status-place");
  const view = document.querySelector<HTMLElement>(".app")?.dataset.view;
  const threads = c?.mode === "threaded" && olderCursor === null && live() ? messages.filter(m => !m.parent_id).length : 0;
  if (status) status.textContent = active && c
    ? threads ? `${c.name}, ${threads} thread${threads === 1 ? "" : "s"}` : `${c.name}, ${c.member_count} member${c.member_count === 1 ? "" : "s"}`
    : view === "channels" ? document.querySelector<HTMLElement>("#channel-table-body")?.dataset.summary || "Channel directory" : view === "settings" ? "Settings"
    : view === "xmpp" ? "XMPP rooms" : state.session?.instance || "";
  const hint = document.querySelector("#fusion-status-hint");
  if (hint) hint.textContent = view === "channels" ? "Double-click a channel to open it" : active && c && canPost() ? "Enter sends, Shift+Enter starts a new line" : "";
}
function selectFusionMessage(id: string | null) {
  const changed = selectedMessage !== id;
  selectedMessage = id;
  for (const row of $$(".message[id]")) row.classList.toggle("selected-message", row.id === `m-${id}`);
  updateFusionToolbar();
  // In threads the selected message is the one the composer answers, as its label says.
  if (!changed || !isFusion() || !threaded() || !document.querySelector("#composer")) return;
  const m = messages.find(m => m.id === id);
  const target = m && canPost() && !m.deleted_at && !m.queued ? m : null;
  if (target?.id !== reply?.id) { reply = target; renderComposer(); }
}
document.addEventListener("click", event => {
  const command = (event.target as Element).closest<HTMLElement>("[data-fusion-action]")?.dataset.fusionAction;
  if (!command) return;
  const m = messages.find(m => m.id === selectedMessage);
  if (command === "members" && current) toggleMembers();
  else if (command === "new") {
    if (!current || !canPost()) return go("#/channels");
    reply = null; selectFusionMessage(null); renderComposer();
    (document.querySelector<HTMLElement>("#thread-title") || document.querySelector<HTMLElement>("#message-body"))?.focus();
  } else if (command === "collapse") {
    const nodes = $$<HTMLDetailsElement>("details.fusion-thread", $("#rows"));
    const open = nodes.every(d => !d.open);
    for (const d of nodes) d.open = open;
  } else if (m && canPost() && !m.deleted_at && !m.queued) {
    if (command === "reply" || command === "quote") {
      const old = $<HTMLTextAreaElement>("#message-body"), [from, to] = [old.selectionStart, old.selectionEnd];
      reply = current!.dm ? null : m;
      renderComposer();
      const body = $<HTMLTextAreaElement>("#message-body");
      body.focus();
      body.setSelectionRange(from, to);
      // A quote is text in the message, to trim or write between like any other.
      if (command === "quote") quoteInto(body, m.body);
    } else if (command === "react") togglePicker($("#fusion-react"), name => react(m.id, name, true));
  }
});
document.addEventListener("input", event => {
  if ((event.target as HTMLElement).id !== "fusion-search") return;
  messageSearch = (event.target as HTMLInputElement).value.trim().toLowerCase();
  render();
});

export const chatChannel = () => current;
export const chatTopic = () => narrow;
export function resetChat() {
  current = null;
  selectedMessage = null; messageSearch = "";
  messages = [];
  pending = [];
  refreshCursor = undefined; refreshStamp = undefined; historyExpanded = false;
  newer = [];
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
  show_members: 0,
  hide_handles: 0,
  reactions: 0,
  reaction_bans: [],
  optional_titles: 0,
  sees_members: false,
  sees_handles: true,
  dm: c,
});
const pagePath = (id: string, before?: number | null) =>
  id.startsWith("dm:")
    ? `/dms/messages?peer=${encodeURIComponent(id.slice(3))}${before ? `&before=${before}` : ""}`
    : `/channels/${id}/messages${before ? `?before=${before}` : ""}`;
// `before` reads the page ending there instead of the newest one.
async function load(id: string, metadata = true, before?: number): Promise<[Channel, Page]> {
  if (id.startsWith("dm:")) {
    const data = await api<Page & { conversation: Conversation }>(pagePath(id, before));
    return [dmChannel(data.conversation), data];
  }
  if (!metadata && current?.id === id) {
    const list = document.querySelector<HTMLElement>("#message-list");
    if ((list && list.scrollHeight-list.scrollTop-list.clientHeight>=80) || selectedMessage || editing || reply) historyExpanded=true;
    const suffix = before === undefined && !historyExpanded && refreshCursor!==undefined && refreshStamp
      ? `?after=${refreshCursor}&stamp=${encodeURIComponent(refreshStamp)}` : "";
    return [current, await api<Page>(pagePath(id, before)+suffix)];
  }
  return Promise.all([
    api<Channel>(`/channels/${id}?members=0`),
    api<Page>(pagePath(id, before)),
  ]);
}
const bySeq = (a: Message, b: Message) => a.seq - b.seq;
// Within a screen of what is being read. Such a message stays on the page even outside the window.
function nearView(id: string) {
  const el = document.getElementById(`m-${id}`),
    list = document.querySelector<HTMLElement>("#message-list");
  if (!el || !list) return false;
  const box = list.getBoundingClientRect(),
    r = el.getBoundingClientRect();
  return r.height > 0 && r.bottom > box.top - list.clientHeight && r.top < box.bottom + list.clientHeight;
}
// Whether the reader is nearer the old end of what is loaded.
function readingOlder() {
  const list = document.querySelector<HTMLElement>("#message-list");
  return !!list && list.scrollTop + list.clientHeight / 2 < list.scrollHeight / 2;
}
// Lets go of the end of the window away from the reader until it fits. Older messages are simply
// dropped: the cursor reads them again. Newer ones go a page at a time, so each comes back whole.
function trim(dropNewer = readingOlder()) {
  const keep = (m: Message) => inWindow(m) || nearView(m.id);
  messages = messages.filter(keep);
  for (let held = messages.filter(inWindow); held.length > WINDOW; held = messages.filter(inWindow)) {
    if (dropNewer) {
      const chunk = held.slice(-Math.min(PAGE, held.length - WINDOW));
      if (live()) pending = [];
      newer.push({ before: newer.at(-1)?.first ?? null, first: chunk[0].seq });
    } else olderCursor = held[held.length - WINDOW].seq;
    messages = messages.filter(keep);
  }
}
function mergePage(page: Message[]) {
  const all = new Map(messages.map((m) => [m.id, m]));
  for (const m of page) all.set(m.id, m);
  messages = [...all.values()].sort(bySeq);
}
async function loadOlder() {
  if (paging || !current || !olderCursor) return;
  const id = current.id,
    token = generation;
  paging = true;
  try {
    const page = await api<Page>(pagePath(id, olderCursor));
    if (token !== generation) return;
    historyExpanded = true;
    mergePage(page.messages);
    olderCursor = page.older_cursor;
    trim(true);
    lastSignature = signature();
    render({ anchor: true });
  } finally {
    paging = false;
  }
  requestAnimationFrame(() => atEdge(false));
}
// Fetches again what was let go below. Messages may have arrived meanwhile, so a page that no
// longer reaches the window is set aside to read later and the gap under it is read first.
async function loadNewer() {
  if (paging || !current || live()) return;
  const id = current.id,
    token = generation;
  paging = true;
  try {
    for (let tries = 0; tries < 8 && !live(); tries++) {
      const next = newer.at(-1)!,
        page = await api<Page>(pagePath(id, next.before));
      if (token !== generation) return;
      newer.pop();
      const start = page.messages[0]?.seq;
      if (page.older_cursor && start !== undefined && start > next.first) {
        newer.push({ before: next.before, first: start }, { before: start, first: next.first });
        continue;
      }
      mergePage(page.messages);
      if (live()) {
        pending = page.pending || [];
        refreshCursor = page.refresh_cursor; refreshStamp = page.refresh_stamp;
        markSeen();
      }
      trim(false);
      lastSignature = signature();
      render({ anchor: true });
      break;
    }
  } finally {
    paging = false;
  }
  requestAnimationFrame(() => atEdge(false));
}
// Back to the newest messages, from wherever the reader is.
async function jumpToLatest() {
  if (!current) return;
  const id = current.id,
    token = generation;
  const page = await api<Page>(pagePath(id));
  if (token !== generation) return;
  messages = page.messages;
  pending = page.pending || [];
  olderCursor = page.older_cursor;
  newer = [];
  refreshCursor = page.refresh_cursor; refreshStamp = page.refresh_stamp; historyExpanded = false;
  lastSignature = signature();
  markSeen();
  render({ bottom: true });
}
// Near either end of what is on the page, the next page is fetched. Without the reader scrolling,
// only a short window is filled out, so an empty topic doesn't walk the whole history.
function atEdge(scrolled: boolean) {
  const list = document.querySelector<HTMLElement>("#message-list");
  if (!list || paging || !current) return;
  const room = list.clientHeight * 1.5;
  if (list.scrollTop < room && olderCursor && (scrolled || messages.filter(inWindow).length < WINDOW))
    action(loadOlder);
  else if (!live() && list.scrollHeight - list.scrollTop - list.clientHeight < room) action(loadNewer);
}
// Having this conversation on screen is reading it.
let readTimer=0;
const readPhase=Math.random()*30000;
const liveReads=new Map<string,number>();
function flushLiveReads(){clearTimeout(readTimer);readTimer=0;for(const [target,seq]of liveReads){liveReads.delete(target);void fetch("/api/read",{method:"POST",credentials:"same-origin",keepalive:true,headers:{"Content-Type":"application/json","X-CSRF-Token":state.session.csrf||""},body:JSON.stringify({target,seq})}).catch(()=>{if(current?.id===target)marked=0;});}}
addEventListener("pagehide",flushLiveReads);
document.addEventListener("visibilitychange",()=>{if(document.hidden)flushLiveReads();});
function markSeen(defer=false) {
  const last = messages.at(-1)?.seq;
  if (!current?.role || !last || document.hidden || !live()) return;
  if (last <= marked && !state.unread[current.id]) return;
  marked = last;
  delete state.unread[current.id];
  if(defer){liveReads.set(current.id,last);if(!readTimer)readTimer=window.setTimeout(flushLiveReads,(readPhase-Date.now()%30000+30000)%30000 || 30000);return;}
  liveReads.delete(current.id);
  void api("/read", "POST", { target: current.id, seq: last }).catch(() => {
    /* The next refresh tries again. */
    marked = 0;
  });
}
const me = () => state.session.user!;
// What is on the page: the conversation, then what is still being sent to it.
const everything = () => (pending.length && live() ? [...messages, ...pending] : messages);
const signature = () => JSON.stringify([messages, pending, state.userBlocks]);
const deltaCursors=new Map<string,number>();
let overviewCursor=0;
export function adoptMessageOverview(cursor?:number){if(Number.isSafeInteger(cursor))overviewCursor=Math.max(overviewCursor,cursor!);}
export function applyMessageDelta(delta:{channel:string;messages:Message[];cursor:number;added?:string[]}) {
  if(!delta || !Array.isArray(delta.messages) || !Number.isSafeInteger(delta.cursor))return;
  if((deltaCursors.get(delta.channel)||0)>=delta.cursor && !delta.messages.some(m=>m.edited_at || m.deleted_at))return;
  const after=Math.max(overviewCursor,deltaCursors.get(delta.channel)||0);
  deltaCursors.set(delta.channel,Math.max(deltaCursors.get(delta.channel)||0,delta.cursor));
  if(current?.id!==delta.channel){const added=new Set(delta.added||[]);if(state.channels.some(c=>c.id===delta.channel && c.role))state.unread[delta.channel]=(state.unread[delta.channel]||0)+delta.messages.filter(m=>added.has(m.id) && m.seq>after && m.author_id!==state.session.user?.id).length;renderSidebar();return;}
  const list=document.querySelector<HTMLElement>("#message-list");
  if((list && list.scrollHeight-list.scrollTop-list.clientHeight>=80) || selectedMessage || editing || reply)historyExpanded=true;
  const previous=new Map(messages.map(m=>[m.id,m]));
  // Away from the newest messages only those on the page change; the rest are read on the way down.
  for(const message of delta.messages){if(!message || typeof message.id!=="string" || !Number.isSafeInteger(message.seq) || (!live() && !previous.has(message.id)))continue;previous.set(message.id,{...previous.get(message.id),...message});}
  messages=[...previous.values()].sort(bySeq);
  if(live() && !historyExpanded && messages.length>PAGE){messages=messages.slice(-PAGE);olderCursor=messages[0].seq;}else trim();
  const committed=new Set(messages.map(m=>m.id));pending=pending.filter(m=>!committed.has(m.id));
  refreshCursor=Math.max(refreshCursor||0,delta.cursor);refreshStamp=undefined;
  markSeen(true);render();renderSidebar();
}
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
  const workspace = sidebarFrame(view);
  workspace.insertAdjacentHTML("beforeend", `<main class="conversation" id="main"><header class="channel-header"><div id="channel-heading"></div><div class="header-actions" id="channel-actions"></div></header>
      <div class="feed-wrap"><div id="message-list" class="feed" role="log" aria-label="Conversation" tabindex="-1"><div class="feed-inner"><div id="feed-top"></div><div id="rows"></div><div id="feed-empty"></div></div></div>
      <button type="button" id="new-pill" class="new-pill" hidden></button></div>
      <div id="composer-area"></div></main>
      <aside class="members-panel" id="member-panel" aria-label="Members" hidden><div class="side-resize" id="members-resize" role="separator" aria-orientation="vertical" aria-label="Members panel width" aria-valuemin="180" aria-valuemax="520" tabindex="0" title="Drag to resize. Double-click to reset."></div><div class="members-inner" id="member-list"></div></aside>`);
  painted = false;
  wireFeed();
  wireMembersResize();
  $("#channel-actions").addEventListener("click", (e) => {
    const at = e.target as Element,
      pref = at.closest<HTMLElement>("[data-pref-menu]");
    if (at.closest("#members")) toggleMembers();
    else if (pref) openPrefMenu(pref);
    else if (at.closest("#channel-options")) openChannelOptions(at.closest<HTMLElement>("#channel-options")!);
  });
  $("#member-panel").addEventListener("click", (e) => {
    if ((e.target as Element).closest("[data-close-members]")) toggleMembers();
    const act = (e.target as Element).closest<HTMLElement>("[data-ban-member],[data-kick-member]");
    if (act) hooks.memberAct({ id: act.dataset.banMember || act.dataset.kickMember }, act.dataset.banMember ? "ban" : "kick");
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
  pending = page.pending || [];
  olderCursor = page.older_cursor;
  newer = [];
  rosterFailed = false;
  refreshCursor = page.refresh_cursor; refreshStamp = page.refresh_stamp; historyExpanded = false;
  reply = editing = null;
  selectedMessage = null; messageSearch = "";
  narrow = topicOf(topicId || null) ? topicId! : null;
  collapsed.clear();
  seen.clear();
  showHidden = false;
  marked = 0;
  lastSignature = signature();
  localStorage.setItem("archipel-channel", id);
  markSeen();
  paint();
}
function paint() {
  painted = true;
  unseen = [];
  lastPrefs = JSON.stringify(state.prefs);
  $("#sidebar").classList.remove("mobile-open");
  $("#rows").innerHTML = "";
  renderSidebar();
  renderHeader();
  renderMembers();
  renderComposer(false);
  render({ bottom: true });
  requestAnimationFrame(() => atEdge(false));
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
  const frame = document.querySelector<HTMLElement>("#member-panel");
  const open = frame ? !frame.hidden : membersOpen();
  try {
    localStorage.setItem(MEMBERS, open ? "0" : "1");
  } catch {
    /* Without storage the panel keeps its default. */
  }
  renderHeader();
  renderMembers();
}
addEventListener("resize", () => {
  renderMembers();
  updateFusionToolbar();
});
// The list's sections, in order: the owner, the moderators, each role the owner made that someone holds, by
// name, and the members who hold none.
function memberSections(members: User[]) {
  const held = new Map<string, { label: string; list: User[] }>(),
    plain: User[] = [];
  for (const u of members.filter((u) => u.role === "member")) {
    const role = u.channel_role;
    if (!role) plain.push(u);
    else if (held.has(role.id)) held.get(role.id)!.list.push(u);
    else held.set(role.id, { label: role.name, list: [u] });
  }
  return [
    { label: "Owner", list: members.filter((u) => u.role === "owner"), counted: false },
    { label: "Moderators", list: members.filter((u) => u.role === "moderator"), counted: true },
    ...[...held.values()].sort((a, b) => a.label.localeCompare(b.label)).map((s) => ({ ...s, counted: true })),
    { label: "Members", list: plain, counted: true },
  ].filter((s) => s.list.length);
}
// The panel is as wide as the reader dragged it, here and in every channel.
const MEMBERS_WIDTH = "archipel-members-w";
function membersWidth(value: number | null) {
  const panel = $("#member-panel");
  if (value === null) return panel.style.removeProperty("--members-w");
  const width = Math.round(Math.max(180, Math.min(value, 520, innerWidth * 0.5)));
  panel.style.setProperty("--members-w", `${width}px`);
  $("#members-resize").setAttribute("aria-valuenow", String(width));
}
function wireMembersResize() {
  const panel = $("#member-panel"),
    handle = $("#members-resize");
  const keep = (value: string | null) => {
    try {
      if (value === null) localStorage.removeItem(MEMBERS_WIDTH);
      else localStorage.setItem(MEMBERS_WIDTH, value);
    } catch {
      /* Without storage the width lasts until the page is reloaded. */
    }
  };
  const save = () => keep(String(Math.round(panel.getBoundingClientRect().width)));
  try {
    const saved = Number(localStorage.getItem(MEMBERS_WIDTH));
    if (saved >= 180) membersWidth(saved);
  } catch {
    /* The panel keeps its usual width. */
  }
  handle.addEventListener("pointerdown", (e) => {
    if (e.button) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const ws = panel.parentElement!,
      right = panel.getBoundingClientRect().right;
    ws.classList.add("resizing-members");
    const move = (ev: PointerEvent) => membersWidth(right - ev.clientX);
    const done = () => {
      ws.classList.remove("resizing-members");
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", done);
      handle.removeEventListener("pointercancel", done);
      save();
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", done);
    handle.addEventListener("pointercancel", done);
  });
  handle.addEventListener("dblclick", () => {
    membersWidth(null);
    keep(null);
  });
  handle.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    membersWidth(
      panel.getBoundingClientRect().width + (e.key === "ArrowLeft" ? 16 : -16),
    );
    save();
  });
}
// Whoever may remove or ban can do it from a member's row, their menu or a message of theirs:
// moderators anyone but the owner (and only the owner another moderator), someone whose role allows
// it the members who hold no role.
function memberReach(u: User | undefined) {
  const c = current;
  const within = !!c && !c.dm && !!u && u.role !== "owner" && u.id !== me().id &&
    (u.role !== "moderator" || me().admin || c.role === "owner") && (canModerate(c) || !u.channel_role);
  return { kick: within && channelCan(c!, "kick_members"), ban: within && channelCan(c!, "ban_members") };
}
// Someone in the conversation that is open, by their address or by who they are here.
const memberOf = (who: { actor?: string; id?: string }) =>
  document.querySelector("#message-list")
    ? current?.members?.find((u) => (who.id ? u.id === who.id : !!who.actor && u.actor_url === who.actor))
    : undefined;
hooks.memberItems = (who) => {
  const u = memberOf(who),
    may = memberReach(u);
  const item = (act: string, label: string, ico: string) => `<button type="button" class="menu-item bad-text" role="menuitem" data-member-act="${act}">${icon(ico)}<span class="grow">${label}</span></button>`;
  return (may.kick ? item("kick", `Remove from #${esc(current!.name)}`, "logout") : "") + (may.ban ? item("ban", `Ban from #${esc(current!.name)}`, "block") : "");
};
hooks.memberAct = (who, act) => {
  const c = current,
    u = memberOf(who),
    ban = act === "ban";
  if (!c || !u || !memberReach(u)[ban ? "ban" : "kick"]) return;
  action(async () => {
    if (
      !(await (ban
        ? confirmDialog(`Ban ${u.display_name} from #${c.name}?`, "They are removed from the channel and cannot come back until the ban is lifted under Access rules, in the channel's settings.", "Ban from channel")
        : confirmDialog(`Remove ${u.display_name} from #${c.name}?`, "They leave the channel, and can join it again where it lets them.", "Remove from channel")))
    )
      return;
    await api(`/channels/${c.id}/members/${u.id}`, "PATCH", ban ? { rule: "block" } : { remove: true });
    toast(ban ? `${u.display_name} is banned from #${c.name}.` : `${u.display_name} is removed from #${c.name}.`);
    await refreshCurrent();
  });
};
let rosterLoading=false,rosterAuto="",rosterFailed=false;
async function loadMemberPage() {
  if(rosterLoading || !current || current.members_cursor==null)return;
  const channel=current,token=generation;rosterLoading=true;
  try {
    const page=await api<{members:User[];next:string|null}>(`/channels/${channel.id}/member-page?after=${encodeURIComponent(channel.members_cursor??"")}`);
    if(current!==channel || generation!==token)return;
    channel.members=[...(channel.members||[]),...page.members];channel.members_cursor=page.next;
  }catch{rosterFailed=true;toast("Members could not be loaded.");}
  finally{rosterLoading=false;renderMembers();}
}
function renderMembers() {
  const frame = document.querySelector<HTMLElement>("#member-panel"),
    panel = document.querySelector<HTMLElement>("#member-list");
  if (!frame || !panel) return;
  const c = current,
    show = !!c && !c.dm && c.sees_members && membersOpen();
  frame.hidden = !show;
  if (!show) return;
  const rosterKey=`${generation}:${c.id}`;
  if(c.members_cursor==="" && !rosterLoading && rosterAuto!==rosterKey){rosterAuto=rosterKey;void loadMemberPage();}
  const members = c.members || [];
  const ban = (u: User) => {
    const may = memberReach(u);
    return (may.kick ? `<button type="button" class="icon-button member-act" data-kick-member="${u.id}" aria-label="Remove ${esc(u.display_name)} from this channel" title="Remove from this channel">${icon("logout")}</button>` : "") +
      (may.ban ? `<button type="button" class="icon-button member-act" data-ban-member="${u.id}" aria-label="Ban ${esc(u.display_name)} from this channel" title="Ban from this channel">${icon("block")}</button>` : "");
  };
  const html = `<div class="panel-head"><h2 class="grow">Members <span class="muted">${members.length}</span></h2><a class="icon-button" href="#/settings/channel/members/${c.id}" aria-label="Manage members" title="Roles, invitations and removal">${icon("settings")}</a><button type="button" class="icon-button" data-close-members aria-label="Hide members" title="Hide members">${icon("x")}</button></div>
    <div class="panel-body">${memberSections(members)
      .map(({ label, list, counted }) => {
        return list.length
          ? `<h3 class="side-label">${esc(label)}${counted ? ` · ${list.length}` : ""}</h3><ul class="plain member-rows">${list.map((u) => `<li>${avatar(u, "small")}${nameButton(u, u.actor_url, "member-name")}${ban(u)}${u.actor_url?.startsWith("xmpp:") ? `<span class="mode-tag" title="XMPP" aria-label="XMPP">${icon("xmpp")}</span>` : u.actor_url && !u.actor_url.startsWith(location.origin) ? `<span class="mode-tag" title="On another instance">${icon("globe")}</span>` : ""}</li>`).join("")}</ul>`
          : "";
      })
      .join("")}${c.members_cursor!=null?`<button type="button" data-more-members ${rosterLoading?"disabled":""}>${rosterLoading?"Loading…":"Load more members"}</button>`:""}</div>`;
  if (panel.dataset.html !== html) {
    const top = panel.querySelector(".panel-body")?.scrollTop ?? 0;
    panel.innerHTML = panel.dataset.html = html;
    const body = $(".panel-body", panel);
    body.scrollTop = top;
    body.addEventListener("scroll", moreMembers, { passive: true });
  }
  panel.querySelector("[data-more-members]")?.addEventListener("click",()=>{rosterFailed=false;void loadMemberPage();},{once:true});
  requestAnimationFrame(moreMembers);
}
// The next page of members comes as the reader nears the end of those loaded, or while they don't fill the panel.
function moreMembers() {
  const body = document.querySelector<HTMLElement>("#member-list .panel-body");
  if (!body || rosterLoading || rosterFailed || current?.members_cursor == null) return;
  if (body.scrollHeight - body.scrollTop - body.clientHeight < body.clientHeight) void loadMemberPage();
}

export function sortedTopics() {
  const last = new Map<string, number>();
  for (const m of messages) if (m.topic_id) last.set(m.topic_id, m.seq);
  return [...(current?.topics || [])].sort(
    (a, b) => (last.get(b.id) || 0) - (last.get(a.id) || 0),
  );
}
// The button that opens a conversation's notification choices, or a topic's or thread's
// notification and hiding choices. It shows what was chosen.
function prefButton(kind: PrefKind, target: string, name: string, cls = "") {
  const part = kind === "topic" || kind === "thread",
    choice = notifies(target, part ? current!.id : undefined),
    quiet = !choice,
    ico = isHidden(target) ? "eye-off" : quiet ? "bell-off" : part ? "more" : choice === "mentions" ? "at" : "bell",
    label = `${part ? "Notifications and hiding" : "Notifications"} for ${name}`;
  return `<button type="button" class="icon-button pref-button${cls ? ` ${cls}` : ""}" data-pref-menu="${esc(target)}" data-pref-kind="${kind}" aria-haspopup="menu" aria-label="${esc(label)}" title="${esc(label)}${isHidden(target) ? " (hidden)" : quiet ? " (off)" : choice === "mentions" ? " (mentions only)" : ""}">${icon(ico)}</button>`;
}
function openPrefMenu(button: HTMLElement) {
  prefMenu(
    button,
    button.dataset.prefKind as PrefKind,
    button.dataset.prefMenu!,
    current?.dm ? undefined : current?.id,
    () => {
      if (!current) return;
      lastPrefs = JSON.stringify(state.prefs);
      renderHeader();
      render();
      renderSidebar();
    },
  );
}
// The messages of threads the reader hid. A thread is hidden with its first message; replies
// whose thread began before this page say so themselves.
function hiddenThreads() {
  const all = everything(),
    byId = new Map(all.map((m) => [m.id, m]));
  return new Set(
    all.filter((m) => {
      let first = m;
      for (let up = byId.get(m.parent_id || ""); up; up = byId.get(up.parent_id || ""))
        first = up;
      return first.parent_id
        ? !!m.hidden_thread
        : isHidden(`thread:${first.id}`);
    }),
  );
}
function renderHeader() {
  const c = current!,
    topic = topicOf(narrow);
  updateFusionToolbar();
  if (c.dm) {
    $("#channel-heading").innerHTML =
      `<h1>${avatar(c.dm, "small")}<strong>${nameButton(c.dm, c.dm.peer)}</strong></h1><span class="handle">@${esc(c.dm.username)}</span>${c.dm.remote ? '<span class="pill new">Remote</span>' : ""}<span class="desc muted small">Direct messages</span>`;
    $("#channel-actions").innerHTML = prefButton("dm", c.id, c.name);
    return;
  }
  $("#channel-heading").innerHTML =
    `<h1>${channelIcon(c)}<strong>${esc(c.name)}</strong>${topic ? `${icon("chevron-right", "sep")}<span class="topic-name">${esc(topic.title)}</span>` : ""}</h1>${topic && isHidden(`topic:${topic.id}`) ? '<span class="pill warn">Hidden</span>' : ""}<span class="pill">${modeLabel(c.mode)}</span>${c.remote_actor ? '<span class="pill new">Remote</span>' : c.federation_enabled ? '<span class="pill new">Federated</span>' : ""}${c.bridge_room ? `<span class="pill new" title="Bridged with the XMPP room ${esc(c.bridge_room)}">Bridged</span>` : ""}${c.mirror ? `<span class="pill new">${c.mirror === "writable" ? "Fork" : "Mirror"}</span>` : ""}${c.description ? `<span class="desc muted small">${esc(c.description)}</span>` : ""}`;
  $("#channel-actions").innerHTML =
    `${!c.role ? "" : topic ? prefButton("topic", `topic:${topic.id}`, topic.title) : prefButton("channel", c.id, `#${c.name}`)}${c.sees_members ? `<button type="button" class="act" id="members" aria-pressed="${membersOpen()}" title="Show or hide the members of #${esc(c.name)}">${icon("people")}<span>${c.member_count} member${c.member_count === 1 ? "" : "s"}</span></button>` : ""}<button type="button" class="icon-button" id="channel-options" aria-haspopup="menu" aria-label="Channel options" title="Channel options">${icon("more")}</button>`;
}
function openChannelOptions(button: HTMLElement) {
  const c = current!;
  const owning = !c.remote_actor && (c.role === "owner" || me().admin);
  const inviting = c.visibility === "public" || channelCan(c, "allow_access");
  const panel = popup(button, `<div class="menu-section channel-menu-about"><strong>#${esc(c.name)}</strong>${c.description ? `<p class="muted small">${esc(c.description)}</p>` : ""}<p class="muted small">${roleLabel(c.role, c.channel_role)} · ${c.remote_actor ? "Hosted on another server" : c.federation_enabled ? "Shared with other servers" : "People on this instance"}</p></div>${c.role ? prefItems("channel", c.id) : ""}<div class="menu-section" role="menu">${inviting ? `<button type="button" class="menu-item" role="menuitem" data-invite-channel>${icon("people")}<span class="grow">Invite someone…</span></button>` : ""}${owning ? `<button type="button" class="menu-item" role="menuitem" data-rename-channel>${icon("pencil")}<span class="grow">Rename channel…</span></button>` : ""}<a class="menu-item" role="menuitem" href="#/settings/channel/overview/${c.id}">${icon("settings")}<span class="grow">Channel settings</span></a>${c.role && c.role !== "owner" ? `<button type="button" class="menu-item bad-text" role="menuitem" data-leave-channel>${icon("logout")}<span class="grow">Leave channel…</span></button>` : ""}</div>`);
  panel?.addEventListener("click", (e) => {
    pickPref(e, c.id, () => redrawChat(false, true));
    if ((e.target as Element).closest("[data-invite-channel]")) action(async () => {
      const address = await promptDialog(`Invite someone to #${c.name}`, "Person's address (@handle, user@server, actor URL or xmpp:user@server)", "", "Send invitation", {
        maxLength: 2048,
        description: channelCan(c, "allow_access") ? "Sends a direct message and grants access to join." : "Sends a direct message. The channel's access rules still apply.",
      });
      if (!address) return;
      await api(`/channels/${c.id}/invitations`, "POST", { address });
      toast("Invitation sent as a direct message.");
    });
    if ((e.target as Element).closest("[data-rename-channel]")) action(async () => {
      const name = await promptDialog("Rename channel", "Channel name", c.name, "Rename channel");
      if (!name || name === c.name) return;
      await api(`/channels/${c.id}`, "PATCH", { name });
      state.channels = await api<Channel[]>("/channels");
      await refreshCurrent();
    });
    else if ((e.target as Element).closest("[data-leave-channel]")) action(async () => {
      if (!(await confirmDialog(`Leave #${c.name}?`, "You'll stop seeing it in your channels.", "Leave channel"))) return;
      await api(`/channels/${c.id}/leave`, "POST", {});
      state.channels = await api<Channel[]>("/channels");
      if (current?.id === c.id) resetChat();
      go("#/channels");
    });
  });
}

// ---- messages ----
const excerpt = (body: string) =>
  body.length > 90 ? `${body.slice(0, 90)}…` : body;
const edited = (m: Message) =>
  m.queued
    ? m.failed
      ? `<span class="edited queued-note bad-text" role="status" title="${esc(m.failed)}">Not delivered</span>`
      : '<span class="edited queued-note" role="status">Sending…</span>'
    : m.edited_at && !m.deleted_at
      ? `<span class="edited" title="${esc(full(m.edited_at))}">(edited)</span>`
      : "";
// Shaded until the other instance has it; nothing can be done to it before then.
const queuedClass = (m: Message) =>
  m.queued ? ` queued${m.failed ? " failed" : ""}` : "";
// Emoji reactions under a message: the ones given, and a button to add yours.
const reactable = (m: Message) =>
  !!current?.reactions && !current.dm && !m.deleted_at && !m.queued;
// The button that opens the emoji picker for a reaction, in a message's action panel.
const reactButton = (m: Message, cls: string) =>
  reactable(m) && canPost()
    ? `<button type="button" class="${cls}" data-react-add="${m.id}" aria-label="Add reaction" aria-haspopup="dialog" title="Add reaction">${icon("smile")}<span>React</span></button>`
    : "";
// A reaction's emoji: a custom one as the picture it was given with, wherever that came from.
const reactionEmoji = (r: Reaction) =>
  emojiHtml(`:${r.emoji}:`, r.url ? [{ name: r.emoji, id: "", url: r.url }] : state.emojis);
// For a moderator, what to do about the reactions a message has.
const moderateButton = (m: Message, cls: string) =>
  reactable(m) && m.reactions?.length && canModerate(current!)
    ? `<button type="button" class="${cls}" data-react-moderate="${m.id}" aria-label="Moderate reactions" aria-haspopup="dialog" title="Moderate reactions">${icon("shield")}<span>Reactions</span></button>`
    : "";
// Take a reaction off a message for everyone, or keep its emoji out of the channel altogether.
function moderateReactions(id: string) {
  const dialog = document.createElement("dialog");
  dialog.className = "card dialog";
  const draw = () => {
    const rows = (messages.find((m) => m.id === id)?.reactions || [])
      .map(
        (r) =>
          `<li class="row"><span class="grow">${reactionEmoji(r)} <code>:${esc(r.emoji)}:</code> · ${r.count}</span><button type="button" class="small secondary" data-clear="${esc(r.emoji)}">Remove</button><button type="button" class="small secondary bad-text" data-ban="${esc(r.emoji)}">Ban</button></li>`,
      )
      .join("");
    dialog.innerHTML = `<h2>Reactions to this message</h2>${rows ? `<ul class="plain stack">${rows}</ul><p class="muted small">Remove takes a reaction off this message for everyone. Ban also takes the emoji out of this channel: it is left out of every message here and cannot be written or given again. The channel's settings list what is banned.</p>` : '<p class="muted">No reactions are left.</p>'}<div class="row end"><button type="button" class="secondary" data-cancel>Close</button></div>`;
  };
  dialog.addEventListener("close", () => dialog.remove());
  dialog.addEventListener("click", (e) => {
    const hit = (e.target as Element).closest<HTMLElement>("[data-cancel],[data-clear],[data-ban]");
    if (!hit) return;
    if (hit.hasAttribute("data-cancel")) return dialog.close();
    action(async () => {
      const token = generation,
        name = hit.dataset.clear || hit.dataset.ban!;
      if (hit.dataset.clear) {
        const left = await api<Reaction[]>(`/messages/${id}/reactions/${encodeURIComponent(name)}`, "DELETE");
        const m = messages.find((m) => m.id === id);
        if (m) m.reactions = left;
      } else {
        await api(`/channels/${current!.id}/reaction-bans`, "PUT", { emoji: name, banned: true });
        for (const m of messages) m.reactions = m.reactions?.filter((r) => r.emoji !== name);
        state.channels = await api<Channel[]>("/channels");
        toast(`:${name}: is banned from this channel.`);
        await refreshCurrent();
      }
      if (token !== generation) return dialog.close();
      draw();
      render();
    });
  });
  draw();
  document.body.append(dialog);
  dialog.showModal();
}
function reactionsHtml(m: Message) {
  if (!reactable(m)) return "";
  const can = canPost(),
    chips = (m.reactions || [])
      .map(
        (r) =>
          `<button type="button" class="reaction${r.mine ? " mine" : ""}" data-react="${m.id}" data-emoji="${esc(r.emoji)}" aria-pressed="${r.mine}" aria-label="${esc(r.emoji)}, ${r.count}"${can ? "" : " disabled"}>${reactionEmoji(r)}<span>${r.count}</span></button>`,
      )
      .join("");
  return chips ? `<div class="reactions">${chips}</div>` : "";
}
function react(id: string, emoji: string, on: boolean) {
  action(async () => {
    const token = generation;
    const reactions = await api<Reaction[]>(`/messages/${id}/reactions`, "PUT", { emoji, on });
    if (token !== generation) return;
    const m = messages.find((m) => m.id === id);
    if (m && current?.remote_actor) {
      const list = (m.reactions || []).map((r) => ({ ...r })),
        had = list.find((r) => r.emoji === emoji);
      if (had && had.mine !== on) {
        had.count += on ? 1 : -1;
        had.mine = on;
      } else if (!had && on) {
        // Shown at once with this instance's picture; the channel's home sends back the one it keeps.
        const url = state.emojis.find((e) => e.name === emoji)?.url;
        list.push({ emoji, count: 1, mine: true, ...(url ? { url } : {}) });
      }
      m.reactions = list.filter((r) => r.count > 0);
    } else if (m) m.reactions = reactions;
    render();
  });
}
function bodyHtml(m: Message, cls = "") {
  if (editing === m.id && !m.deleted_at)
    return `<form class="stack inline-form picker-host" data-edit-form="${m.id}">${threaded() && !m.parent_id ? `<input name="title" maxlength="160" value="${esc(m.title || "")}" placeholder="Thread title${m.title && !current!.optional_titles ? "" : " (optional)"}" aria-label="Thread title" ${m.title && !current!.optional_titles ? "required" : ""}>` : ""}<textarea name="body" rows="3" maxlength="8000" aria-label="Edited message" required>${esc(m.body)}</textarea><p class="form-error" role="alert"></p><div class="row"><button class="small">Save changes</button><button type="button" class="small secondary" data-cancel-edit>Cancel</button><button type="button" class="icon-button" data-emoji-for aria-label="Choose emoji" title="Emoji">${icon("smile")}</button>${attachButton("data-attach-for")}</div></form>`;
  const big = !m.deleted_at && emojiOnly(m.body, m.emojis || []);
  return `<div class="message-body${cls ? ` ${cls}` : ""}${m.deleted_at ? " faded" : " markdown"}${big ? " emoji-only" : ""}">${m.deleted_at ? "This message was removed." : richHtml(m.body, m.emojis || [], m.author_actor_url)}</div>${reactionsHtml(m)}`;
}
// Direct messages stay as they were sent.
const mine = (m: Message) =>
  !m.deleted_at && !current!.dm && !!current!.role && m.author_id === me().id;
const removable = (m: Message) =>
  !m.deleted_at &&
  !current!.dm &&
  (m.author_id === me().id || channelCan(current!, "delete_messages"));
// A reply links back to what it answers. Threads have their own; direct messages have none.
const repliable = (m: Message) =>
  canPost() && !m.deleted_at && !current!.dm && !threaded();
// Occupants of other XMPP servers are marked; their handle is their full address.
const author = (m: Message) =>
  nameButton(m, m.history_placeholder ? undefined : m.author_actor_url) +
  (m.author_actor_url?.startsWith("xmpp:") ? ` <span class="mode-tag" title="XMPP" aria-label="XMPP">${icon("xmpp")}</span>` : "");

function editMessage(id: string) {
  editing = id;
  render();
  const area = document.querySelector<HTMLTextAreaElement>(`[data-edit-form="${id}"] textarea`);
  area?.focus();
  area?.setSelectionRange(area.value.length, area.value.length);
}
function removeMessage(id: string) {
  action(async () => {
    if (!(await confirmDialog("Remove this message?", "It will be replaced with a removed-message marker. Replies stay in the conversation.", "Remove message"))) return;
    await api(`/messages/${id}`, "DELETE");
    await refreshCurrent();
  });
}
function messageMenu(button: HTMLElement, id = button.dataset.messageMenu, at?: { x: number; y: number }) {
  const m = messages.find((m) => m.id === id);
  if (!m || m.queued || m.deleted_at) return;
  const token = generation;
  const item = (key: string, label: string, ico: string) => `<button type="button" class="menu-item" role="menuitem" data-message-action="${key}">${icon(ico)}<span class="grow">${label}</span></button>`;
  // Whoever wrote it can be removed or banned from here, by someone who may.
  const author = hooks.memberItems({ id: m.author_id });
  const panel = popup(button, `<div class="menu-section" role="menu">${item("copy", "Copy text", "quote")}${mine(m) ? item("edit", "Edit message", "pencil") : ""}${removable(m) ? item("remove", "Remove message", "trash") : ""}</div>${author ? `<div class="menu-section" role="menu"><div class="menu-label">${esc(m.display_name)}</div>${author}</div>` : ""}`, at);
  panel?.addEventListener("click", (e) => {
    if (generation !== token) return;
    const member = (e.target as Element).closest<HTMLElement>("[data-member-act]")?.dataset.memberAct;
    if (member) return hooks.memberAct({ id: m.author_id }, member);
    const name = (e.target as Element).closest<HTMLElement>("[data-message-action]")?.dataset.messageAction;
    if (name === "edit") editMessage(m.id);
    else if (name === "remove") removeMessage(m.id);
    else if (name === "copy") action(async () => {
      await navigator.clipboard.writeText(m.body);
      toast("Message copied.");
    });
  });
}
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
  const tools = m.queued ? "" : [
    reactButton(m, "act react-button"),
    moderateButton(m, "act"),
    repliable(m)
      ? `<button type="button" class="act reply-button" data-reply="${m.id}" aria-label="Reply to ${esc(m.display_name)}" title="Reply">${icon("reply")}<span>Reply</span></button>`
      : "",
    canPost() && !m.deleted_at
      ? `<button type="button" class="act quote-button" data-quote="${m.id}" aria-label="Quote ${esc(m.display_name)}" title="Quote">${icon("quote")}<span>Quote</span></button>`
      : "",
    !m.deleted_at ? `<button type="button" class="icon-button" data-message-menu="${m.id}" aria-label="More message actions" aria-haspopup="menu" title="More">${icon("more")}</button>` : "",
  ].join("");
  if (appStyle() === "fusion-compact")
    return `<article class="message compact-message picker-host${m.deleted_at ? " deleted" : ""}${queuedClass(m)}" id="m-${m.id}"><span class="compact-time">${time}</span><div class="compact-author">${author(m)}${handleTag(m.username)}</div><div class="message-content">${context}${bodyHtml(m)}${edited(m)}</div>${tools ? `<div class="message-actions">${tools}</div>` : ""}</article>`;
  return `<article class="message picker-host${cont ? " cont" : ""}${m.deleted_at ? " deleted" : ""}${queuedClass(m)}" id="m-${m.id}"><div class="msg-gutter">${cont ? time : avatar(m)}</div>
    <div class="message-content">${cont ? "" : `<div class="message-meta">${author(m)}${handleTag(m.username)}${time}${edited(m)}</div>`}${context}${bodyHtml(m)}${cont ? edited(m) : ""}</div>${tools ? `<div class="message-actions">${tools}</div>` : ""}</article>`;
}
// Consecutive messages from one person within ten minutes share a header, as in Zulip.
function chatKids(list: Message[]): Node[] {
  return list.map((m, i) => {
    const prev = list[i - 1];
    const cont =
      !isFusion() && !!prev &&
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
        ? `<header class="recipient-bar"><a class="rb-channel" href="#/c/${c.id}">${channelIcon(c)}${esc(c.name)}</a>${icon("chevron-right", "sep")}<a class="rb-topic" href="#/c/${c.id}/t/${first.topic_id}">${esc(topicOf(first.topic_id)?.title || "(no topic)")}</a><span class="rb-date">${day}</span>${c.role && first.topic_id ? prefButton("topic", `topic:${first.topic_id}`, topicOf(first.topic_id)?.title || "this topic") : ""}</header>`
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
  if (m.queued) return "";
  const parts = [
    canPost() && !m.deleted_at
      ? `<details class="reply-box"><summary aria-label="Reply to ${esc(m.display_name)}">${icon("reply")} Reply</summary><form class="stack inline-form picker-host" data-reply-form="${m.id}"><textarea name="body" rows="3" maxlength="8000" required aria-label="Reply" placeholder="Reply to ${esc(m.display_name)}"></textarea><p class="form-error" role="alert"></p><div class="row"><button class="small">Reply</button><button type="button" class="icon-button" data-emoji-for aria-label="Choose emoji" title="Emoji">${icon("smile")}</button>${attachButton("data-attach-for")}<span class="muted">Ctrl + Enter to send</span></div></form></details>`
      : "",
    reactButton(m, "link react-button"),
    canPost() && !m.deleted_at
      ? `<button type="button" class="link quote-button" data-quote="${m.id}" aria-label="Quote ${esc(m.display_name)}">${icon("quote")} Quote</button>`
      : "",
    moderateButton(m, "link"),
    mine(m)
      ? `<button type="button" class="link edit-button" data-edit="${m.id}" aria-label="Edit message">Edit</button>`
      : "",
    removable(m)
      ? `<button type="button" class="link bad-text delete-button" data-delete="${m.id}" aria-label="Remove message">Remove</button>`
      : "",
  ].join("");
  return parts ? `<div class="obj-actions small picker-host">${parts}</div>` : "";
}
const byline = (m: Message) => isFusion()
  ? `${author(m)}<time class="thread-clock" datetime="${esc(m.created_at)}" title="${esc(full(m.created_at))}">${esc(`${dayLabel(m.created_at)} ${clock(m.created_at)}`)}</time>${edited(m)}`
  : `${author(m)} ${handleTag(m.username)} ·${when(m.created_at)}${edited(m) ? ` · ${edited(m)}` : ""}`;
function threadNodes(list: Message[]): Node[] {
  const ids = new Set(list.map((m) => m.id)),
    children = new Map<string, Message[]>();
  for (const m of list)
    if (m.parent_id && ids.has(m.parent_id))
      children.set(m.parent_id, [...(children.get(m.parent_id) || []), m]);
  const count = (m: Message): number =>
    (children.get(m.id) || []).reduce((n, child) => n + 1 + count(child), 0);
  const replies = (n: number) => `${n} repl${n === 1 ? "y" : "ies"}`;
  // In Fusion a message is one row: its summary, which selects it; its chevron or the line beside its replies folds them, and what a folded one says is hidden opens it.
  const fusionRow = (m: Message, extra = "") =>
    `<span class="thread-avatar">${avatar(m)}</span><div class="row-main"><div class="byline">${byline(m)}${extra}</div>${editing === m.id ? "" : `<div class="row-text">${bodyHtml(m, "md")}</div>`}</div>`;
  const comment = (m: Message, depth: number): Node => {
    const n = count(m);
    if (isFusion())
      return {
        key: m.id,
        html: `<details open class="comment message${n ? " has-replies" : ""}${queuedClass(m)}" id="m-${m.id}" data-depth="${depth}"><summary class="thread-row"><span class="fold" aria-hidden="true">${icon("chevron-down")}</span>${fusionRow(m, `<span class="collapsed-note">${replies(n)} hidden</span>`)}</summary>
          <div class="content">${editing === m.id ? bodyHtml(m, "md") : ""}${threadActions(m)}<div class="replies" data-kids></div></div></details>`,
        kids: (children.get(m.id) || []).map((child) => comment(child, depth + 1)),
      };
    return {
      key: m.id,
      html: `<details open class="comment message d${depth % 8}${queuedClass(m)}" id="m-${m.id}" data-depth="${depth}"><summary class="meta small message-meta"><span class="fold" aria-hidden="true">${icon("chevron-down")}</span>${byline(m)}<span class="collapsed-note">${n ? `${replies(n)} hidden` : "collapsed"}</span></summary>
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
      const hiddenPill = isHidden(`thread:${m.id}`) ? ' <span class="pill warn">Hidden</span>' : "";
      if (isFusion())
        return {
          key: `t-${m.id}`,
          html: `<details open class="thread fusion-thread${hiddenPill ? " hidden-thread" : ""}"><summary class="thread-heading">${icon("chevron-down", "chev")}${avatar(m, "small")}<strong class="grow">${emojiHtml(m.title || "Untitled thread", m.emojis || [])}</strong><span class="thread-meta"><span class="thread-starter">${esc(m.display_name)} · </span>${n ? replies(n) : "no replies"} · ${esc(dayLabel(m.created_at))}</span></summary><div class="thread-body"><article class="post message${queuedClass(m)}" id="m-${m.id}"><div class="thread-row">${fusionRow(m, hiddenPill)}${current!.role && !m.queued ? prefButton("thread", `thread:${m.id}`, m.title || "this thread") : ""}</div>${editing === m.id ? bodyHtml(m, "md") : ""}${threadActions(m)}</article><div class="comments" data-kids></div></div></details>`,
          kids: (children.get(m.id) || []).map((child) => comment(child, 0)),
        };
      const post = `<article class="post message${queuedClass(m)}" id="m-${m.id}">${m.title && editing !== m.id ? `<h2 class="thread-title">${emojiHtml(m.title, m.emojis || [])}</h2>` : ""}<div class="meta small message-meta post-meta"><span class="grow">${byline(m)}${isHidden(`thread:${m.id}`) ? ' · <span class="pill warn">Hidden</span>' : ""}</span>${current!.role && !m.queued ? prefButton("thread", `thread:${m.id}`, m.title || "this thread") : ""}</div>${bodyHtml(m, "md")}${threadActions(m)}</article>${n ? `<details open class="thread-replies" data-key="r-${m.id}"><summary title="Show or hide every reply in this thread">${icon("chevron-down", "chev")}<span>${replies(n)}</span></summary><div class="comments" data-kids></div></details>` : '<div class="comments" data-kids></div>'}`;
      return {
        key: `t-${m.id}`,
        html: `<section class="thread card${isHidden(`thread:${m.id}`) ? " hidden-thread" : ""}">${post}</section>`,
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
  // Native toggle events are queued. Read the current state before replacing a styled thread.
  for (const d of $$<HTMLDetailsElement>(folds, list)) {
    if (d.open) collapsed.delete(d.dataset.key!);
    else collapsed.add(d.dataset.key!);
  }
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80,
    oldHeight = list.scrollHeight,
    oldTop = list.scrollTop;
  // The first message in view stays put while pages come and go around it.
  const box = list.getBoundingClientRect(),
    anchor = opts.anchor ? $$(".message[id]", list).find((el) => el.getBoundingClientRect().bottom > box.top)?.id : undefined,
    anchorTop = anchor ? document.getElementById(anchor)!.getBoundingClientRect().top : 0;
  // A hidden topic is read by opening it; hidden threads by asking for them.
  const quiet = c.mode === "threaded" ? hiddenThreads() : new Set<Message>(),
    away = new Set([...quiet].map((m) => m.id)),
    hiddenCount = [...quiet].filter(
      (m) => !m.parent_id || !away.has(m.parent_id),
    ).length;
  if (!hiddenCount) showHidden = false;
  const all = everything();
  let shown =
    c.mode === "topical"
      ? all.filter((m) =>
          narrow ? m.topic_id === narrow : !isHidden(`topic:${m.topic_id}`),
        )
      : quiet.size && !showHidden
        ? all.filter((m) => !quiet.has(m))
        : all;
  if (messageSearch && isFusion()) {
    const match = (m: Message) => `${m.body} ${m.title || ""} ${m.display_name}`.toLowerCase().includes(messageSearch);
    if (threaded()) {
      const roots = new Set<string>();
      const root = (m: Message) => { let top = m; for (let parent = shown.find(p => p.id === top.parent_id); parent; parent = shown.find(p => p.id === top.parent_id)) top = parent; return top.id; };
      for (const m of shown) if (match(m)) roots.add(root(m));
      shown = shown.filter(m => roots.has(root(m)));
    } else shown = shown.filter(match);
  }
  const top = `${
    olderCursor
      ? '<button type="button" id="older-messages" class="secondary small older-button">Load earlier messages</button>'
      : c.dm
        ? `<div class="channel-intro"><h2>${avatar(c.dm)}${esc(c.name)}</h2><p class="muted">The start of your direct messages with ${esc(c.name)}. Only the two of you can read them.</p><p class="muted small"><code>@${esc(c.dm.username)}</code>${c.dm.remote ? " · on another instance" : ""}</p></div>`
        : `<div class="channel-intro"><h2>${channelIcon(c)}${esc(c.name)}</h2><p class="muted">${esc(c.description || "The start of this channel.")}</p><p class="muted small">${c.visibility === "members" ? "Members only" : "Public"} · ${modeLabel(c.mode)} · <code>#${esc(c.name)}@${esc(c.remote_actor ? new URL(c.remote_actor).host : state.session.instance)}</code></p></div>`
  }${c.mode === "threaded" && (hiddenCount || shown.some((m) => m.parent_id)) ? `<div class="toolbar">${shown.some((m) => m.parent_id) ? '<button type="button" class="small secondary" data-fold="open">Expand all</button><button type="button" class="small secondary" data-fold="closed">Collapse all</button>' : ""}${hiddenCount ? `<button type="button" class="small secondary" data-show-hidden aria-pressed="${showHidden}">${icon(showHidden ? "eye-off" : "eye")} ${showHidden ? "Put away" : "Show"} ${hiddenCount} hidden thread${hiddenCount === 1 ? "" : "s"}</button>` : ""}</div>` : ""}`;
  if ($("#feed-top").innerHTML !== top) $("#feed-top").innerHTML = top;
  popped = [];
  sync(
    $("#rows"),
    c.mode === "threaded" ? threadNodes(shown) : chatNodes(shown),
    !!opts.animate,
  );
  $("#rows").className = `rows mode-${c.mode}`;
  if (isFusion()) for (const row of $$(".message[id]", $("#rows"))) {
    row.tabIndex = 0;
    row.classList.toggle("selected-message", row.id === `m-${selectedMessage}`);
  }
  updateFusionToolbar();
  $("#feed-empty").innerHTML = shown.length
    ? ""
    : `<p class="card empty muted">${messageSearch ? "No messages match." : c.mode === "threaded" ? (hiddenCount ? "Every thread here is hidden." : "No threads yet.") : narrow ? "No messages in this topic yet." : messages.length ? "Every topic here is hidden. Open one from the sidebar to read it." : "No messages yet."}</p>`;
  for (const d of $$<HTMLDetailsElement>(folds, list))
    d.open = !collapsed.has(d.dataset.key!);
  refreshTimes(list);
  const arrived = popped.filter((key) =>
    messages.some((m) => m.id === key && m.author_id !== me().id),
  );
  if (opts.bottom) list.scrollTop = list.scrollHeight;
  else if (opts.anchor) {
    const el = anchor && document.getElementById(anchor);
    if (el) list.scrollTop += el.getBoundingClientRect().top - anchorTop;
    else list.scrollTop = oldTop + Math.max(0, list.scrollHeight - oldHeight);
  }
  else if (!threaded() && atBottom)
    list.scrollTo({
      top: list.scrollHeight,
      behavior: opts.animate ? "smooth" : "auto",
    });
  else unseen.push(...arrived);
  updatePill();
}
// What folds in a threaded channel: one reply with those under it, or all of a thread's replies.
const folds = "details.comment, details.thread-replies, details.fusion-thread";
function inView(el: Element) {
  const box = $("#message-list").getBoundingClientRect(),
    r = el.getBoundingClientRect();
  return r.top < box.bottom && r.bottom > box.top;
}
function updatePill() {
  const list = $("#message-list"),
    pill = $<HTMLButtonElement>("#new-pill");
  if (!live()) {
    unseen = [];
    pill.hidden = false;
    pill.innerHTML = `${icon("arrow-down")} Jump to latest`;
    return;
  }
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
    if (!paging) atEdge(true);
    if (ticking || !unseen.length) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      updatePill();
    });
  });
  $("#new-pill").addEventListener("click", () => {
    if (!live()) return action(jumpToLatest);
    if (threaded() && unseen.length) reveal(unseen.shift()!);
    else list.scrollTo({ top: list.scrollHeight, behavior: "smooth" });
    updatePill();
  });
  // Folding is native <details>; remember it so a refresh doesn't undo it.
  list.addEventListener(
    "toggle",
    (e) => {
      const d = e.target as HTMLDetailsElement;
      if (!d.isConnected) return;
      if (d.matches("details.reply-box") && d.open) $("textarea", d).focus();
      if (!d.matches(folds)) return;
      if (d.open) collapsed.delete(d.dataset.key!);
      else collapsed.add(d.dataset.key!);
    },
    true,
  );
  // A right click on a message or a post opens its menu, in every style. Outside Fusion, where text is
  // selected the browser keeps its own menu, to copy it by.
  list.addEventListener("contextmenu", (e) => {
    if ((e.target as Element).closest("input, textarea, a") || (!isFusion() && !getSelection()?.isCollapsed)) return;
    const row = (e.target as Element).closest<HTMLElement>(".message[id]");
    if (!row) return;
    const m = messages.find((m) => m.id === row.id.slice(2));
    if (!m || m.queued || m.deleted_at) return;
    e.preventDefault();
    if (isFusion()) selectFusionMessage(m.id);
    messageMenu(row, m.id, { x: e.clientX, y: e.clientY });
  });
  list.addEventListener("keydown", (e) => {
    if (isFusion() && (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10"))) {
      const row = (e.target as Element).closest<HTMLElement>(".message[id]");
      if (row) { e.preventDefault(); selectFusionMessage(row.id.slice(2)); messageMenu(row, row.id.slice(2)); }
    }
    if (isFusion() && ["ArrowUp", "ArrowDown"].includes(e.key) && !(e.target as Element).closest("input, textarea, button, a")) {
      const rows = $$(".message[id]", list).filter(row => row.getBoundingClientRect().height > 0);
      const i = rows.findIndex(row => row.id === `m-${selectedMessage}`);
      const row = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
      if (row) { e.preventDefault(); selectFusionMessage(row.id.slice(2)); row.focus(); }
    }
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
          ...(data.has("title") ? { title: data.get("title") } : {}),
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
        collapsed.delete(form.dataset.replyForm!);
        if (message.queued) pending = [...pending, message];
        else merge(message);
        for (let up: Message | undefined = message; up; up = messages.find((m) => m.id === up!.parent_id))
          if (!up.parent_id) collapsed.delete(`r-${up.id}`);
        render();
        document
          .getElementById(`m-${message.id}`)
          ?.scrollIntoView({ block: "nearest" });
      });
  });
  // In Fusion the line down the side of a set of replies is a handle: with the pointer on it, or a
  // little to either side, it thickens, and a click there folds what it runs beside.
  let scope: HTMLElement | null = null;
  const aim = (e: MouseEvent | null) => {
    let found: HTMLElement | null = null;
    if (e && isFusion())
      for (let el = e.target as Element | null; el && el !== list && !found; el = el.parentElement) {
        // The line may be this element's own, or that of the replies under the message the pointer is in.
        const box = el.matches(".replies, .comments") ? (el as HTMLElement)
          : el.matches("details.comment") ? el.querySelector<HTMLElement>(":scope > .content > .replies")
          : el.matches(".thread-body") ? el.querySelector<HTMLElement>(":scope > .comments") : null;
        const at = box?.getBoundingClientRect();
        if (at?.height && parseFloat(getComputedStyle(box!).borderLeftWidth) && Math.abs(e.clientX - at.left) <= 6 && e.clientY >= at.top && e.clientY <= at.bottom) found = box;
      }
    if (found === scope) return;
    scope?.classList.remove("scope-hot");
    (scope = found)?.classList.add("scope-hot");
    list.classList.toggle("scope-aim", !!found);
  };
  list.addEventListener("mousemove", aim);
  list.addEventListener("mouseleave", () => aim(null));
  list.addEventListener("click", (e) => {
    const at = e.target as Element;
    aim(e);
    if (scope) {
      // A reply's line folds that reply; the line under a thread's first post folds the thread.
      const fold = scope.closest<HTMLDetailsElement>("details.comment, details.fusion-thread");
      e.preventDefault();
      aim(null);
      if (fold) {
        fold.open = false;
        if (!inView($("summary", fold))) fold.scrollIntoView({ block: "nearest" });
      }
      return;
    }
    if (isFusion()) {
      const row = at.closest<HTMLElement>(".message[id]");
      if (row) selectFusionMessage(row.id.slice(2));
      if (at.closest("summary.thread-row") && !at.closest(".fold, .collapsed-note, a, button, input, textarea")) e.preventDefault();
    }
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
      for (const d of $$<HTMLDetailsElement>(open ? folds : "details.thread-replies, details.fusion-thread", list))
        d.open = open;
    } else if ((hit = on("[data-pref-menu]"))) openPrefMenu(hit);
    else if ((hit = on("[data-message-menu]"))) messageMenu(hit);
    else if (on("[data-show-hidden]")) {
      showHidden = !showHidden;
      render();
    } else if ((hit = on("[data-jump]"))) reveal(hit.dataset.jump!);
    else if ((hit = on("[data-emoji-for]")))
      togglePicker(hit, $<HTMLTextAreaElement>("textarea", hit.closest("form")!));
    else if ((hit = on("[data-attach-for]")))
      pickFiles($<HTMLTextAreaElement>("textarea", hit.closest("form")!));
    else if ((hit = on("[data-reply]"))) {
      reply = messages.find((m) => m.id === hit!.dataset.reply) || null;
      renderComposer();
      $("#message-body").focus();
    } else if ((hit = on<HTMLImageElement>(".message-body img.custom-emoji"))) {
      // An emoji that is someone else's (theirs alone, or another server's) can be kept.
      // By touch the tap shows its card first, which is where it is kept from.
      const id = !touch() && adoptable(hit);
      if (id)
        adoptEmojiDialog({ id, name: (hit.getAttribute("alt") || "emoji").replaceAll(":", "") });
    } else if ((hit = on("[data-react]"))) {
      react(hit.dataset.react!, hit.dataset.emoji!, hit.getAttribute("aria-pressed") !== "true");
    } else if ((hit = on("[data-react-moderate]"))) {
      moderateReactions(hit.dataset.reactModerate!);
    } else if ((hit = on("[data-react-add]"))) {
      const id = hit.dataset.reactAdd!;
      togglePicker(hit, (name) => {
        const had = messages.find((m) => m.id === id)?.reactions?.find((r) => r.emoji === name)?.mine;
        if (!had) react(id, name, true);
      });
    } else if ((hit = on("[data-quote]"))) {
      // An XMPP room's rows sit in this feed too, and answer for themselves (xmpp-rooms.ts).
      const quoted = messages.find((m) => m.id === hit!.dataset.quote),
        topic = document.querySelector<HTMLInputElement>("#compose-topic");
      if (!quoted) return;
      if (threaded()) {
        const box = document.getElementById(`m-${quoted.id}`)?.querySelector<HTMLDetailsElement>(":scope > .obj-actions > details.reply-box");
        if (!box) return;
        box.open = true;
        quoteInto($<HTMLTextAreaElement>("textarea", box), quoted.body);
        return;
      }
      // The answer belongs with what it quotes, unless it is already a reply to something else.
      if (topic && !reply && quoted.topic_id)
        topic.value = topicOf(quoted.topic_id)?.title || topic.value;
      if (!reply && repliable(quoted)) {
        const old = $<HTMLTextAreaElement>("#message-body"),
          [from, to] = [old.selectionStart, old.selectionEnd];
        reply = quoted;
        renderComposer();
        $<HTMLTextAreaElement>("#message-body").setSelectionRange(from, to);
      }
      quoteInto($<HTMLTextAreaElement>("#message-body"), quoted.body);
    } else if ((hit = on("[data-edit]"))) {
      editMessage(hit.dataset.edit!);
    } else if ((hit = on("[data-cancel-edit]"))) {
      editing = null;
      hit.closest("form")!.remove();
      render();
    } else if ((hit = on("[data-delete]"))) {
      removeMessage(hit.dataset.delete!);
    } else if (on("#older-messages"))
      action(loadOlder);
    else if ((hit = on(".group-body > article")) && !on("a, button, form, .spoiler") && !(touch() && on(".emoji, .custom-emoji"))) {
      // Touch screens have no hover: a tap shows a message's buttons, under it.
      const shown = hit.classList.contains("show-actions");
      for (const el of $$(".show-actions", list))
        el.classList.remove("show-actions");
      hit.classList.toggle("show-actions", !shown);
      if (!shown && touch()) hit.querySelector(".message-actions")?.scrollIntoView({ block: "nearest" });
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
        if (!(await shareDialog(`Join #${c.name}?`, channelShares(c), "Join channel")))
          return;
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
  // The title of a thread being started outlives a look at replying to another.
  const titleField = document.querySelector<HTMLInputElement>("#thread-title");
  if (!keepDraft) threadTitleDraft = "";
  else if (titleField) threadTitleDraft = titleField.value;
  const draft = value("#message-body"),
    hadFocus = document.activeElement?.id === "message-body";
  let topic = value("#compose-topic");
  if (reply?.topic_id) topic = topicOf(reply.topic_id)?.title || topic;
  else if (narrow && !keepDraft) topic = topicOf(narrow)?.title || "";
  if (c.mode === "topical" && !topic)
    topic =
      topicOf(
        narrow ||
          [...messages].reverse().find((m) => !isHidden(`topic:${m.topic_id}`))
            ?.topic_id ||
          null,
      )?.title || "";
  const place = () => isFusion()
    ? reply ? "Write a reply" : c.mode === "threaded" ? "Start the thread" : "Write a message"
    : reply ? `Reply to ${reply.display_name}…` : c.mode === "threaded"
      ? "Start the thread…"
      : `Message ${c.dm ? "" : "#"}${c.name}…`;
  let thread = reply;
  while (thread?.parent_id) thread = messages.find((m) => m.id === thread!.parent_id) || null;
  const threadInput = () => `<input id="thread-title" class="thread-input" maxlength="160" placeholder="New thread title${c.optional_titles ? " (optional)" : ""}" aria-label="Thread title" ${c.optional_titles ? "" : "required"} value="${esc(threadTitleDraft)}">`;
  area.innerHTML = `<div class="composer-wrap picker-host"><form id="composer" class="composer">
    <span class="fusion-compose-label">To <strong>${esc(c.name)}</strong></span>
    ${c.mode === "topical" ? `<div class="compose-to">${channelIcon(c)}<span class="compose-channel">${esc(c.name)}</span>${icon("chevron-right", "sep")}<input id="compose-topic" list="topic-options" maxlength="100" placeholder="Topic" aria-label="Topic" autocomplete="off" required value="${esc(topic)}"><datalist id="topic-options"></datalist></div>` : ""}
    ${c.mode === "threaded" && !reply ? threadInput() : ""}
    ${reply ? `<div class="reply-banner small">${icon("reply")}<span>Replying to <strong>${esc(reply.display_name)}</strong>${thread?.title ? `<span class="reply-thread"> in <strong>${emojiHtml(thread.title, thread.emojis || [])}</strong></span>` : ""}</span><button type="button" id="cancel-reply" class="icon-button" aria-label="Cancel reply">${icon("x")}</button></div>` : ""}
    <textarea id="message-body" maxlength="8000" rows="1" placeholder="${esc(place())}" aria-label="Message" required>${esc(draft)}</textarea>
    <div class="composer-bar"><button type="button" id="choose-emoji" class="icon-button" aria-label="Choose emoji" title="Emoji" aria-expanded="false">${icon("smile")}</button>${attachButton('id="attach-file"')}<span class="muted small composer-hint-keys" title="Shift + Enter for a new line"><kbd>Enter</kbd> to send</span><button id="send-message" type="submit" aria-label="Send message">${icon("send")}<span>${c.mode === "threaded" && !reply ? "Post thread" : "Send"}</span></button></div></form></div>`;
  const body = $<HTMLTextAreaElement>("#message-body");
  const grow = () => {
    body.style.height = "auto";
    body.style.height = `${Math.min(body.scrollHeight + 2, 240)}px`;
  };
  body.addEventListener("input", grow);
  grow();
  // Keep the keyboard attached to the same input throughout a send, including replies.
  const sent = () => {
    closePicker();
    body.value = "";
    const titleInput = document.querySelector<HTMLInputElement>("#thread-title");
    if (titleInput) { titleInput.value = ""; threadTitleDraft = ""; }
    document.querySelector("#composer .reply-banner")?.remove();
    if (threaded() && !titleInput) body.insertAdjacentHTML("beforebegin", threadInput());
    updateTopicOptions();
    body.placeholder = place();
    $("#send-message span").textContent = threaded() ? "Post thread" : "Send";
    grow();
    body.focus({ preventScroll: true });
  };
  $("#send-message").addEventListener("pointerdown", e => {
    if (document.activeElement === body) e.preventDefault();
  });
  suggestShortcodes(body);
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
          sent();
          await refreshCurrent();
          if (generation !== token) return;
          render({ bottom: true });
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
        // A sent reply leaves the Fusion composer free to start a thread again.
        if (reply && threaded() && isFusion()) selectedMessage = null;
        reply = null;
        sent();
        if (!live()) await jumpToLatest();
        if (message.queued) pending = [...pending, message];
        else merge(message);
        if (narrow && topicId && narrow !== topicId)
          return go(`#/c/${c.id}/t/${topicId}`);
        renderSidebar();
        render({ bottom: true });
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

// ---- keeping up: called when the server says the conversation on screen changed ----
export function redrawChat(composer = false, header = false) {
  if (!current) return;
  if (header) renderMembers();
  if (header && document.querySelector("#rows")) renderHeader();
  render();
  if (composer) renderComposer();
}
export async function refreshCurrent(metadata = true) {
  if (!current) return;
  const id = current.id,
    token = generation,
    top = ceiling(),
    bottom = olderCursor,
    // Away from the newest messages it is the window that is read again, from its top.
    [detail, page] = await load(id, metadata, live() ? undefined : top);
  if (generation !== token) return;
  const roleChanged = detail.role !== current.role,
    federationChanged =
      detail.federation_enabled !== current.federation_enabled ||
      detail.dm?.blocked !== current.dm?.blocked,
    topicsChanged =
      JSON.stringify(detail.topics) !== JSON.stringify(current.topics),
    headerChanged =
      detail.member_count !== current.member_count ||
      detail.sees_members !== current.sees_members ||
      detail.description !== current.description ||
      detail.dm?.avatar_url !== current.dm?.avatar_url ||
      detail.name !== current.name;
  // A refresh without the roster keeps the pages of it already read, unless people came or went.
  if (detail.members_cursor === "" && !detail.members?.length && current.members_cursor !== "") {
    if (detail.member_count === current.member_count) {
      detail.members = current.members;
      detail.members_cursor = current.members_cursor;
    } else rosterAuto = "";
  }
  current = detail;
  if (narrow && !topicOf(narrow)) return go(`#/c/${id}`);
  // Refresh earlier loaded pages too so edits/removals never remain visible in cached history.
  let fresh = page.incremental
      ? [...messages.filter(message=>!page.messages.some(next=>next.id===message.id)),...page.messages].sort(bySeq).slice(-PAGE)
      : page.messages,
    cursor = page.older_cursor;
  const oldest = bottom ?? messages[0]?.seq;
  while (!page.incremental && cursor && oldest && fresh.length && fresh[0].seq > oldest) {
    const previous = await api<Page>(pagePath(id, cursor));
    if (generation !== token) return;
    fresh = [...previous.messages, ...fresh];
    cursor = previous.older_cursor;
  }
  // Scrolling meanwhile moved the window; what it fetched is newer than this.
  if (top === ceiling() && bottom === olderCursor && !paging) {
    // What is in sight outside the window stays until the reader moves on.
    const strays = messages.filter((m) => !inWindow(m) && nearView(m.id) && !fresh.some((f) => f.id === m.id));
    messages = [...fresh, ...strays].sort(bySeq);
    olderCursor = cursor;
    if (live()) {
      pending = page.pending || [];
      refreshCursor = page.refresh_cursor; refreshStamp = page.refresh_stamp;
    }
    trim();
  }
  if (!document.querySelector("#rows")) return;
  markSeen();
  if (roleChanged || federationChanged || headerChanged || topicsChanged)
    renderHeader();
  renderMembers();
  // Choices made in another browser, or just now from the sidebar.
  const prefs = JSON.stringify(state.prefs),
    prefsChanged = prefs !== lastPrefs;
  lastPrefs = prefs;
  if (prefsChanged && !(roleChanged || federationChanged || headerChanged || topicsChanged))
    renderHeader();
  const now = signature();
  if (now !== lastSignature || roleChanged || federationChanged || prefsChanged) {
    lastSignature = now;
    render({ animate: true });
  } else refreshTimes($("#message-list"));
  renderSidebar();
  if (topicsChanged) updateTopicOptions();
  if (roleChanged || federationChanged) {
    reply = null;
    renderComposer();
  }
}
