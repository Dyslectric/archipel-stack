import "./style.css";
import { emojiParts, standardEmojis, type CustomEmoji } from "../src/emojis.js";

interface User {
  id: string;
  username: string;
  display_name: string;
  admin?: boolean;
  banned?: boolean;
  admission_status?: "pending" | "approved" | "rejected";
  share_socials?: boolean;
  verified_socials: unknown[];
  role?: string;
  federation_send?: boolean;
  federation_receive?: boolean;
  federation_subscribe?: boolean;
  federation_post?: boolean;
}
interface Topic {
  id: string;
  title: string;
}
interface Channel {
  id: string;
  name: string;
  description: string;
  mode: "timeline" | "topical" | "threaded";
  visibility: string;
  admission: string;
  owner_id: string;
  role: string | null;
  readable: boolean;
  can_join: boolean;
  member_count: number;
  members?: User[];
  topics?: Topic[];
  remote_actor: string | null;
  federation_enabled: number;
}
interface Message {
  id: string;
  seq: number;
  author_id: string;
  username: string;
  display_name: string;
  body: string;
  title: string | null;
  parent_id: string | null;
  topic_id: string | null;
  created_at: string;
  deleted_at: string | null;
  edited_at: string | null;
  emojis?: CustomEmoji[];
  queued?: boolean;
}
interface Session {
  user: User | null;
  csrf: string | null;
  dev_auth: boolean;
  oidc_enabled: boolean;
  instance: string;
  registration_mode: "open" | "invite_only";
  federation_enabled: boolean;
}
const app = document.querySelector<HTMLDivElement>("#app")!;
let session: Session;
let customEmojis: CustomEmoji[] = [];
let channels: Channel[] = [],
  current: Channel | null = null,
  messages: Message[] = [];
let currentTopic: string | null = null,
  reply: Message | null = null,
  olderCursor: number | null = null;
let refreshBusy = false,
  generation = 0,
  lastMessageSignature = "",
  toastTimer: ReturnType<typeof setTimeout>;
const esc = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const $ = <T extends HTMLElement = HTMLElement>(selector: string) =>
  document.querySelector<T>(selector)!;
const paths: Record<string, string> = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  hash: '<path d="M10 3 8 21M16 3l-2 18M4 9h17M3 15h17"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  arrow: '<path d="m5 12 14 0m-6-6 6 6-6 6"/>',
  send: '<path d="m3 3 19 9-19 9 4-9-4-9Zm4 9h15"/>',
  people:
    '<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6m2 3a5 5 0 0 1 3 4v3"/>',
  settings: '<path d="M12 8v8M8 12h8"/><circle cx="12" cy="12" r="9"/>',
  reply: '<path d="m9 5-6 6 6 6M3 11h11a7 7 0 0 1 7 7"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  logout: '<path d="M10 4H4v16h6m5-13 5 5-5 5m-7-5h12"/>',
  chat: '<path d="M21 11a9 9 0 0 1-9 9H3l2-5a9 9 0 1 1 16-4Z"/>',
};
const icon = (name: string) =>
  `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.hash}</svg>`;
const brand = `<span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i></span><span>archipel<span class="brand-dot">.</span></span>`;
const avatar = (u: User | Message, small = false) =>
  `<span class="avatar ${small ? "small" : ""} tone-${("username" in u ? u.username.charCodeAt(0) : 0) % 5}">${esc(("display_name" in u ? u.display_name : "").slice(0, 1).toUpperCase())}</span>`;
const modeLabel = (mode: string) =>
  ({ timeline: "Timeline", topical: "Topics", threaded: "Threads" })[mode] ||
  mode;

