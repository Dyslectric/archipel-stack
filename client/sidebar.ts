import {
  $$,
  action,
  api,
  avatar,
  channelIcon,
  dmHref,
  esc,
  go,
  icon,
  modeLabel,
  popup,
  promptDialog,
  state,
  type Channel,
  type Conversation,
  type Layout,
  type SideGroup,
  type SideKind,
  type SideSection,
  type XmppRoom,
  type Topic,
} from "./shared.js";
import { isFusion } from "./appearance.js";
import {
  chatChannel,
  chatTopic,
  redrawChat,
  resetChat,
  sortedTopics,
} from "./chat.js";
import { isHidden, pickPref, prefItems } from "./prefs.js";

// The sidebar: direct messages, channels, then XMPP rooms, in the order the reader dragged their
// headings into. Each section folds away, and its conversations can be put in named groups and
// reordered, by dragging or from the menu on each row. XMPP rooms can be listed among the channels
// instead of in a section of their own. The arrangement is kept with the account (state.layout), so
// it follows the reader to other browsers.
const titles: Record<SideKind, string> = {
  dms: "Direct messages",
  channels: "Channels",
  xmpp: "XMPP rooms",
};
const kinds = Object.keys(titles) as SideKind[];
let html = "",
  saving = 0;
let drag: { type: "item" | "group" | "section"; kind: SideKind; id: string } | null = null;
const topicExpansion = new Map<string, boolean>();
const topicCache = new Map<string, Topic[]>();
const topicLoading = new Set<string>();
async function toggleTopics(id: string) {
  const c = state.channels.find(c => c.id === id);
  if (!c || c.mode !== "topical" || !c.readable) return;
  const open = !(topicExpansion.get(id) ?? chatChannel()?.id === id);
  topicExpansion.set(id, open);
  if (!open || chatChannel()?.id === id) return renderSidebar();
  topicLoading.add(id); renderSidebar();
  try {
    const detail = await api<Channel>(`/channels/${id}`);
    topicCache.set(id, detail.topics || []);
  } catch (error) {
    topicExpansion.set(id, false);
    throw error;
  } finally { topicLoading.delete(id); renderSidebar(); }
}

const isRoom = (id: string) => id.startsWith("xmpp:");
// Rooms listed among the channels, in the channels' section.
const merged = () => !!state.layout?.merged;
// The section a conversation is listed in.
const kindOf = (id: string): SideKind =>
  id.startsWith("dm:") ? "dms" : isRoom(id) && !merged() ? "xmpp" : "channels";
// What is new, leaving out the conversation on screen: that one is being read.
const unread = (id: string) =>
  chatChannel()?.id === id ? 0 : state.unread[id] || 0;
const count = (n: number, label = "new") =>
  n
    ? `<span class="count" aria-label="${n} ${label}">${n > 99 ? "99+" : n}</span>`
    : "";
export function unreadTotal() {
  return Object.keys(state.unread).reduce((n, id) => n + unread(id), 0);
}

// ---- what there is to show ----
function conversations(): Conversation[] {
  const open = chatChannel()?.dm;
  // A conversation just opened has no messages yet, but is listed while it's on screen.
  return open && !state.dms.some((c) => c.peer === open.peer)
    ? [open, ...state.dms]
    : state.dms;
}
const joinedRooms = () => state.xmppRooms.filter((r) => r.desired);
// Instances without XMPP have no rooms to list.
const hasRooms = () => state.xmppEnabled || !!joinedRooms().length;
const roomsIn = (kind: SideKind) =>
  kind === (merged() ? "channels" : "xmpp") ? joinedRooms() : [];
function available(kind: SideKind) {
  return kind === "dms"
    ? conversations().map((c) => `dm:${c.peer}`)
    : [
        ...(kind === "channels" ? state.channels.filter((c) => c.role).map((c) => c.id) : []),
        ...roomsIn(kind).map((r) => `xmpp:${r.id}`),
      ];
}
// The sections from top to bottom, as saved, and those of them that show.
const order = () => [
  ...new Set([...(state.layout?.order || []).filter((k) => kinds.includes(k)), ...kinds]),
];
const sections = () =>
  order().filter((k) => k !== "xmpp" || (!merged() && hasRooms()));
