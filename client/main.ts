import "./style.css";
import {
  $,
  $$,
  action,
  api,
  ApiError,
  app,
  applyTheme,
  avatar,
  dmPeer,
  esc,
  go,
  hooks,
  icon,
  state,
  themeSeg,
  toast,
  type Channel,
  type CustomEmoji,
  type Overview,
  type Session,
} from "./shared.js";
import { redrawChat, refreshCurrent, resetChat, showChat } from "./chat.js";
import { adoptLayout, renderSidebar } from "./sidebar.js";
import { showInbox, tickInbox } from "./inbox.js";
import "./people.js";
import {
  renderAdmission,
  renderLogin,
  showChannels,
  tickChannels,
} from "./pages.js";
import { showSettings, tickSettings } from "./settings.js";
import { closePicker } from "./picker.js";
import { showXmppRooms, tickXmppRooms } from "./xmpp-rooms.js";

applyTheme();
let refreshBusy = false;

// Direct conversations, what is new in each conversation, and how the sidebar is arranged.
async function loadOverview() {
  const overview = await api<Overview>("/overview");
  state.xmppEnabled = overview.xmpp_enabled;
  state.xmppRooms = overview.xmpp_rooms;
  state.dms = overview.dms;
  state.userBlocks = overview.user_blocks;
  state.unread = { ...overview.unread };
  for (const c of overview.dms)
    if (c.unread) state.unread[`dm:${c.peer}`] = c.unread;
  adoptLayout(overview.layout);
}

// ---- the frame every signed-in page shares: the bar on top, and the page under it ----
function renderAccount() {
  const summary = document.querySelector("#profile");
  if (summary)
    summary.innerHTML = `${avatar(state.session.user!, "small")}<span class="label">${esc(state.session.user!.display_name)}</span>${icon("chevron-down", "chev")}`;
}
function renderShell() {
  const s = state.session,
    instance = esc(s.instance);
  app.innerHTML = `<div class="app"><a class="skip-link" href="#view">Skip to content</a><header class="top"><div class="top-inner">
    <button type="button" id="mobile-menu" class="icon-button" aria-label="Show channels" title="Channels and direct messages">${icon("menu")}</button>
    <a class="brand" href="#/" aria-label="Archipel home">${icon("logo", "brand-mark")}<span>Archipel</span></a>
    <nav class="primary" aria-label="Main">
      <a class="nav-item" data-nav="chat" href="#/" title="Chat">${icon("chat")}<span class="label">Chat</span></a>
      <a class="nav-item" data-nav="channels" href="#/channels" id="browse" title="Channels">${icon("compass")}<span class="label">Channels</span></a>
      <a class="nav-item" data-nav="inbox" href="#/inbox" title="Inbox">${icon("inbox")}<span class="label">Inbox</span><span class="count" id="inbox-count" hidden></span></a>
      <a class="nav-item" data-nav="settings" href="#/settings" title="Settings">${icon("settings")}<span class="label">Settings</span></a>
    </nav><span class="grow"></span>
    <span class="conn small muted" id="connection-status" title="Connected to ${instance}"><span class="status-dot"></span><span class="label">${instance}</span></span>
    <details class="menu account-menu" id="account-menu"><summary id="profile" title="Your account, theme and sign out"></summary><div class="menu-panel">
      <div class="menu-section"><div class="menu-label">@${esc(s.user!.username)}${s.dev_auth ? " · local development" : ""}</div>
        <a class="menu-item" href="#/settings/personal/profile">${icon("user")}<span class="grow">Profile</span></a>
        <a class="menu-item" href="#/settings/personal/emoji">${icon("smile")}<span class="grow">Your emoji</span></a>
        <a class="menu-item" href="#/settings/federation/remote">${icon("globe")}<span class="grow">Federated conversations</span></a>
        ${s.user!.admin ? `<a class="menu-item" href="#/settings/instance/membership">${icon("shield")}<span class="grow">Instance administration</span></a>` : ""}</div>
      <div class="menu-section"><div class="menu-label">Theme</div>${themeSeg()}</div>
      <div class="menu-section"><button type="button" class="menu-item" id="sign-out-menu">${icon("logout")}<span class="grow">Sign out</span></button></div>
    </div></details></div></header><div id="view"></div></div>`;
  renderAccount();
  $("#mobile-menu").addEventListener("click", () =>
    document.querySelector("#sidebar")?.classList.toggle("mobile-open"),
  );
  $("#sign-out-menu").addEventListener("click", () => action(hooks.signOut));
}
// Menus and the channel drawer close on a click elsewhere, on Escape, and once they've been used.
document.addEventListener("click", (event) => {
  const at = event.target as Element;
  for (const menu of $$<HTMLDetailsElement>("details.menu[open]"))
    if (!menu.contains(at) || at.closest("a.menu-item")) menu.open = false;
  if (
    (!at.closest("#sidebar") && !at.closest("#mobile-menu")) ||
    at.closest("#sidebar a")
  )
    document.querySelector("#sidebar")?.classList.remove("mobile-open");
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  for (const menu of $$<HTMLDetailsElement>("details.menu[open]"))
    menu.open = false;
  document.querySelector("#sidebar")?.classList.remove("mobile-open");
});