function toast(message: string) {
  $("#toast").textContent = message;
  $("#toast").classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("#toast").classList.remove("visible"), 5000);
}
class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(session?.csrf ? { "X-CSRF-Token": session.csrf } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (!response.ok)
    throw new ApiError(response.status, data.error || "Something went wrong.");
  return data as T;
}
function emojiHtml(body: string, emojis = customEmojis) {
  return emojiParts(body, emojis)
    .map((part) =>
      "text" in part
        ? esc(part.text)
        : "emoji" in part
          ? `<span title=":${esc(part.name)}:">${esc(part.emoji)}</span>`
          : `<img class="custom-emoji" src="${esc(part.url)}" alt=":${esc(part.name)}:" title=":${esc(part.name)}:">`,
    )
    .join("");
}
function action(fn: () => Promise<void>) {
  void fn().catch((error) =>
    toast(error.message || "Could not connect. Please try again."),
  );
}
function modal(title: string, content: string) {
  document
    .querySelectorAll("dialog:not([open])")
    .forEach((closed) => closed.remove());
  const dialog = document.createElement("dialog");
  dialog.className = "modal";
  dialog.innerHTML = `<div class="modal-heading"><h2>${esc(title)}</h2><button class="icon-button" aria-label="Close dialog" data-close>${icon("close")}</button></div>${content}`;
  document.body.append(dialog);
  dialog
    .querySelector("[data-close]")!
    .addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) {
      const b = dialog.getBoundingClientRect();
      if (
        e.clientX < b.left ||
        e.clientX > b.right ||
        e.clientY < b.top ||
        e.clientY > b.bottom
      )
        dialog.close();
    }
  });
  dialog.addEventListener("close", () => dialog.remove());
  dialog.showModal();
  return dialog;
}
function form(
  dialog: HTMLDialogElement,
  fn: (data: FormData) => Promise<void>,
  selector = "form",
) {
  const element = dialog.querySelector<HTMLFormElement>(selector)!;
  element.addEventListener("submit", async (e) => {
    e.preventDefault();
    const button = element.querySelector<HTMLButtonElement>("[type=submit]")!;
    button.disabled = true;
    const error = element.querySelector<HTMLElement>(".form-error")!;
    error.textContent = "";
    try {
      await fn(new FormData(element));
    } catch (err) {
      error.textContent = (err as Error).message;
    } finally {
      button.disabled = false;
    }
  });
}
function renderLogin() {
  current = null;
  channels = [];
  messages = [];
  generation++;
  app.innerHTML = `<main class="welcome"><div class="welcome-top"><a class="brand" href="/">${brand}</a><span class="instance-label"><span class="status-dot"></span>${esc(session.instance)}</span></div>
    <div class="welcome-main"><div class="eyebrow">YOUR LITTLE CORNER OF THE INTERNET</div><h1>Good conversations.<br><span>Connected communities.</span></h1><p>A place to gather, follow a thread, and stay in touch.<br>Welcome to Archipel.</p>
    <div class="signin-card"><div class="card-eyebrow">COME ON IN</div><h2>Make yourself at home.</h2>
    ${session.oidc_enabled ? `<a class="primary signin-link" href="/auth/login">Sign in with your identity ${icon("arrow")}</a>` : ""}
    ${session.dev_auth ? `<div class="dev-notice">Local development · choose a test account</div><div class="persona-list">${["alice", "bob", "charlie"].map((name) => `<button data-persona="${name}">${avatar({ id: "", username: name, display_name: name, verified_socials: [] })}<span>${name}<small>${name === "alice" ? "Instance administrator" : "Community member"}</small></span>${icon("arrow")}</button>`).join("")}</div>` : ""}
    ${!session.oidc_enabled && !session.dev_auth ? '<p class="empty-copy">Sign-in is not configured for this instance yet.</p>' : ""}
    <p class="signin-footnote">${session.registration_mode === "invite_only" ? "This instance requires approval. After sign-in, administrators can review your identity and any verified socials you choose to share with Archipel through FedIdP." : "Your identity has a home. So do your conversations."}</p></div></div><footer>Small islands. Shared horizons.</footer></main>`;
  document
    .querySelectorAll<HTMLButtonElement>("[data-persona]")
    .forEach((button) =>
      button.addEventListener("click", () =>
        action(async () => {
          button.disabled = true;
          try {
            await api("/dev-login", "POST", {
              username: button.dataset.persona,
            });
            await boot();
          } finally {
            button.disabled = false;
          }
        }),
      ),
    );
  if (new URLSearchParams(location.search).get("signin") === "failed") {
    toast("Sign-in could not be completed. Please try again.");
    history.replaceState(null, "", "/");
  }
}
function renderAdmission() {
  current = null;
  channels = [];
  messages = [];
  customEmojis = [];
  generation++;
  const rejected = session.user!.admission_status === "rejected";
  app.innerHTML = `<main class="admission-screen"><a class="brand" href="/">${brand}</a><div class="signin-card"><h1>${rejected ? "Membership was declined" : "Waiting for approval"}</h1><p>You’re signed in as @${esc(session.user!.username)} at ${esc(session.instance)}.</p><p>${rejected ? "An instance administrator has declined your application. Contact the instance administrators if you want them to reconsider." : "An instance administrator will review your application before you can access conversations. This page updates when you are approved."}</p><h3>Verified socials shared with administrators</h3>${socialsHtml(session.user!.verified_socials)}<p>Your provider supplies these claims. You can change what you share in FedIdP and sign in again to refresh them.</p><button id="admission-signout" class="quiet-button">Sign out</button></div></main>`;
  $("#admission-signout").addEventListener("click", () =>
    action(async () => {
      await api("/logout", "POST", {});
      await boot();
    }),
  );
}
function socialsHtml(socials: unknown[]) {
  if (!socials.length)
    return '<p class="empty-copy">No verified socials were shared by the identity provider.</p>';
  return `<div class="verified-social-list">${socials
    .map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value))
        return `<div class="verified-social">${esc(JSON.stringify(value))}</div>`;
      const claim = value as Record<string, unknown>;
      const handle =
        typeof claim.handle === "string"
          ? claim.handle
          : typeof claim.subject === "string"
            ? claim.subject
            : "Verified account";
      const provider =
        typeof claim.provider === "string"
          ? claim.provider
          : "Identity provider";
      let profile = "";
      if (typeof claim.profile === "string") {
        try {
          const url = new URL(claim.profile);
          if (url.protocol === "https:" && !url.username && !url.password)
            profile = url.href;
        } catch {
          /* A malformed profile URL is displayed without a link. */
        }
      }
      return `<div class="verified-social"><strong>${esc(handle)}</strong><span>${esc(provider)}${typeof claim.domain === "string" ? ` · ${esc(claim.domain)}` : ""}</span>${profile ? `<a href="${esc(profile)}" target="_blank" rel="noopener noreferrer">View profile ↗</a>` : ""}</div>`;
    })
    .join("")}</div>`;
}
function renderShell() {
  app.innerHTML = `<div class="workspace"><aside class="sidebar"><a class="brand" href="/">${brand}</a><button id="close-sidebar" class="icon-button mobile-only" aria-label="Close channels">${icon("close")}</button><div class="instance-block"><span class="island-icon">a</span><div><strong>Our archipelago</strong><span>${esc(session.instance)}</span></div><span class="status-dot"></span></div>
    <button id="browse" class="browse-button">${icon("search")}<span>Explore channels</span><span class="key-hint">↗</span></button><div class="sidebar-label"><span>YOUR CHANNELS</span><button id="new-channel" class="icon-button" aria-label="Create channel">${icon("plus")}</button></div><nav id="channel-list" aria-label="Your channels"></nav>
    <div class="sidebar-bottom"><div class="local-label"><span class="status-dot"></span><span id="connection-status">Connected to your instance</span></div>${session.dev_auth ? '<span class="dev-badge">LOCAL DEVELOPMENT</span>' : ""}
    <button id="profile" class="profile-button">${avatar(session.user!)}<span><strong>${esc(session.user!.display_name)}</strong><small>@${esc(session.user!.username)}</small></span>${icon("settings")}</button></div></aside>
    <main class="conversation"><header class="channel-header"><button id="mobile-menu" class="icon-button mobile-only" aria-label="Show channels">${icon("menu")}</button><div id="channel-heading"></div><div class="header-actions"><button id="members" class="quiet-button" disabled>${icon("people")}<span id="member-count">Members</span></button><button id="channel-settings" class="icon-button" aria-label="Channel settings" disabled>${icon("settings")}</button></div></header>
    <div id="topic-bar" class="topic-bar hidden"></div><div id="message-list" class="message-list" role="log" aria-label="Conversation" aria-live="polite"></div><div id="composer-area"></div><footer class="conversation-footer"><span>Find your people. Keep the conversation going.</span><span>archipel / ${esc(session.instance)}</span></footer></main></div>`;
  $("#browse").addEventListener("click", () => browse());
  $("#new-channel").addEventListener("click", createChannel);
  $("#profile").addEventListener("click", profile);
  $("#members").addEventListener("click", members);
  $("#channel-settings").addEventListener("click", () => action(settings));
  $("#mobile-menu").addEventListener("click", () =>
    $(".sidebar").classList.toggle("mobile-open"),
  );
  $("#close-sidebar").addEventListener("click", () =>
    $(".sidebar").classList.remove("mobile-open"),
  );
  renderSidebar();
  renderEmpty();
}
app.addEventListener("click", (event) => {
  const target = event.target as Element;
  if (!target.closest(".sidebar") && !target.closest("#mobile-menu"))
    document.querySelector(".sidebar")?.classList.remove("mobile-open");
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape")
    document.querySelector(".sidebar")?.classList.remove("mobile-open");
});
function renderSidebar() {
  const joined = channels.filter((c) => c.role);
  $("#channel-list").innerHTML = joined.length
    ? joined
        .map(
          (c) =>
            `<button class="channel-link ${current?.id === c.id ? "active" : ""}" data-channel="${esc(c.id)}"><span class="channel-symbol">${icon(c.visibility === "members" ? "lock" : "hash")}</span><span>${esc(c.name)}</span>${c.mode !== "timeline" ? `<span class="mode-dot" title="${modeLabel(c.mode)}">${c.mode === "topical" ? "◦" : "≋"}</span>` : ""}</button>`,
        )
        .join("")
    : '<p class="sidebar-empty">Your channels will appear here.<br>Start one or explore an island.</p>';
  document
    .querySelectorAll<HTMLButtonElement>("[data-channel]")
    .forEach((button) =>
      button.addEventListener("click", () =>
        action(() => selectChannel(button.dataset.channel!)),
      ),
    );
}
function renderEmpty() {
  $("#channel-heading").innerHTML =
    "<strong>Your conversations</strong><span>A little space to connect</span>";
  $("#message-list").innerHTML =
    `<div class="empty-state"><div class="islands" aria-hidden="true"><i></i><i></i><i></i></div><div class="eyebrow">A NEW HORIZON</div><h2>Every community starts<br>with a conversation.</h2><p>Create a channel for your people,<br>or explore what’s happening nearby.</p><button id="empty-create" class="primary">${icon("plus")} Create a channel</button><button id="empty-browse" class="text-button">Explore channels ${icon("arrow")}</button></div>`;
  $("#composer-area").innerHTML = "";
  $("#empty-create").addEventListener("click", createChannel);
  $("#empty-browse").addEventListener("click", () => browse());
}
async function selectChannel(id: string) {
  const token = ++generation;
  const [detail, page] = await Promise.all([
    api<Channel>(`/channels/${id}`),
    api<{ messages: Message[]; older_cursor: number | null }>(
      `/channels/${id}/messages`,
    ),
  ]);
  if (generation !== token) return;
  current = detail;
  messages = page.messages;
  olderCursor = page.older_cursor;
  reply = null;
  currentTopic = detail.topics?.[0]?.id || null;
  lastMessageSignature = "";
  localStorage.setItem("archipel-channel", id);
  $(".sidebar").classList.remove("mobile-open");
  renderSidebar();
  renderHeader();
  renderTopics();
  renderMessages(true);
  renderComposer();
}
function renderHeader() {
  if (!current) return;
  $("#channel-heading").innerHTML =
    `<div class="channel-title">${icon(current.visibility === "members" ? "lock" : "hash")}<strong>${esc(current.name)}</strong><span class="mode-badge">${modeLabel(current.mode)}</span></div><span>${esc(current.description || `#${current.name}@${session.instance}`)}</span>`;
  $("#member-count").textContent =
    `${current.member_count} member${current.member_count === 1 ? "" : "s"}`;
  $<HTMLButtonElement>("#members").disabled = false;
  $<HTMLButtonElement>("#channel-settings").disabled = !(
    !current.remote_actor &&
    (session.user?.admin || ["owner", "moderator"].includes(current.role || ""))
  );
}
function renderTopics() {
  const bar = $("#topic-bar");
  if (current?.mode !== "topical") {
    bar.classList.add("hidden");
    return;
  }
  bar.classList.remove("hidden");
  bar.innerHTML = `<span>TOPIC</span><select id="topic-select" aria-label="Conversation topic"><option value="" ${!currentTopic ? "selected" : ""}>Choose a topic</option>${(current.topics || []).map((t) => `<option value="${t.id}" ${currentTopic === t.id ? "selected" : ""}>${esc(t.title)}</option>`).join("")}</select>${current.role && !current.remote_actor ? `<button id="new-topic" class="text-button">${icon("plus")} New topic</button>` : ""}`;
  $("#topic-select").addEventListener("change", (e) => {
    currentTopic = (e.target as HTMLSelectElement).value || null;
    reply = null;
    renderMessages(true);
    renderComposer();
  });
  document.querySelector("#new-topic")?.addEventListener("click", newTopic);
}
function renderMessages(scroll = false) {
  if (!current) return;
  const list = $("#message-list"),
    atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 100;
  const oldHeight = list.scrollHeight,
    oldTop = list.scrollTop;
  const relevant =
    current.mode === "topical"
      ? messages.filter((m) => m.topic_id === currentTopic)
      : messages;
  const canModerate =
    !current.remote_actor &&
    (session.user?.admin ||
      ["owner", "moderator"].includes(current.role || ""));
  function message(m: Message, depth = 0): string {
    const time = new Date(m.created_at).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    const parent = m.parent_id
      ? messages.find((p) => p.id === m.parent_id)
      : null;
    return `<article class="message depth-${Math.min(depth, 3)} ${m.deleted_at ? "deleted-message" : ""}" data-message="${m.id}">${avatar(m)}<div class="message-content"><div class="message-meta"><strong>${esc(m.display_name)}</strong><span>@${esc(m.username)}</span><time datetime="${m.created_at}" title="${esc(new Date(m.created_at).toLocaleString())}">${esc(time)}</time>${m.edited_at && !m.deleted_at ? `<span title="${esc(new Date(m.edited_at).toLocaleString())}">(edited)</span>` : ""}</div>${parent ? `<div class="reply-context">${icon("reply")} replying to ${esc(parent.display_name)}</div>` : m.parent_id ? '<div class="reply-context">Reply to an earlier message</div>' : ""}
      ${m.title ? `<h3 class="thread-title">${emojiHtml(m.title, m.emojis || [])}</h3>` : ""}<div class="message-body">${m.deleted_at ? "<em>This message was removed.</em>" : emojiHtml(m.body, m.emojis || [])}</div></div><div class="message-actions">${current!.role && !m.deleted_at && current!.mode !== "timeline" ? `<button class="icon-button reply-button" data-id="${m.id}" aria-label="Reply to ${esc(m.display_name)}">${icon("reply")}</button>` : ""}${!m.deleted_at && current!.role && m.author_id === session.user?.id ? `<button class="icon-button edit-button" data-id="${m.id}" aria-label="Edit message">✎</button>` : ""}${!m.deleted_at && (m.author_id === session.user?.id || canModerate) ? `<button class="icon-button delete-button" data-id="${m.id}" aria-label="Remove message">${icon("trash")}</button>` : ""}</div></article>`;
  }
  let content = "";
  if (current.mode === "threaded") {
    const ids = new Set(relevant.map((m) => m.id));
    const children = new Map<string, Message[]>();
    relevant.forEach((m) => {
      if (m.parent_id && ids.has(m.parent_id))
        children.set(m.parent_id, [...(children.get(m.parent_id) || []), m]);
    });
    const tree = (m: Message, depth: number): string =>
      message(m, depth) +
      (children.get(m.id) || [])
        .map((child) => tree(child, depth + 1))
        .join("");
    content = relevant
      .filter((m) => !m.parent_id || !ids.has(m.parent_id))
      .map((m) => `<div class="thread-group">${tree(m, 0)}</div>`)
      .join("");
  } else {
    let day = "";
    content = relevant
      .map((m) => {
        const label = new Date(m.created_at).toLocaleDateString([], {
          weekday: "long",
          month: "short",
          day: "numeric",
        });
        const divider =
          label !== day
            ? `<div class="day-divider"><span>${esc(label)}</span></div>`
            : "";
        day = label;
        return divider + message(m);
      })
      .join("");
  }
  list.innerHTML = `${olderCursor ? '<button id="older-messages" class="older-button">Load earlier messages</button>' : ""}<div class="channel-intro"><span class="intro-symbol">${icon("hash")}</span><h2>${esc(current.name)}</h2><p>${esc(current.description || "This is the beginning of something good.")}</p><span>${current.visibility === "members" ? "Members only" : "Public channel"} <b>·</b> ${modeLabel(current.mode)} <b>·</b> #${esc(current.name)}@${esc(session.instance)}</span></div>${content || `<div class="conversation-empty">${icon("chat")}<p>${current.mode === "topical" && !currentTopic ? "Choose or create a topic to get started." : "A quiet island, for now. Say hello."}</p></div>`}`;
  list.querySelectorAll<HTMLButtonElement>(".reply-button").forEach((button) =>
    button.addEventListener("click", () => {
      reply = messages.find((m) => m.id === button.dataset.id)!;
      renderComposer();
      $("#message-body").focus();
    }),
  );
  list
    .querySelectorAll<HTMLButtonElement>(".edit-button")
    .forEach((button) =>
      button.addEventListener("click", () => editMessage(button.dataset.id!)),
    );
  list
    .querySelectorAll<HTMLButtonElement>(".delete-button")
    .forEach((button) =>
      button.addEventListener("click", () => deleteMessage(button.dataset.id!)),
    );
  document.querySelector("#older-messages")?.addEventListener("click", () =>
    action(async () => {
      const id = current!.id,
        token = generation;
      const page = await api<{
        messages: Message[];
        older_cursor: number | null;
      }>(`/channels/${id}/messages?before=${olderCursor}`);
      if (token !== generation) return;
      messages = [...page.messages, ...messages];
      olderCursor = page.older_cursor;
      renderMessages();
    }),
  );
  if (scroll || atBottom) list.scrollTop = list.scrollHeight;
  else list.scrollTop = oldTop + Math.max(0, list.scrollHeight - oldHeight);
}
function renderComposer() {
  const area = $("#composer-area");
  if (!current) {
    area.innerHTML = "";
    return;
  }
  if (!current.role) {
    area.innerHTML = `<div class="join-bar"><div><strong>You’re looking around ${esc(current.name)}.</strong><p>${current.can_join ? "Join the channel to become part of the conversation." : "This channel requires an invitation from a moderator."}</p></div>${current.can_join ? '<button id="join-channel" class="primary">Join channel</button>' : ""}</div>`;
    document.querySelector("#join-channel")?.addEventListener("click", () =>
      action(async () => {
        const id = current!.id;
        await api(`/channels/${id}/join`, "POST", {});
        await refreshChannels();
        await selectChannel(id);
      }),
    );
    return;
  }
  if (
    current.federation_enabled &&
    (!session.federation_enabled ||
      !session.user?.federation_send ||
      !session.user?.federation_post)
  ) {
    area.innerHTML =
      '<div class="composer-hint">Your administrator must enable sending and posting in federated channels before you can write here.</div>';
    return;
  }
  if (current.mode === "topical" && !currentTopic) {
    area.innerHTML =
      '<div class="composer-hint">Create or choose a topic above to start talking.</div>';
    return;
  }
  area.innerHTML = `<form id="composer" class="composer">${reply ? `<div class="reply-banner">${icon("reply")} Replying to <strong>${esc(reply.display_name)}</strong><button type="button" id="cancel-reply" class="icon-button" aria-label="Cancel reply">${icon("close")}</button></div>` : ""}
    ${current.mode === "threaded" && !reply ? '<input id="thread-title" class="thread-input" maxlength="160" placeholder="Give your new thread a title…" aria-label="Thread title" required>' : ""}<div class="composer-main"><textarea id="message-body" maxlength="8000" rows="2" placeholder="${reply ? `Reply to ${esc(reply.display_name)}…` : `Message #${esc(current.name)}…`}" aria-label="Message" required></textarea><button id="send-message" class="send-button" type="submit" aria-label="Send message">${icon("send")}</button></div><div class="composer-note"><button type="button" id="choose-emoji" class="text-button" aria-label="Choose emoji">☺ Emoji</button><span>${current.mode === "threaded" ? (reply ? "Keep the thread going." : "Start a conversation worth following.") : "A little hello goes a long way."}</span><span><kbd>Enter</kbd> to send · <kbd>Shift + Enter</kbd> for a new line</span></div></form>`;
  document.querySelector("#cancel-reply")?.addEventListener("click", () => {
    reply = null;
    renderComposer();
  });
  $("#choose-emoji").addEventListener("click", () =>
    chooseEmoji($<HTMLTextAreaElement>("#message-body")),
  );
  $("#message-body").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $<HTMLFormElement>("#composer").requestSubmit();
    }
  });
  $("#composer").addEventListener("submit", (e) => {
    e.preventDefault();
    action(async () => {
      const body = $<HTMLTextAreaElement>("#message-body"),
        title = document.querySelector<HTMLInputElement>("#thread-title");
      if (!body.value.trim() || (title && !title.value.trim())) return;
      const button = $<HTMLButtonElement>("#send-message");
      if (button.disabled) return;
      button.disabled = true;
      const id = current!.id,
        token = generation;
      try {
        const message = await api<Message>(`/channels/${id}/messages`, "POST", {
          body: body.value,
          ...(title ? { title: title.value } : {}),
          ...(reply ? { parent_id: reply.id } : {}),
          ...(currentTopic ? { topic_id: currentTopic } : {}),
        });
        if (generation !== token) return;
        if (message.queued) {
          reply = null;
          renderComposer();
          toast("Message queued for delivery to the channel’s home instance.");
          return;
        }
        messages = [
          ...messages.filter((m) => m.id !== message.id),
          message,
        ].sort((a, b) => a.seq - b.seq);
        reply = null;
        renderMessages(true);
        renderComposer();
        $("#message-body").focus();
      } finally {
        button.disabled = false;
      }
    });
  });
}
function createChannel() {
  const dialog = modal(
    "Find a home for your conversation",
    `<p class="modal-copy">A new channel is a new island. Give yours a name.</p><form><label>Channel name<div class="input-prefix"><span>#</span><input name="name" required minlength="2" maxlength="40" pattern="[a-zA-Z0-9][a-zA-Z0-9_-]{1,39}" placeholder="e.g. the-living-room" autofocus></div></label><label>Description<textarea name="description" maxlength="500" rows="2" placeholder="What brings everyone here?"></textarea></label>
    <label>Conversation style<select name="mode"><option value="timeline">Timeline — one flowing conversation</option><option value="topical">Topics — conversations organized by subject</option><option value="threaded">Threads — posts with nested replies</option></select></label>
    <div class="form-row"><label>Who can read?<select name="visibility"><option value="public">Everyone on this instance</option><option value="members">Members only</option></select></label><label>Who can join?<select name="admission"><option value="open">Anyone on this instance</option><option value="allowlist">Invited users only</option></select></label></div><p class="form-error" role="alert"></p><button type="submit" class="primary full">Create channel ${icon("arrow")}</button></form>`,
  );
  form(dialog, async (data) => {
    const channel = await api<Channel>(
      "/channels",
      "POST",
      Object.fromEntries(data),
    );
    dialog.close();
    await refreshChannels();
    await selectChannel(channel.id);
  });
}
function browse() {
  const dialog = modal(
    "Explore the archipelago",
    `<p class="modal-copy">Find a conversation that feels like home.</p><label class="search-field">${icon("search")}<input id="channel-search" placeholder="Find a channel…" aria-label="Search channels" autofocus></label><div id="browse-list" class="browse-list"></div>`,
  );
  const list = dialog.querySelector("#browse-list")!;
  function draw(query = "") {
    const visible = channels.filter(
      (c) =>
        c.name.includes(query.toLowerCase()) ||
        c.description.toLowerCase().includes(query.toLowerCase()),
    );
    list.innerHTML = visible.length
      ? visible
          .map(
            (c) =>
              `<button class="browse-channel" data-id="${c.id}"><span class="intro-symbol">${icon(c.visibility === "members" ? "lock" : "hash")}</span><span><strong>${esc(c.name)}</strong><p>${esc(c.description || modeLabel(c.mode))}</p><small>${c.member_count} members · ${modeLabel(c.mode)}${c.role ? " · Joined" : ""}${!c.readable ? " · Invitation available" : ""}</small></span>${icon("arrow")}</button>`,
          )
          .join("")
      : '<p class="empty-copy">No channels here yet. Create the first one.</p>';
    list.querySelectorAll<HTMLButtonElement>("[data-id]").forEach((button) =>
      button.addEventListener("click", () =>
        action(async () => {
          const channel = channels.find((c) => c.id === button.dataset.id)!;
          if (!channel.readable && channel.can_join)
            await api(`/channels/${channel.id}/join`, "POST", {});
          await selectChannel(channel.id);
          dialog.close();
          await refreshChannels();
        }),
      ),
    );
  }
  draw();
  dialog
    .querySelector("input")!
    .addEventListener("input", (e) =>
      draw((e.target as HTMLInputElement).value),
    );
}
function newTopic() {
  const id = current!.id;
  const dialog = modal(
    "Start a new topic",
    '<form><label>Topic title<input name="title" maxlength="100" placeholder="What are we talking about?" required autofocus></label><p class="form-error" role="alert"></p><button type="submit" class="primary full">Create topic</button></form>',
  );
  form(dialog, async (data) => {
    const topic = await api<Topic>(`/channels/${id}/topics`, "POST", {
      title: data.get("title"),
    });
    dialog.close();
    current = await api<Channel>(`/channels/${id}`);
    currentTopic = topic.id;
    reply = null;
    renderTopics();
    renderMessages(true);
    renderComposer();
  });
}
function members() {
  if (!current) return;
  modal(
    `The people in #${current.name}`,
    `<p class="modal-copy">${current.member_count} people sharing this little island.</p><div class="member-list">${(current.members || []).map((u) => `<div class="member-row">${avatar(u)}<div><strong>${esc(u.display_name)}</strong><span>@${esc(u.username)}</span>${u.verified_socials.length ? `<small class="social-claims">Shared socials: ${esc(JSON.stringify(u.verified_socials))}</small>` : ""}</div><span class="role-badge">${esc(u.role)}</span></div>`).join("")}</div>${current.role && current.role !== "owner" ? '<button id="leave-channel" class="danger-text">Leave this channel</button>' : ""}`,
  );
  document.querySelector("#leave-channel")?.addEventListener("click", () =>
    action(async () => {
      await api(`/channels/${current!.id}/leave`, "POST", {});
      document.querySelector<HTMLDialogElement>("dialog")!.close();
      current = null;
      messages = [];
      generation++;
      await refreshChannels();
      renderShell();
    }),
  );
}
async function settings() {
  if (!current) return;
  const channel = current,
    id = current.id;
  const [users, rules] = await Promise.all([
    api<User[]>("/users"),
    api<{ user_id: string; rule: string; username: string }[]>(
      `/channels/${id}/rules`,
    ),
  ]);
  const dialog = modal(
    `Manage #${channel.name}`,
    `<p class="modal-copy">${channel.visibility === "members" ? "Members-only" : "Public"} · ${channel.admission === "allowlist" ? "Invitation required" : "Open membership"} · ${modeLabel(channel.mode)}</p>
    <form><label>Person<select name="user">${users
      .filter((u) => u.id !== channel.owner_id)
      .map((u) => `<option value="${u.id}">@${esc(u.username)}</option>`)
      .join(
        "",
      )}</select></label><label>Action<select name="action"><option value="allow">Allow to join</option><option value="block">Block and remove membership</option><option value="clear">Clear access rule</option><option value="remove">Remove membership</option>${session.user?.admin || channel.role === "owner" ? '<option value="moderator">Make moderator</option><option value="member">Make member</option>' : ""}</select></label><p class="form-error" role="alert"></p><button type="submit" class="primary full">Apply change</button></form>
    <button id="channel-federation" class="quiet-button">Federation and remote followers</button><h3 class="list-title">Access rules</h3><div class="rules-list">${rules.length ? rules.map((r) => `<div><span>@${esc(r.username)}</span><span class="role-badge ${r.rule === "block" ? "blocked" : ""}">${esc(r.rule)}</span></div>`).join("") : '<p class="empty-copy">No individual access rules.</p>'}</div>`,
  );
  dialog.querySelector("#channel-federation")!.addEventListener("click", () =>
    action(async () => {
      dialog.close();
      await channelFederation(channel);
    }),
  );
  form(dialog, async (data) => {
    const selected = data.get("action") as string;
    await api(
      `/channels/${id}/members/${data.get("user")}`,
      "PATCH",
      ["moderator", "member"].includes(selected)
        ? { role: selected }
        : selected === "remove"
          ? { remove: true }
          : { rule: selected },
    );
    dialog.close();
    await refreshCurrent();
    await refreshChannels();
    toast("Channel permissions updated.");
  });
}
function chooseEmoji(target: HTMLTextAreaElement) {
  const start = target.selectionStart,
    end = target.selectionEnd;
  const dialog = modal(
    "Choose an emoji",
    '<label>Search emoji<input id="emoji-search" placeholder="Try smile, heart, or a custom name" autofocus></label><div id="emoji-results" class="emoji-results"></div>',
  );
  function draw(query = "") {
    const names = [...customEmojis.map((e) => e.name), ...standardEmojis.keys()]
      .filter((name) => name.includes(query.toLowerCase()))
      .slice(0, 80);
    const list = dialog.querySelector("#emoji-results")!;
    list.innerHTML = names.length
      ? names
          .map(
            (name) =>
              `<button type="button" class="quiet-button" data-emoji="${esc(name)}">${emojiHtml(`:${name}:`)} <span>:${esc(name)}:</span></button>`,
          )
          .join("")
      : "<p>No matching emoji.</p>";
    list.querySelectorAll<HTMLButtonElement>("[data-emoji]").forEach((button) =>
      button.addEventListener("click", () => {
        target.setRangeText(`:${button.dataset.emoji}:`, start, end, "end");
        target.dispatchEvent(new Event("input", { bubbles: true }));
        dialog.close();
        target.focus();
      }),
    );
  }
  draw();
  dialog
    .querySelector("input")!
    .addEventListener("input", (e) =>
      draw((e.target as HTMLInputElement).value),
    );
}
function editMessage(id: string) {
  const message = messages.find((m) => m.id === id)!;
  const dialog = modal(
    "Edit your message",
    `<form>${message.title !== null ? `<label>Thread title<input name="title" maxlength="160" value="${esc(message.title)}" required></label>` : ""}<label>Message<textarea name="body" rows="5" maxlength="8000" required>${esc(message.body)}</textarea></label><p class="modal-copy">Use :smile: or any instance emoji shortcode.</p><p class="form-error" role="alert"></p><button type="submit" class="primary full">Save changes</button></form>`,
  );
  form(dialog, async (data) => {
    await api(`/messages/${id}`, "PATCH", {
      body: data.get("body"),
      ...(message.title !== null ? { title: data.get("title") } : {}),
      expected_edited_at: message.edited_at,
    });
    dialog.close();
    await refreshCurrent();
  });
}
function deleteMessage(id: string) {
  const dialog = modal(
    "Remove this message?",
    '<p class="modal-copy">The message will be replaced with a removed-message marker. Replies will stay in the conversation.</p><form><p class="form-error" role="alert"></p><button type="submit" class="danger full">Remove message</button></form>',
  );
  form(dialog, async () => {
    await api(`/messages/${id}`, "DELETE");
    dialog.close();
    await refreshCurrent();
  });
}
function profile() {
  const u = session.user!;
  const dialog = modal(
    "Your corner of Archipel",
    `<div class="profile-heading">${avatar(u)}<div><strong>@${esc(u.username)}</strong><span>${esc(session.instance)}</span></div></div><form><label>Display name<input name="display_name" maxlength="80" value="${esc(u.display_name)}" required></label><label class="checkbox-label"><input type="checkbox" name="share_socials" ${u.share_socials ? "checked" : ""}><span>Share verified socials with other members<small>Your login works whether you share or not.</small></span></label>${u.verified_socials.length ? `<div class="social-claims">${esc(JSON.stringify(u.verified_socials))}</div>` : '<p class="empty-copy">No verified socials were shared by your identity provider.</p>'}<p class="form-error" role="alert"></p><button class="primary full" type="submit">Save profile</button></form><div class="profile-options"><button id="personal-emoji-panel" class="quiet-button" aria-label="Your emoji">☺ Your emoji</button><button id="federated-panel" class="quiet-button">${icon("chat")} Federated conversations</button>${u.admin ? `<button id="admin-panel" class="quiet-button">${icon("settings")} Instance administration</button>` : ""}<button id="sign-out" class="quiet-button">${icon("logout")} Sign out</button></div>`,
  );
  form(dialog, async (data) => {
    session.user = await api<User>("/profile", "PATCH", {
      display_name: data.get("display_name"),
      share_socials: data.get("share_socials") === "on",
    });
    dialog.close();
    $("#profile").innerHTML =
      `${avatar(session.user)}<span><strong>${esc(session.user.display_name)}</strong><small>@${esc(session.user.username)}</small></span>${icon("settings")}`;
    toast("Profile saved.");
    await refreshCurrent();
  });
  dialog.querySelector("#personal-emoji-panel")?.addEventListener("click", () =>
    action(async () => {
      dialog.close();
      await personalEmojis();
    }),
  );
  dialog.querySelector("#federated-panel")?.addEventListener("click", () =>
    action(async () => {
      dialog.close();
      await federatedConversations();
    }),
  );
  dialog.querySelector("#sign-out")?.addEventListener("click", () =>
    action(async () => {
      await api("/logout", "POST", {});
      dialog.close();
      await boot();
    }),
  );
  dialog.querySelector("#admin-panel")?.addEventListener("click", () =>
    action(async () => {
      dialog.close();
      await admin();
    }),
  );
}
async function imageBase64(file: File) {
  if (!file.size || file.size > 262144)
    throw new Error("Choose an image up to 256 KiB.");
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = () => reject(new Error("Could not read image."));
    reader.readAsDataURL(file);
  });
}
async function personalEmojis() {
  const saved =
    await api<(CustomEmoji & { source_url: string })[]>("/personal-emojis");
  const dialog = modal(
    "Your emoji",
    `<p class="modal-copy">Upload your own emoji or copy one from another instance. Your shortcodes are personal; other readers see the emoji you used in a message.</p>
    <h3>Upload an emoji</h3><form id="personal-upload"><label>Personal shortcode<input name="name" required maxlength="64" pattern="[a-z0-9][a-z0-9_-]*" placeholder="my_wave"></label><label>Personal emoji image<input name="image" type="file" accept="image/png,image/jpeg,image/gif,image/webp" required></label><p class="modal-copy">PNG, JPEG, GIF or WebP · up to 256 KiB</p><p class="form-error" role="alert"></p><button type="submit" class="primary full">Upload personal emoji</button></form>
    <h3 class="list-title">Adopt from another instance</h3><form id="personal-adopt"><label>Remote instance URL<input name="instance" type="url" placeholder="https://chat.example.org" required></label><button type="button" id="load-source-emojis" class="quiet-button">Load instance emoji</button><label>Remote emoji<select name="source_name" required><option value="">Load a catalog above</option></select></label><label>Save as shortcode<input name="name" required maxlength="64" pattern="[a-z0-9][a-z0-9_-]*"></label><p class="form-error" role="alert"></p><button type="submit" class="primary full">Adopt emoji</button></form>
    <h3 class="list-title">Saved emoji</h3><div class="personal-emoji-list">${saved.length ? saved.map((e) => `<div>${emojiHtml(`:${e.name}:`, [e])}<span>:${esc(e.name)}:</span><button class="quiet-button" data-rename-emoji="${e.id}">Rename</button><button class="quiet-button danger-text" data-delete-personal="${e.id}">Remove</button></div>`).join("") : '<p class="empty-copy">You have no personal emoji yet.</p>'}</div>`,
  );
  async function refresh() {
    customEmojis = await api<CustomEmoji[]>("/emojis");
    dialog.close();
    await personalEmojis();
  }
  form(
    dialog,
    async (data) => {
      await api("/personal-emojis", "POST", {
        name: data.get("name"),
        image: await imageBase64(data.get("image") as File),
      });
      await refresh();
    },
    "#personal-upload",
  );
  form(
    dialog,
    async (data) => {
      await api("/personal-emojis/adopt", "POST", Object.fromEntries(data));
      await refresh();
    },
    "#personal-adopt",
  );
  dialog.querySelector("#load-source-emojis")!.addEventListener("click", () => {
    const form = dialog.querySelector<HTMLFormElement>("#personal-adopt")!;
    const button = form.querySelector<HTMLButtonElement>("button")!,
      error = form.querySelector<HTMLElement>(".form-error")!;
    void (async () => {
      button.disabled = true;
      error.textContent = "";
      try {
        const catalog = await api<{ name: string }[]>(
          `/emoji-sources?instance=${encodeURIComponent(new FormData(form).get("instance") as string)}`,
        );
        form.querySelector("select")!.innerHTML = catalog.length
          ? catalog
              .map(
                (e) =>
                  `<option value="${esc(e.name)}">:${esc(e.name)}:</option>`,
              )
              .join("")
          : '<option value="">No instance emoji available</option>';
        form.querySelector<HTMLInputElement>('input[name="name"]')!.value =
          catalog[0]?.name || "";
      } catch (e) {
        error.textContent = (e as Error).message;
      } finally {
        button.disabled = false;
      }
    })();
  });
  dialog
    .querySelectorAll<HTMLButtonElement>("[data-delete-personal]")
    .forEach((button) =>
      button.addEventListener("click", () =>
        action(async () => {
          await api(
            `/personal-emojis/${button.dataset.deletePersonal}`,
            "DELETE",
          );
          await refresh();
        }),
      ),
    );
  dialog
    .querySelectorAll<HTMLButtonElement>("[data-rename-emoji]")
    .forEach((button) =>
      button.addEventListener("click", () => {
        const emoji = saved.find((e) => e.id === button.dataset.renameEmoji)!;
        dialog.close();
        const rename = modal(
          "Rename your emoji",
          `<form><label>New shortcode<input name="name" value="${esc(emoji.name)}" required maxlength="64" pattern="[a-z0-9][a-z0-9_-]*"></label><p class="modal-copy">Older messages keep their original emoji.</p><p class="form-error" role="alert"></p><button type="submit" class="primary full">Save shortcode</button></form>`,
        );
        form(rename, async (data) => {
          await api(`/personal-emojis/${emoji.id}`, "PATCH", {
            name: data.get("name"),
          });
          customEmojis = await api<CustomEmoji[]>("/emojis");
          rename.close();
          await personalEmojis();
        });
      }),
    );
}
const federationFlags = [
  "federation_send",
  "federation_receive",
  "federation_subscribe",
  "federation_post",
] as const;
const federationLabels = [
  "Send federated messages",
  "Receive federated messages",
  "Subscribe to remote channels",
  "Post in federated channels",
];
async function federationAdmin() {
  const [status, users] = await Promise.all([
    api<{
      enabled: boolean;
      blocks: { target: string; kind: string }[];
      recent: { recipient: string; status: string; error: string | null }[];
    }>("/admin/federation"),
    api<User[]>("/users"),
  ]);
  const dialog = modal(
    "Federation controls",
    `<p class="modal-copy">Federation and every user permission start disabled. Local conversations remain available. Permission changes apply to queued deliveries and open browser sessions.</p><form id="federation-enable"><label class="checkbox-label"><input type="checkbox" name="enabled" ${status.enabled ? "checked" : ""}><span>Enable federation for this instance</span></label><p class="form-error" role="alert"></p><button type="submit" class="primary full">Save federation setting</button></form>
    <h3 class="list-title">User permissions</h3><form id="federation-permissions"><label>Local user<select name="user">${users.map((u) => `<option value="${u.id}">@${esc(u.username)}</option>`).join("")}</select></label>${federationFlags.map((flag, index) => `<label class="checkbox-label"><input type="checkbox" name="${flag}"><span>${federationLabels[index]}</span></label>`).join("")}<p class="form-error" role="alert"></p><button type="submit" class="primary full">Save user permissions</button></form>
    <h3 class="list-title">Remote blocks</h3><form id="federation-block"><label>Block type<select name="kind"><option value="instance">Whole instance</option><option value="actor">Remote user or channel actor</option></select></label><label>Remote HTTPS URL<input name="target" type="url" required></label><p class="form-error" role="alert"></p><button type="submit" class="primary full">Block remote target</button></form><div class="rules-list">${status.blocks.map((b) => `<div><span>${esc(b.target)}</span><button class="quiet-button" data-unblock="${esc(b.target)}" data-kind="${b.kind}">Unblock</button></div>`).join("")}</div>
    <h3 class="list-title">Recent deliveries</h3><div class="audit-list">${status.recent.length ? status.recent.map((d) => `<div><strong>${esc(d.status)} · ${esc(d.recipient)}</strong>${d.error ? `<span>${esc(d.error)}</span>` : ""}</div>`).join("") : '<p class="empty-copy">No queued deliveries yet.</p>'}</div>`,
  );
  const permissionForm = dialog.querySelector<HTMLFormElement>(
    "#federation-permissions",
  )!;
  function drawPermissions() {
    const selected = users.find(
      (u) => u.id === new FormData(permissionForm).get("user"),
    );
    federationFlags.forEach((flag) => {
      permissionForm.querySelector<HTMLInputElement>(
        `input[name="${flag}"]`,
      )!.checked = !!selected?.[flag];
    });
  }
  drawPermissions();
  permissionForm
    .querySelector("select")!
    .addEventListener("change", drawPermissions);
  form(
    dialog,
    async (data) => {
      await api("/admin/federation", "PATCH", {
        enabled: data.get("enabled") === "on",
      });
      session = await api<Session>("/session");
      toast("Federation setting saved.");
    },
    "#federation-enable",
  );
  form(
    dialog,
    async (data) => {
      const updated = await api<User>(
        `/admin/users/${data.get("user")}/federation`,
        "PATCH",
        Object.fromEntries(
          federationFlags.map((flag) => [flag, data.get(flag) === "on"]),
        ),
      );
      Object.assign(users.find((u) => u.id === updated.id)!, updated);
      session = await api<Session>("/session");
      toast("Federation permissions saved.");
    },
    "#federation-permissions",
  );
  form(
    dialog,
    async (data) => {
      await api("/admin/federation/blocks", "POST", {
        ...Object.fromEntries(data),
        blocked: true,
      });
      dialog.close();
      await federationAdmin();
    },
    "#federation-block",
  );
  dialog
    .querySelectorAll<HTMLButtonElement>("[data-unblock]")
    .forEach((button) =>
      button.addEventListener("click", () =>
        action(async () => {
          await api("/admin/federation/blocks", "POST", {
            target: button.dataset.unblock,
            kind: button.dataset.kind,
            blocked: false,
          });
          dialog.close();
          await federationAdmin();
        }),
      ),
    );
}
async function channelFederation(channel: Channel) {
  const followers = await api<{ actor: string; status: string }[]>(
    `/channels/${channel.id}/followers`,
  );
  const dialog = modal(
    `Federation for #${channel.name}`,
    `<form><label class="checkbox-label"><input type="checkbox" name="enabled" ${channel.federation_enabled ? "checked" : ""}><span>Allow this channel to federate</span></label><p class="modal-copy">Open channels accept remote subscribers automatically. Invited channels require approval here. Turning federation off stops channel delivery and removes remote admission.</p><p class="form-error" role="alert"></p><button type="submit" class="primary full">Save channel federation</button></form><h3 class="list-title">Remote followers</h3><div class="remote-followers">${followers.length ? followers.map((f) => `<div><strong>${esc(f.actor)}</strong><span>${esc(f.status)}</span><div>${f.status !== "accepted" ? `<button class="quiet-button" data-follower="${esc(f.actor)}" data-decision="accepted">Accept follower</button>` : ""}${f.status !== "blocked" ? `<button class="quiet-button danger-text" data-follower="${esc(f.actor)}" data-decision="blocked">Block follower</button>` : ""}</div></div>`).join("") : '<p class="empty-copy">No remote follows yet.</p>'}</div>`,
  );
  form(dialog, async (data) => {
    await api(`/channels/${channel.id}/federation`, "PATCH", {
      enabled: data.get("enabled") === "on",
    });
    dialog.close();
    if (current?.id === channel.id) {
      await refreshCurrent();
      renderComposer();
    }
    await channelFederation(await api<Channel>(`/channels/${channel.id}`));
  });
  dialog
    .querySelectorAll<HTMLButtonElement>("[data-follower]")
    .forEach((button) =>
      button.addEventListener("click", () =>
        action(async () => {
          await api(`/channels/${channel.id}/followers`, "PATCH", {
            actor: button.dataset.follower,
            status: button.dataset.decision,
          });
          dialog.close();
          await channelFederation(channel);
        }),
      ),
    );
}
async function drawDirectMessages() {
  const list = document.querySelector<HTMLElement>("#federated-direct-list");
  if (!list) return;
  const messages = await api<
    {
      id: string;
      peer: string;
      body: string;
      direction: string;
      created_at: string;
      emojis: CustomEmoji[];
    }[]
  >("/federation/messages");
  list.innerHTML = messages.length
    ? messages
        .map(
          (m) =>
            `<article class="direct-message"><strong>${m.direction === "incoming" ? "From" : "To"} ${esc(m.peer)}</strong><time>${esc(new Date(m.created_at).toLocaleString())}</time><div class="message-body">${emojiHtml(m.body, m.emojis)}</div></article>`,
        )
        .join("")
    : '<p class="empty-copy">No federated direct messages.</p>';
}
async function federatedConversations() {
  const subscriptions = await api<
    { channel_id: string; name: string; status: string }[]
  >("/federation/subscriptions");
  const dialog = modal(
    "Federated conversations",
    `<p class="modal-copy">${session.federation_enabled ? "Your administrator controls which federation actions your account may use." : "Federation is disabled on this instance."}</p><h3>Remote channels</h3><form id="remote-subscribe"><label>Channel address<input name="address" placeholder="#general@chat.example.org or an actor URL" required></label><p class="form-error" role="alert"></p><button type="submit" class="primary full" ${!session.federation_enabled || !session.user?.federation_subscribe || !session.user?.federation_receive ? "disabled" : ""}>Subscribe to channel</button></form><div class="remote-subscriptions">${subscriptions.map((s) => `<div><strong>${esc(s.name)}</strong><span>${esc(s.status)}</span>${s.status === "accepted" ? `<button class="quiet-button" data-open-remote="${s.channel_id}">Open channel</button>` : ""}${["pending", "accepted"].includes(s.status) ? `<button class="quiet-button danger-text" data-unsubscribe="${s.channel_id}">Unsubscribe</button>` : ""}</div>`).join("")}</div><button id="refresh-subscriptions" class="quiet-button">Refresh subscriptions</button>
    <h3 class="list-title">Direct messages</h3><form id="remote-direct"><label>Remote user address<input name="address" placeholder="user@chat.example.org or an actor URL" required></label><label>Direct message<textarea name="body" required maxlength="8000" rows="3"></textarea></label><p class="form-error" role="alert"></p><button type="submit" class="primary full" ${!session.federation_enabled || !session.user?.federation_send ? "disabled" : ""}>Send federated message</button></form><div id="federated-direct-list"></div>`,
  );
  form(
    dialog,
    async (data) => {
      await api("/federation/subscriptions", "POST", Object.fromEntries(data));
      dialog.close();
      await federatedConversations();
    },
    "#remote-subscribe",
  );
  form(
    dialog,
    async (data) => {
      await api("/federation/messages", "POST", Object.fromEntries(data));
      (dialog.querySelector("#remote-direct") as HTMLFormElement).reset();
      await drawDirectMessages();
      toast("Direct message queued for delivery.");
    },
    "#remote-direct",
  );
  dialog
    .querySelector("#refresh-subscriptions")!
    .addEventListener("click", () =>
      action(async () => {
        dialog.close();
        await federatedConversations();
      }),
    );
  dialog
    .querySelectorAll<HTMLButtonElement>("[data-open-remote]")
    .forEach((button) =>
      button.addEventListener("click", () =>
        action(async () => {
          await refreshChannels();
          await selectChannel(button.dataset.openRemote!);
          dialog.close();
        }),
      ),
    );
  dialog
    .querySelectorAll<HTMLButtonElement>("[data-unsubscribe]")
    .forEach((button) =>
      button.addEventListener("click", () =>
        action(async () => {
          await api(
            `/federation/subscriptions/${button.dataset.unsubscribe}`,
            "DELETE",
          );
          dialog.close();
          await refreshChannels();
          await federatedConversations();
        }),
      ),
    );
  await drawDirectMessages();
}
interface Application extends User {
  created_at: string;
  reviewed_at: string | null;
  identities: { issuer: string; subject: string }[];
}
async function admin() {
  const [users, audit, applications, settings, emojis] = await Promise.all([
    api<User[]>("/users"),
    api<
      { action: string; username: string; created_at: string; target: string }[]
    >("/admin/audit"),
    api<Application[]>("/admin/applications"),
    api<{ registration_mode: string }>("/admin/settings"),
    api<CustomEmoji[]>("/admin/emojis"),
  ]);
  customEmojis = await api<CustomEmoji[]>("/emojis");
  const dialog = modal(
    "Instance administration",
    `
    <button id="federation-admin-panel" class="quiet-button">Federation controls</button><h3>Instance membership</h3><form id="registration-form"><label>New user access<select name="registration_mode"><option value="open" ${settings.registration_mode === "open" ? "selected" : ""}>Open — admit new users automatically</option><option value="invite_only" ${settings.registration_mode === "invite_only" ? "selected" : ""}>Invite only — require administrator approval</option></select></label><p class="modal-copy">Existing members keep access. Pending or declined applications still need a decision when registration is opened.</p><p class="form-error" role="alert"></p><button type="submit" class="primary full">Save membership policy</button></form>
    <h3 class="list-title">Membership applications</h3><div class="applications">${applications.length ? applications.map((u) => `<article class="application" data-application="${u.id}"><strong>@${esc(u.username)} · ${esc(u.display_name)}</strong><p>${esc(u.admission_status)} · Applied ${esc(new Date(u.created_at).toLocaleString())}</p>${u.identities.map((identity) => `<p>Issuer: ${esc(identity.issuer)}<br>Subject: ${esc(identity.subject)}</p>`).join("")}<h4>Provider-verified socials</h4>${socialsHtml(u.verified_socials)}${u.banned ? "<p>This account is also suspended.</p>" : ""}<div class="application-actions"><button class="primary" data-review="${u.id}" data-decision="approved">Approve</button>${u.admission_status !== "rejected" ? `<button class="quiet-button danger-text" data-review="${u.id}" data-decision="rejected">Decline</button>` : ""}</div></article>`).join("") : '<p class="empty-copy">No applications waiting for review.</p>'}</div>
    <h3 class="list-title">Custom emoji</h3><p class="modal-copy">Upload a PNG, JPEG, GIF or WebP image up to 256 KiB. Use its :shortcode: in messages. Standard emoji names are reserved.</p><form id="emoji-form"><label>Emoji shortcode<input name="name" required maxlength="64" pattern="[a-z0-9][a-z0-9_-]*" placeholder="island_wave"></label><label>Emoji image<input name="image" type="file" accept="image/png,image/jpeg,image/gif,image/webp" required></label><p class="form-error" role="alert"></p><button type="submit" class="primary full">Add emoji</button></form><div class="admin-emojis">${emojis.map((e) => `<div>${emojiHtml(`:${e.name}:`, [e])} <span>:${esc(e.name)}:</span><button class="quiet-button danger-text" data-remove-emoji="${esc(e.name)}">Remove</button></div>`).join("")}</div>
    <h3 class="list-title">Members</h3><div class="admin-users">${users.map((u) => `<div class="member-row">${avatar(u)}<div><strong>@${esc(u.username)}</strong><span>${u.admin ? "Administrator" : u.banned ? "Suspended" : "Active member"}</span></div>${!u.admin ? `<button class="quiet-button ${u.banned ? "" : "danger-text"}" data-ban="${u.id}" data-status="${u.banned ? "false" : "true"}">${u.banned ? "Restore" : "Suspend"}</button>` : ""}</div>`).join("")}</div><h3 class="list-title">Recent moderation</h3><div class="audit-list">${audit.length ? audit.map((a) => `<div><strong>${esc(a.action.replaceAll(".", " "))}</strong><span>by @${esc(a.username)} · ${esc(new Date(a.created_at).toLocaleString())}</span></div>`).join("") : '<p class="empty-copy">No moderation actions yet.</p>'}</div>`,
  );
  dialog
    .querySelector("#federation-admin-panel")!
    .addEventListener("click", () =>
      action(async () => {
        dialog.close();
        await federationAdmin();
      }),
    );
  form(
    dialog,
    async (data) => {
      const result = await api<{
        registration_mode: Session["registration_mode"];
      }>("/admin/settings", "PATCH", {
        registration_mode: data.get("registration_mode"),
      });
      session.registration_mode = result.registration_mode;
      toast("Membership policy saved.");
    },
    "#registration-form",
  );
  form(
    dialog,
    async (data) => {
      const file = data.get("image") as File;
      if (!file.size || file.size > 262144)
        throw new Error("Choose an image up to 256 KiB.");
      const image = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1]);
        reader.onerror = () => reject(new Error("Could not read the image."));
        reader.readAsDataURL(file);
      });
      await api("/admin/emojis", "POST", { name: data.get("name"), image });
      dialog.close();
      await admin();
      if (current) renderMessages();
    },
    "#emoji-form",
  );
  dialog
    .querySelectorAll<HTMLButtonElement>("[data-review]")
    .forEach((button) =>
      button.addEventListener("click", () =>
        action(async () => {
          await api(`/admin/applications/${button.dataset.review}`, "PATCH", {
            admission_status: button.dataset.decision,
          });
          dialog.close();
          await admin();
        }),
      ),
    );
  dialog
    .querySelectorAll<HTMLButtonElement>("[data-remove-emoji]")
    .forEach((button) =>
      button.addEventListener("click", () =>
        action(async () => {
          await api(`/admin/emojis/${button.dataset.removeEmoji}`, "DELETE");
          dialog.close();
          await admin();
          if (current) renderMessages();
        }),
      ),
    );
  dialog.querySelectorAll<HTMLButtonElement>("[data-ban]").forEach((button) =>
    button.addEventListener("click", () =>
      action(async () => {
        await api(`/admin/users/${button.dataset.ban}`, "PATCH", {
          banned: button.dataset.status === "true",
        });
        dialog.close();
        await admin();
      }),
    ),
  );
}
async function refreshChannels() {
  channels = await api<Channel[]>("/channels");
  if (document.querySelector("#channel-list")) renderSidebar();
}
async function refreshCurrent() {
  if (!current) return;
  const id = current.id,
    token = generation;
  const [detail, page] = await Promise.all([
    api<Channel>(`/channels/${id}`),
    api<{ messages: Message[]; older_cursor: number | null }>(
      `/channels/${id}/messages`,
    ),
  ]);
  if (generation !== token) return;
  const roleChanged = detail.role !== current!.role,
    topicsChanged =
      JSON.stringify(detail.topics) !== JSON.stringify(current!.topics);
  current = detail;
  renderHeader();
  if (topicsChanged) {
    if (currentTopic && !detail.topics?.some((t) => t.id === currentTopic))
      currentTopic = detail.topics?.[0]?.id || null;
    renderTopics();
  }
  // Refresh earlier loaded pages too so edits/removals never remain visible in cached history.
  let fresh = page.messages,
    cursor = page.older_cursor;
  const oldest = messages[0]?.seq;
  while (cursor && oldest && fresh[0].seq > oldest) {
    const previous = await api<{
      messages: Message[];
      older_cursor: number | null;
    }>(`/channels/${id}/messages?before=${cursor}`);
    if (generation !== token) return;
    fresh = [...previous.messages, ...fresh];
    cursor = previous.older_cursor;
  }
  messages = fresh;
  olderCursor = cursor;
  const signature = JSON.stringify(messages);
  if (signature !== lastMessageSignature) {
    renderMessages();
    lastMessageSignature = signature;
  }
  if (roleChanged) {
    reply = null;
    renderComposer();
  }
}
async function boot() {
  session = await api<Session>("/session");
  if (!session.user) {
    renderLogin();
    return;
  }
  current = null;
  messages = [];
  generation++;
  if (session.user.admission_status !== "approved") {
    renderAdmission();
    return;
  }
  [channels, customEmojis] = await Promise.all([
    api<Channel[]>("/channels"),
    api<CustomEmoji[]>("/emojis"),
  ]);
  renderShell();
  const saved = localStorage.getItem("archipel-channel");
  const first =
    channels.find((c) => c.id === saved && c.readable) ||
    channels.find((c) => c.role && c.readable);
  if (first) await selectChannel(first.id);
}
setInterval(() => {
  if (!session?.user || refreshBusy || document.hidden) return;
  refreshBusy = true;
  void (async () => {
    try {
      if (session.user!.admission_status !== "approved") {
        const latest = await api<Session>("/session");
        if (!latest.user || latest.user.admission_status === "approved")
          await boot();
        else if (JSON.stringify(latest.user) !== JSON.stringify(session.user)) {
          session = latest;
          renderAdmission();
        }
        return;
      }
      const latest = await api<Session>("/session");
      if (!latest.user) {
        await boot();
        return;
      }
      const policyChanged =
        JSON.stringify([
          latest.federation_enabled,
          latest.user.federation_send,
          latest.user.federation_receive,
          latest.user.federation_subscribe,
          latest.user.federation_post,
        ]) !==
        JSON.stringify([
          session.federation_enabled,
          session.user!.federation_send,
          session.user!.federation_receive,
          session.user!.federation_subscribe,
          session.user!.federation_post,
        ]);
      session = latest;
      if (policyChanged && current) renderComposer();
      const emojis = await api<CustomEmoji[]>("/emojis");
      if (JSON.stringify(emojis) !== JSON.stringify(customEmojis)) {
        customEmojis = emojis;
        if (current) renderMessages();
      }
      await refreshChannels();
      await refreshCurrent();
      if (document.querySelector("#federated-direct-list"))
        await drawDirectMessages();
      if (document.querySelector("#connection-status"))
        $("#connection-status").textContent = "Connected to your instance";
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        document.querySelector<HTMLDialogElement>("dialog")?.close();
        await boot();
        toast("Your session ended. Sign in again.");
      } else if (error instanceof ApiError && error.status === 403) {
        current = null;
        generation++;
        document.querySelector<HTMLDialogElement>("dialog")?.close();
        renderShell();
        toast(error.message);
      } else if (document.querySelector("#connection-status"))
        $("#connection-status").textContent =
          "Connection interrupted · retrying";
    } finally {
      refreshBusy = false;
    }
  })();
}, 2500);
void boot().catch((error) => {
  app.innerHTML = `<main class="boot-error"><h1>Could not reach Archipel.</h1><p>${esc(error.message)}</p><button id="retry" class="primary">Try again</button></main>`;
  $("#retry").addEventListener("click", () => location.reload());
});