// The saved arrangement with every current conversation somewhere in it: new direct messages
// go on top, newly joined channels and rooms at the end.
function placed(kind: SideKind): SideSection {
  const saved = state.layout?.[kind];
  const section: SideSection = {
    collapsed: !!saved?.collapsed,
    items: [...(saved?.items || [])],
    groups: (saved?.groups || []).map((g) => ({ ...g, items: [...g.items] })),
  };
  const have = new Set([
    ...section.items,
    ...section.groups.flatMap((g) => g.items),
  ]);
  const fresh = available(kind).filter((id) => !have.has(id));
  section.items =
    kind === "dms"
      ? [...fresh, ...section.items]
      : [...section.items, ...fresh];
  return section;
}
function save(kind: SideKind, section: SideSection) {
  commit({
    ...(Object.fromEntries(
      kinds.map((k) => [k, k === kind ? section : placed(k)]),
    ) as Record<SideKind, SideSection>),
    order: order(),
    merged: merged(),
  });
}
function commit(layout: Layout) {
  state.layout = layout;
  renderSidebar();
  saving++;
  action(async () => {
    try {
      await api("/sidebar", "PUT", layout);
    } finally {
      saving--;
    }
  });
}
// The server's copy, unless a change made here is still on its way there.
export function adoptLayout(layout: Layout | null) {
  if (!saving) state.layout = layout;
}

// ---- changes ----
const listOf = (section: SideSection, group: string) =>
  group ? section.groups.find((g) => g.id === group)?.items : section.items;
function moveItem(id: string, group: string, before: string | null) {
  const kind = kindOf(id),
    section = placed(kind);
  if (before === id) return;
  section.items = section.items.filter((x) => x !== id);
  for (const g of section.groups) g.items = g.items.filter((x) => x !== id);
  const list = listOf(section, group);
  if (!list) return;
  const at = before ? list.indexOf(before) : -1;
  list.splice(at < 0 ? list.length : at, 0, id);
  save(kind, section);
}
// One place up or down among the rows that are showing.
function stepItem(id: string, by: 1 | -1) {
  const kind = kindOf(id),
    section = placed(kind),
    shown = new Set(available(kind));
  const group = section.groups.find((g) => g.items.includes(id));
  const list = (group ? group.items : section.items).filter((x) =>
    shown.has(x),
  );
  const at = list.indexOf(id) + by;
  if (at < 0 || at >= list.length) return;
  moveItem(id, group?.id || "", by < 0 ? list[at] : list[at + 1] || null);
}
function moveGroup(kind: SideKind, id: string, before: string | null) {
  const section = placed(kind),
    group = section.groups.find((g) => g.id === id);
  if (!group || before === id) return;
  section.groups = section.groups.filter((g) => g !== group);
  const at = before ? section.groups.findIndex((g) => g.id === before) : -1;
  section.groups.splice(at < 0 ? section.groups.length : at, 0, group);
  save(kind, section);
}
function moveSection(kind: SideKind, before: SideKind | null) {
  if (before === kind) return;
  const next = order().filter((k) => k !== kind),
    at = before ? next.indexOf(before) : -1;
  next.splice(at < 0 ? next.length : at, 0, kind);
  commit({ dms: placed("dms"), channels: placed("channels"), xmpp: placed("xmpp"), order: next, merged: merged() });
}
// One place up or down among the sections that are showing.
function stepSection(kind: SideKind, by: 1 | -1) {
  const shown = sections(),
    at = shown.indexOf(kind) + by;
  if (at < 0 || at >= shown.length) return;
  moveSection(kind, by < 0 ? shown[at] : shown[at + 1] || null);
}
// Rooms move in with the channels, after them, or back out to a section of their own.
function setMerged(on: boolean) {
  if (on === merged()) return;
  const dms = placed("dms"),
    channels = placed("channels"),
    xmpp = placed("xmpp");
  if (on) {
    channels.items.push(...xmpp.items);
    channels.groups.push(...xmpp.groups);
    xmpp.items = [];
    xmpp.groups = [];
  } else {
    // A group of nothing but rooms goes with them.
    const theirs = channels.groups.filter((g) => g.items.length && g.items.every(isRoom));
    channels.groups = channels.groups.filter((g) => !theirs.includes(g));
    xmpp.items.push(...channels.items.filter(isRoom), ...channels.groups.flatMap((g) => g.items.filter(isRoom)));
    xmpp.groups.push(...theirs);
    channels.items = channels.items.filter((id) => !isRoom(id));
    for (const g of channels.groups) g.items = g.items.filter((id) => !isRoom(id));
  }
  commit({ dms, channels, xmpp, order: order(), merged: on });
}
function fold(kind: SideKind, group: string) {
  const section = placed(kind),
    target = group ? section.groups.find((g) => g.id === group) : section;
  if (!target) return;
  target.collapsed = !target.collapsed;
  save(kind, section);
}
async function newGroup(kind: SideKind, firstItem?: string) {
  const name = await promptDialog(
    "New group",
    `Group name, under ${titles[kind]}`,
    "",
    "Create group",
  );
  if (!name) return;
  const section = placed(kind),
    group: SideGroup = {
      id: crypto.randomUUID(),
      name,
      collapsed: false,
      items: [],
    };
  section.groups.push(group);
  section.collapsed = false;
  save(kind, section);
  if (firstItem) moveItem(firstItem, group.id, null);
}
// A closed conversation leaves the sidebar until something new is said in it, or it is reopened
// from the settings. One only just opened has nothing to close yet: leaving it is enough.
function closeConversation(id: string) {
  const peer = id.slice(3);
  action(async () => {
    if (state.dms.some((c) => c.peer === peer))
      await api("/dms/close", "POST", { peer, closed: true });
    state.dms = state.dms.filter((c) => c.peer !== peer);
    delete state.unread[id];
    if (chatChannel()?.id === id) {
      resetChat();
      localStorage.removeItem("archipel-channel");
      go("#/inbox");
    }
    renderSidebar();
  });
}