// ---- where you are is in the address: #/inbox, #/c/<channel>[/t/<topic>], #/dm/<person>,
// #/channels, #/settings/... ----
async function route() {
  const view = document.querySelector<HTMLElement>("#view");
  if (!view) return;
  const parts = location.hash
    .replace(/^#\/?/, "")
    .split("/")
    .filter(Boolean);
  const name =
    ["channels", "settings", "xmpp"].includes(parts[0]) ? parts[0] : "chat";
  const shell = $(".app");
  if (shell.dataset.view !== name) view.innerHTML = "";
  shell.dataset.view = name;
  // The inbox is drawn in the chat view's frame, but has its own tab.
  const tab = parts[0] === "inbox" ? "inbox" : name === "xmpp" ? "chat" : name;
  for (const item of $$("[data-nav]")) {
    item.classList.toggle("on", item.dataset.nav === tab);
    if (item.dataset.nav === tab) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  }
  closePicker();
  if (name === "channels") showChannels(view, parts[1] === "new");
  else if (name === "xmpp") await showXmppRooms(view, parts[1]);
  else if (name === "settings")
    await showSettings(view, parts[1], parts[2], parts[3]);
  else if (tab === "inbox") await showInbox(view);
  else if (parts[0] === "dm" && parts[1])
    await showChat(view, `dm:${dmPeer(parts[1])}`);
  else
    await showChat(
      view,
      parts[0] === "c" ? parts[1] : undefined,
      parts[2] === "t" ? parts[3] : undefined,
    );
}
addEventListener("hashchange", () => action(route));
// A link to the page you're already on reloads it.
document.addEventListener("click", (event) => {
  const link = (event.target as Element).closest('a[href^="#/"]');
  if (link?.getAttribute("href") === location.hash) action(route);
});

async function boot() {
  state.session = await api<Session>("/session");
  resetChat();
  state.channels = [];
  state.emojis = [];
  state.dms = [];
  state.xmppEnabled = false;
  state.xmppRooms = [];
  state.unread = {};
  state.layout = null;
  state.userBlocks = [];
  if (!state.session.user) return renderLogin();
  if (state.session.user.admission_status !== "approved")
    return renderAdmission();
  [state.channels, state.emojis] = await Promise.all([
    api<Channel[]>("/channels"),
    api<CustomEmoji[]>("/emojis"),
    loadOverview(),
  ]);
  renderShell();
  renderSidebar();
  await route();
}
hooks.boot = boot;
hooks.account = renderAccount;
hooks.signOut = async () => {
  await api("/logout", "POST", {});
  history.replaceState(null, "", "/");
  await boot();
};

const federationPolicy = (s: Session) =>
  JSON.stringify([
    s.federation_enabled,
    s.user?.federation_send,
    s.user?.federation_receive,
    s.user?.federation_subscribe,
    s.user?.federation_post,
  ]);
function connection(up: boolean) {
  const status = document.querySelector<HTMLElement>("#connection-status");
  if (!status) return;
  status.classList.toggle("down", !up);
  status.title = up
    ? `Connected to ${state.session.instance}`
    : "Connection interrupted. Retrying…";
}
setInterval(() => {
  const session = state.session;
  if (!session?.user || refreshBusy || document.hidden) return;
  refreshBusy = true;
  void (async () => {
    try {
      const latest = await api<Session>("/session");
      if (session.user!.admission_status !== "approved") {
        if (!latest.user || latest.user.admission_status === "approved")
          await boot();
        else if (JSON.stringify(latest.user) !== JSON.stringify(session.user)) {
          state.session = latest;
          renderAdmission();
        }
        return;
      }
      if (!latest.user || latest.user.admission_status !== "approved") {
        await boot();
        return;
      }
      const policyChanged =
        federationPolicy(latest) !== federationPolicy(session);
      const profileChanged = latest.user.avatar_url !== session.user!.avatar_url ||
        latest.user.display_name !== session.user!.display_name;
      state.session = latest;
      if (profileChanged) renderAccount();
      const emojis = await api<CustomEmoji[]>("/emojis"),
        emojisChanged = JSON.stringify(emojis) !== JSON.stringify(state.emojis);
      state.emojis = emojis;
      if (policyChanged || emojisChanged) redrawChat(policyChanged);
      [state.channels] = await Promise.all([
        api<Channel[]>("/channels"),
        loadOverview(),
      ]);
      renderSidebar();
      const view = document.querySelector<HTMLElement>(".app")?.dataset.view;
      if (view === "chat") {
        await refreshCurrent();
        await tickInbox();
      }
      else if (view === "channels") tickChannels();
      else if (view === "xmpp") await tickXmppRooms();
      else await tickSettings();
      connection(true);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        document.querySelector<HTMLDialogElement>("dialog")?.close();
        await boot();
        toast("Your session ended. Sign in again.");
      } else if (error instanceof ApiError && [403, 404].includes(error.status)) {
        // Access to what's on screen was taken away, or it was deleted.
        document.querySelector<HTMLDialogElement>("dialog")?.close();
        resetChat();
        localStorage.removeItem("archipel-channel");
        toast(error.message, true);
        go("#/channels");
      } else connection(false);
    } finally {
      refreshBusy = false;
    }
  })();
}, 2500);
void boot().catch((error) => {
  app.innerHTML = `<main class="page"><div class="card narrow"><h1>Could not reach Archipel</h1><p class="muted">${esc(error.message)}</p><button type="button" id="retry">Try again</button></div></main>`;
  $("#retry").addEventListener("click", () => location.reload());
});