// ---- the markup ----
const silenced = (id: string) =>
  state.prefs[id]?.notify === false
    ? `<span class="mode-tag" title="Notifications off">${icon("bell-off")}</span>`
    : state.prefs[id]?.notify === "mentions"
      ? `<span class="mode-tag" title="Notifies on mentions only">${icon("at")}</span>`
      : "";
function channelRow(c: Channel) {
  const open = chatChannel(),
    narrow = chatTopic(),
    on = open?.id === c.id;
  const topic = (t: { id: string; title: string }) =>
    `<a class="topic-link${narrow === t.id ? " on" : ""}" href="#/c/${c.id}/t/${t.id}"${narrow === t.id ? ' aria-current="page"' : ""}>${esc(t.title)}</a>`;
  // Hidden topics are folded away under the others; the one being read stays in sight.
  const expanded = c.mode === "topical" && c.readable && (topicExpansion.get(c.id) ?? on);
  const all = expanded ? (on ? sortedTopics() : topicCache.get(c.id) || c.topics || []) : [],
    away = all.filter((t) => isHidden(`topic:${t.id}`) && narrow !== t.id);
  const topics = expanded
    ? `<div class="topic-list">${all
        .filter((t) => !away.includes(t))
        .map(topic)
        .join("")}${away.length ? `<details class="hidden-topics"><summary class="topic-link">${icon("eye-off")} ${away.length} hidden</summary>${away.map(topic).join("")}</details>` : ""}${!all.length ? `<span class="topic-link muted topic-placeholder">${topicLoading.has(c.id) ? "Loading topics…" : "No topics yet."}</span>` : ""}</div>`
    : "";
  return {
    name: `#${c.name}`,
    extra: topics,
    link: `${c.mode === "topical" && c.readable ? `<button type="button" class="icon-button topic-toggle" data-expand-topics="${esc(c.id)}" aria-expanded="${expanded}" aria-label="${expanded ? "Collapse" : "Expand"} topics in ${esc(c.name)}">${icon(expanded ? "folder-open" : "folder")}</button>` : ""}<a class="channel-link${on && !narrow ? " on" : ""}" draggable="false" href="#/c/${c.id}"${on && !narrow ? ' aria-current="page"' : ""} data-channel="${c.id}">${c.mode === "topical" && c.readable ? "" : channelIcon({ ...c, remote_actor: null }, false)}<span class="grow">${esc(c.name)}</span>${c.mode !== "timeline" ? `<span class="mode-tag">${modeLabel(c.mode)}</span>` : ""}${silenced(c.id)}${c.remote_actor ? `<span class="mode-tag remote-marker" title="On another instance" aria-label="On another instance">${icon("globe")}</span>` : isFusion() && c.visibility === "members" ? `<span class="mode-tag" title="Members only">${icon("lock")}</span>` : ""}${count(unread(c.id))}</a>`,
  };
}
function dmRow(c: Conversation) {
  const on = chatChannel()?.id === `dm:${c.peer}`;
  return {
    name: c.display_name,
    extra: "",
    link: `<a class="channel-link dm-link${on ? " on" : ""}" draggable="false" href="${esc(dmHref(c.peer))}"${on ? ' aria-current="page"' : ""} title="@${esc(c.username)}">${avatar(c, "small")}<span class="grow">${esc(c.display_name)}</span>${c.remote ? `<span class="mode-tag">${icon("globe")}</span>` : ""}${silenced(`dm:${c.peer}`)}${count(unread(`dm:${c.peer}`))}</a>`,
  };
}
function roomRow(r: XmppRoom) {
  const on = location.hash === `#/xmpp/${r.id}`;
  return {
    name: r.room,
    extra: "",
    link: `<a class="channel-link${on ? " on" : ""}" draggable="false" href="#/xmpp/${r.id}"${on ? ' aria-current="page"' : ""} title="${esc(r.room)}">${icon("xmpp")}<span class="grow">${esc(r.room)}</span>${r.state !== "joined" ? `<span class="mode-tag">${esc(r.reconnecting ? "reconnecting" : r.state)}</span>` : ""}</a>`,
  };
}
const empty: Record<SideKind, string> = {
  dms: "Nobody yet. Start a conversation with the + above.",
  channels: "Channels you join appear here.",
  xmpp: "Rooms you join on other servers appear here.",
};
function sectionHtml(kind: SideKind) {
  const section = placed(kind);
  const rows = new Map(
    kind === "dms"
      ? conversations().map((c) => [`dm:${c.peer}`, dmRow(c)] as const)
      : [
          ...(kind === "channels" ? state.channels.filter((c) => c.role) : []).map(
            (c) => [c.id, channelRow(c)] as const,
          ),
          ...roomsIn(kind).map((r) => [`xmpp:${r.id}`, roomRow(r)] as const),
        ],
  );
  const items = (ids: string[]) =>
    ids
      .filter((id) => rows.has(id))
      .map((id) => {
        const row = rows.get(id)!;
        return `<div class="side-item" draggable="true" data-item="${esc(id)}"><div class="side-row">${row.link}<button type="button" class="icon-button row-menu" data-item-menu aria-haspopup="menu" aria-label="Organise ${esc(row.name)}" title="Move or group">${icon("more")}</button></div>${row.extra}</div>`;
      })
      .join("");
  const news = (ids: string[]) =>
    count(ids.reduce((n, id) => n + (rows.has(id) ? unread(id) : 0), 0));
  const everything = [
    ...section.items,
    ...section.groups.flatMap((g) => g.items),
  ];
  const loose =
    items(section.items) ||
    (rows.size
      ? ""
      : `<p class="muted small side-empty">${empty[kind]}</p>`);
  const groups = section.groups
    .map(
      (g) =>
        `<div class="side-group" data-group="${esc(g.id)}"><div class="group-head" draggable="true"><button type="button" class="side-toggle" data-fold="${esc(g.id)}" aria-expanded="${!g.collapsed}">${icon("chevron-down", "chev")}<span class="grow">${esc(g.name)}</span>${g.collapsed ? news(g.items) : ""}</button><button type="button" class="icon-button row-menu" data-group-menu aria-haspopup="menu" aria-label="Organise group ${esc(g.name)}" title="Rename, move or delete">${icon("more")}</button></div>
        ${g.collapsed ? "" : `<div class="side-items" data-list="${esc(g.id)}">${items(g.items) || '<p class="muted small side-empty">Nothing in this group yet.</p>'}</div>`}</div>`,
    )
    .join("");
  const looking =
    kind === "channels" && chatChannel() && !chatChannel()!.role
      ? `<div class="side-label">Looking at</div><div class="side-row">${channelRow(chatChannel()!).link}</div><div class="side-label">Joined</div>`
      : "";
  return `<section class="side-section" data-section="${kind}"><div class="side-head" draggable="true"><button type="button" class="side-toggle" data-fold="" aria-expanded="${!section.collapsed}">${icon("chevron-down", "chev")}<h2 class="grow">${titles[kind]}</h2>${section.collapsed ? news(everything) : ""}</button>
    <button type="button" class="icon-button" data-section-menu aria-haspopup="menu" aria-label="Add or organise ${titles[kind].toLowerCase()}" title="Add or organise">${icon("plus")}</button></div>
    ${section.collapsed ? "" : `${looking}<div class="side-items" data-list="">${loose}</div>${groups}`}</section>`;
}
export function renderSidebar() {
  const badge = document.querySelector<HTMLElement>("#inbox-count");
  if (badge) {
    const n = unreadTotal();
    badge.hidden = !n;
    badge.textContent = n > 99 ? "99+" : String(n);
  }
  const list = document.querySelector("#channel-list");
  if (!list || drag) return;
  const next = sections().map(sectionHtml).join("");
  if (next === html && list.childElementCount) return;
  list.innerHTML = html = next;
}

// ---- menus ----
const item = (name: string, label: string, ico: string, on = false) =>
  `<button type="button" class="menu-item${on ? " on" : ""}" role="menuitem" data-do="${esc(name)}">${icon(ico)}<span class="grow">${esc(label)}</span>${on ? icon("check") : ""}</button>`;
// Whether rooms keep a section of their own: offered wherever channels or rooms are.
const separate = () =>
  hasRooms()
    ? `<div class="menu-section" role="menu"><button type="button" class="menu-item" role="menuitemcheckbox" aria-checked="${!merged()}" data-do="separate"><input type="checkbox" tabindex="-1" aria-hidden="true"${merged() ? "" : " checked"}><span class="grow">Separate XMPP rooms from channels</span></button></div>`
    : "";
type Point = { x: number; y: number };
function sectionMenu(button: HTMLElement, kind: SideKind, at?: Point) {
  // One that names a window opens it in Fusion, and goes to the page elsewhere.
  const link = (href: string, label: string, ico: string, win = "") =>
    `<a class="menu-item" role="menuitem" href="${href}"${win ? ` data-open-window="${win}"` : ""}>${icon(ico)}<span class="grow">${label}</span></a>`;
  const add = kind === "dms"
    ? `<button type="button" class="menu-item" role="menuitem" data-new-dm>${icon("pencil")}<span class="grow">New direct message</span></button>`
    : kind === "xmpp" ? link("#/xmpp", "Join an XMPP room", "globe", "xmpp")
    : `${state.session.user?.create_channels ? link("#/channels/new", "Create channel", "plus") : ""}${link("#/channels", "Browse channels", "compass")}${state.session.federation_enabled ? link("#/settings/federation/remote", "Join a channel on another server", "globe", "federated") : ""}${merged() && state.xmppEnabled ? link("#/xmpp", "Join an XMPP room", "globe", "xmpp") : ""}`;
  const panel = popup(button, `<div class="menu-section" role="menu">${add}</div><div class="menu-section" role="menu">${item("group", "New group…", "folder-plus")}${item("up", "Move section up", "arrow-up")}${item("down", "Move section down", "arrow-down")}</div>${kind === "dms" ? "" : separate()}`, at);
  panel?.addEventListener("click", (e) => {
    const name = (e.target as Element).closest<HTMLElement>("[data-do]")
      ?.dataset.do;
    if (name === "group") void newGroup(kind);
    else if (name === "up") stepSection(kind, -1);
    else if (name === "down") stepSection(kind, 1);
    else if (name === "separate") setMerged(!merged());
  });
}
function itemMenu(button: HTMLElement, at?: Point) {
  const id = button.closest<HTMLElement>("[data-item]")!.dataset.item!,
    kind = kindOf(id),
    section = placed(kind),
    inGroup = section.groups.find((g) => g.items.includes(id));
  const panel = popup(
    button,
    `<div class="menu-section" role="menu">${item("up", "Move up", "arrow-up")}${item("down", "Move down", "arrow-down")}</div>
    <div class="menu-section" role="menu"><div class="menu-label">Group</div>${section.groups.map((g) => item(`to:${g.id}`, g.name, "folder", g === inGroup)).join("")}${inGroup ? item("to:", "No group", "x") : ""}${item("new", "New group…", "folder-plus")}</div>${isRoom(id) ? "" : prefItems(kind === "dms" ? "dm" : "channel", id)}${kind === "dms" ? `<div class="menu-section" role="menu">${item("close", "Close conversation", "x")}</div>` : separate()}`,
    at,
  );
  panel?.addEventListener("click", (e) => {
    pickPref(e, id, () => {
      renderSidebar();
      redrawChat(false, true);
    });
    const name = (e.target as Element).closest<HTMLElement>("[data-do]")
      ?.dataset.do;
    if (name === "up") stepItem(id, -1);
    else if (name === "down") stepItem(id, 1);
    else if (name === "new") void newGroup(kind, id);
    else if (name === "close") closeConversation(id);
    else if (name === "separate") setMerged(!merged());
    else if (name?.startsWith("to:")) moveItem(id, name.slice(3), null);
  });
}
function groupMenu(button: HTMLElement) {
  const kind = button.closest<HTMLElement>("[data-section]")!.dataset
      .section as SideKind,
    id = button.closest<HTMLElement>("[data-group]")!.dataset.group!;
  const panel = popup(
    button,
    `<div class="menu-section" role="menu">${item("rename", "Rename group", "pencil")}${item("up", "Move up", "arrow-up")}${item("down", "Move down", "arrow-down")}</div><div class="menu-section" role="menu">${item("delete", "Delete group", "trash")}</div>`,
  );
  panel?.addEventListener("click", (e) => {
    const name = (e.target as Element).closest<HTMLElement>("[data-do]")
        ?.dataset.do,
      section = placed(kind),
      at = section.groups.findIndex((g) => g.id === id),
      group = section.groups[at];
    if (!name || !group) return;
    if (name === "up" && at > 0) moveGroup(kind, id, section.groups[at - 1].id);
    else if (name === "down" && at < section.groups.length - 1)
      moveGroup(kind, id, section.groups[at + 2]?.id || null);
    else if (name === "delete") {
      // Its conversations stay, loose again.
      section.items.push(...group.items);
      section.groups.splice(at, 1);
      save(kind, section);
    } else if (name === "rename")
      void promptDialog("Rename group", "Group name", group.name).then(
        (value) => {
          const fresh = placed(kind),
            target = fresh.groups.find((g) => g.id === id);
          if (!value || !target) return;
          target.name = value;
          save(kind, fresh);
        },
      );
  });
}

// ---- the sidebar itself: as wide as the reader drags it, or folded away. Kept for this browser. ----
export function sidebarFrame(view: HTMLElement) {
  view.innerHTML = `<div class="workspace"><aside class="sidebar" id="sidebar" aria-label="Conversations">
    <nav id="channel-list" aria-label="Your conversations"></nav>
    <button type="button" class="side-foot" data-new-dm>${icon("pencil")}<span>New direct message</span></button>
    <div class="side-resize" id="side-resize" role="separator" aria-orientation="vertical" aria-label="Sidebar width" aria-valuemin="180" aria-valuemax="520" tabindex="0" title="Drag to resize. Double-click to reset."></div></aside></div>`;
  wireSidebar(view.querySelector<HTMLElement>("#channel-list")!);
  renderSidebar();
  return view.querySelector<HTMLElement>(".workspace")!;
}

const WIDTH = "archipel-sidebar-width",
  FOLDED = "archipel-sidebar-collapsed";
function stored(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function keep(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* Without storage the arrangement lasts until the page is reloaded. */
  }
}
const workspace = () => document.querySelector<HTMLElement>(".workspace");
function setWidth(value: number | null) {
  const ws = workspace();
  if (!ws) return;
  if (value === null) ws.style.removeProperty("--sidebar-w");
  else {
    const width = Math.round(Math.max(180, Math.min(value, 520, innerWidth * 0.6)));
    ws.style.setProperty("--sidebar-w", `${width}px`);
    ws.querySelector("#side-resize")?.setAttribute("aria-valuenow", String(width));
  }
}
export function sidebarCollapsed() {
  return stored(FOLDED) === "1";
}
export function applySidebar() {
  const width = Number(stored(WIDTH));
  setWidth(width >= 180 ? width : null);
  workspace()?.classList.toggle("side-collapsed", sidebarCollapsed());
  document
    .querySelector("#mobile-menu")
    ?.setAttribute("aria-pressed", String(!sidebarCollapsed()));
}
// The button in the top bar: the drawer on a phone, the column on a wider screen.
export function toggleSidebar() {
  if (matchMedia("(max-width: 720px)").matches) {
    document.querySelector("#sidebar")?.classList.toggle("mobile-open");
    return;
  }
  keep(FOLDED, sidebarCollapsed() ? null : "1");
  applySidebar();
}
function wireResize(handle: HTMLElement) {
  const current = () =>
    document.querySelector<HTMLElement>("#sidebar")?.getBoundingClientRect().width || 264;
  const save = () => keep(WIDTH, String(Math.round(current())));
  handle.addEventListener("pointerdown", (e) => {
    if (e.button) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const ws = workspace()!,
      left = ws.getBoundingClientRect().left;
    ws.classList.add("resizing");
    const move = (ev: PointerEvent) => setWidth(ev.clientX - left);
    const done = () => {
      ws.classList.remove("resizing");
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
    setWidth(null);
    keep(WIDTH, null);
  });
  handle.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    setWidth(current() + (e.key === "ArrowLeft" ? -16 : 16));
    save();
  });
}

// ---- wiring: once per sidebar element ----
export function wireSidebar(list: HTMLElement) {
  html = "";
  applySidebar();
  const handle = document.querySelector<HTMLElement>("#side-resize");
  if (handle) wireResize(handle);
  const sectionOf = (el: Element) =>
    el.closest<HTMLElement>("[data-section]")?.dataset.section as
      | SideKind
      | undefined;
  list.addEventListener("click", (e) => {
    const at = e.target as Element;
    let hit: HTMLElement | null;
    if ((hit = at.closest<HTMLElement>("[data-expand-topics]"))) {
      e.preventDefault();
      action(() => toggleTopics(hit!.dataset.expandTopics!));
    } else if ((hit = at.closest<HTMLElement>("[data-fold]")))
      fold(sectionOf(hit)!, hit.dataset.fold!);
    else if ((hit = at.closest<HTMLElement>("[data-section-menu]")))
      sectionMenu(hit, sectionOf(hit)!);
    else if ((hit = at.closest<HTMLElement>("[data-new-group]")))
      void newGroup(sectionOf(hit)!);
    else if ((hit = at.closest<HTMLElement>("[data-item-menu]"))) itemMenu(hit);
    else if ((hit = at.closest<HTMLElement>("[data-group-menu]")))
      groupMenu(hit);
  });
  // A right click on a channel or a room, or on their headings, opens the menu that says whether
  // rooms keep a section of their own.
  list.addEventListener("contextmenu", (e) => {
    const on = e.target as Element,
      kind = sectionOf(on),
      button = on.closest(".side-row")?.querySelector<HTMLElement>("[data-item-menu]"),
      head = on.closest(".side-head")?.querySelector<HTMLElement>("[data-section-menu]");
    if (!kind || kind === "dms" || !hasRooms() || !(button || head)) return;
    e.preventDefault();
    const at = { x: e.clientX, y: e.clientY };
    if (button) itemMenu(button, at);
    else sectionMenu(head!, kind, at);
  });

  // Dragging a row to another place or group, a group's heading among the groups, or a section's
  // heading among the sections.
  const clear = () => {
    for (const el of $$(".drop-before, .drop-end, .dragging", list))
      el.classList.remove("drop-before", "drop-end", "dragging");
  };
  // Where a drop at this point would land: the list (or group) it joins, and the row it goes before.
  function target(e: DragEvent) {
    if (!drag) return null;
    const at = e.target as Element;
    const before = (rows: HTMLElement[]) =>
      rows.find((row) => {
        const box = row.getBoundingClientRect();
        return e.clientY < box.top + box.height / 2;
      }) || null;
    if (drag.type === "section") {
      const all = $$("[data-section]", list),
        row = before(all);
      return { mark: row, end: all[all.length - 1], group: "", before: row?.dataset.section };
    }
    if (sectionOf(at) !== drag.kind) return null;
    if (drag.type === "group") {
      const section = at.closest<HTMLElement>("[data-section]")!,
        row = before($$("[data-group]", section));
      return { mark: row, end: section, group: "", before: row?.dataset.group };
    }
    const group = at.closest<HTMLElement>("[data-group]"),
      inside =
        at.closest<HTMLElement>("[data-list]") ||
        group?.querySelector<HTMLElement>("[data-list]");
    // A folded group takes the row at its end.
    if (!inside)
      return group
        ? { mark: null, end: group, group: group.dataset.group!, before: null }
        : null;
    const row = before($$(":scope > [data-item]", inside));
    return {
      mark: row,
      end: inside,
      group: inside.dataset.list!,
      before: row?.dataset.item,
    };
  }
  list.addEventListener("dragstart", (e) => {
    const at = e.target as Element,
      row = at.closest<HTMLElement>("[data-item]"),
      head = at.closest<HTMLElement>(".group-head, .side-head"),
      kind = sectionOf(at);
    if (!kind || (!row && !head)) return;
    drag = row
      ? { type: "item", kind, id: row.dataset.item! }
      : head!.matches(".side-head")
        ? { type: "section", kind, id: kind }
        : {
            type: "group",
            kind,
            id: head!.closest<HTMLElement>("[data-group]")!.dataset.group!,
          };
    e.dataTransfer!.effectAllowed = "move";
    e.dataTransfer!.setData("text/plain", (row || head)!.textContent || "");
    (row || head!.parentElement)!.classList.add("dragging");
  });
  list.addEventListener("dragover", (e) => {
    const to = target(e);
    if (!to) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = "move";
    const mark = to.mark || to.end,
      cls = to.mark ? "drop-before" : "drop-end";
    if (mark.classList.contains(cls)) return;
    for (const el of $$(".drop-before, .drop-end", list))
      el.classList.remove("drop-before", "drop-end");
    mark.classList.add(cls);
  });
  list.addEventListener("drop", (e) => {
    const to = target(e),
      moved = drag;
    if (!to || !moved) return;
    e.preventDefault();
    drag = null;
    clear();
    if (moved.type === "section")
      moveSection(moved.kind, (to.before as SideKind) || null);
    else if (moved.type === "group")
      moveGroup(moved.kind, moved.id, to.before || null);
    else moveItem(moved.id, to.group, to.before || null);
  });
  list.addEventListener("dragend", () => {
    drag = null;
    clear();
    renderSidebar();
  });
}
