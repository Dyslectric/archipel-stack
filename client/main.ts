import "./style.css";
import "./emoji-scale.js";
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
  refreshTimes,
  state,
  themeSeg,
  toast,
  type Channel,
  type CustomEmoji,
  type Overview,
  type Session,
} from "./shared.js";
import {
  chatChannel,
  redrawChat,
  refreshCurrent,
  resetChat,
  showChat,
} from "./chat.js";
import { adoptLayout, renderSidebar, toggleSidebar } from "./sidebar.js";
import { adoptPrefs } from "./prefs.js";
import { disablePush, syncPush } from "./notify.js";
import "./attach.js";
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
  adoptPrefs(overview.prefs);
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
    <button type="button" id="mobile-menu" class="icon-button" aria-label="Show channels" title="Show or hide channels and direct messages">${icon("sidebar")}</button>
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
        <a class="menu-item" href="#/settings">${icon("settings")}<span class="grow">All settings</span></a></div>
      <div class="menu-section"><div class="menu-label">Theme</div>${themeSeg()}</div>
      <div class="menu-section"><button type="button" class="menu-item" id="sign-out-menu">${icon("logout")}<span class="grow">Sign out</span></button></div>
    </div></details></div></header><div id="view"></div></div>`;
  renderAccount();
  $("#mobile-menu").addEventListener("click", toggleSidebar);
  $("#sign-out-menu").addEventListener("click", () => action(hooks.signOut));
}
// Menus and the channel drawer close on a click elsewhere, on Escape, and once they've been used.
document.addEventListener("click", (event) => {
  const at = event.target as Element;
  for (const menu of $$<HTMLDetailsElement>("details.menu[open]"))
    if (!menu.contains(at) || at.closest("a.menu-item")) menu.open = false;
  // The path, not the target's ancestors: folding a section redraws the drawer, and what was
  // clicked is out of the page by now.
  const path = event.composedPath(),
    within = (id: string) => path.some((el) => (el as Element).id === id);
  if ((!within("sidebar") && !within("mobile-menu")) || at.closest("#sidebar a"))
    document.querySelector("#sidebar")?.classList.remove("mobile-open");
});
// On a phone the drawer lies over the page, and a tap beside it only puts it away: nothing
// behind it is pressed, followed or focused.
for (const type of ["mousedown", "click"])
  document.addEventListener(
    type,
    (event) => {
      const side = drawer.matches ? document.querySelector("#sidebar.mobile-open") : null,
        path = event.composedPath();
      if (!side || path.includes(side) || path.some((el) => (el as Element).id === "mobile-menu"))
        return;
      event.preventDefault();
      event.stopPropagation();
      if (type === "click") side.classList.remove("mobile-open");
    },
    true,
  );
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  for (const menu of $$<HTMLDetailsElement>("details.menu[open]"))
    menu.open = false;
  document.querySelector("#sidebar")?.classList.remove("mobile-open");
});
// Two things follow a thumb dragged sideways. On a phone the channel drawer: to the right it
// comes in, to the left it goes away, and let go it settles whichever way it was headed. And a
// message that can be replied to: pulled to the left far enough, letting go starts the reply.
// A drag over something that scrolls sideways itself, such as a code block, is its own.
const drawer = matchMedia("(max-width: 720px)");
const scrollsSideways = (at: Element | null) => {
  for (let el = at; el && el !== document.body; el = el.parentElement)
    if (
      el.scrollWidth > el.clientWidth &&
      /auto|scroll/.test(getComputedStyle(el).overflowX)
    )
      return true;
  return false;
};
const REPLY_AT = 56, // how far a message is pulled before letting go replies to it
  REPLY_MAX = 84;
let swipe: {
  side: HTMLElement | null;
  open: boolean;
  width: number;
  message: HTMLElement | null;
  x: number;
  y: number;
  dragging: "drawer" | "reply" | null;
  offset: number; // drawer: how far it sits from fully shown, from -width to 0; reply: the pull
  lastX: number;
  lastAt: number;
  speed: number; // px/ms, to the right
} | null = null;
document.addEventListener(
  "touchstart",
  (event) => {
    const at = event.target as Element,
      side = drawer.matches ? document.querySelector<HTMLElement>("#sidebar") : null,
      open = !!side?.classList.contains("mobile-open"),
      message = open ? null : at.closest?.<HTMLElement>("article.message:has([data-reply])") || null,
      { clientX: x, clientY: y } = event.touches[0];
    if (swipe?.dragging) return settle(false);
    swipe =
      (side || message) &&
      event.touches.length === 1 &&
      !document.querySelector("dialog[open]") &&
      !at.closest?.("input, textarea, select, [contenteditable]") &&
      !scrollsSideways(at)
        ? { side, open, width: side?.offsetWidth || 0, message, x, y, dragging: null, offset: 0,
            lastX: x, lastAt: event.timeStamp, speed: 0 }
        : null;
  },
  { passive: true },
);
document.addEventListener(
  "touchmove",
  (event) => {
    const s = swipe;
    if (!s) return;
    const { clientX: x, clientY: y } = event.touches[0],
      dx = x - s.x,
      dy = y - s.y;
    if (!s.dragging) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 8) return;
      // Up and down is scrolling. Sideways, the drawer moves if it has somewhere to go that
      // way, and otherwise a pull to the left is at the message under the thumb.
      const sideways = Math.abs(dx) > Math.abs(dy) && getSelection()?.isCollapsed;
      if (sideways && s.side && dx > 0 !== s.open) {
        s.dragging = "drawer";
        s.side.classList.add("dragging");
      } else if (sideways && s.message && dx < 0) {
        s.dragging = "reply";
        s.message.classList.add("swiping");
        s.message.insertAdjacentHTML("beforeend", `<span class="swipe-reply" aria-hidden="true">${icon("reply")}</span>`);
      } else {
        swipe = null;
        return;
      }
    }
    if (event.cancelable) event.preventDefault();
    if (event.timeStamp > s.lastAt)
      s.speed = 0.6 * ((x - s.lastX) / (event.timeStamp - s.lastAt)) + 0.4 * s.speed;
    s.lastX = x;
    s.lastAt = event.timeStamp;
    if (s.dragging === "drawer") {
      s.offset = Math.min(0, Math.max(-s.width, (s.open ? 0 : -s.width) + dx));
      s.side!.style.transform = `translateX(${s.offset}px)`;
      s.side!.style.opacity = String(1 + s.offset / s.width); // it fades as far as it has slid
      return;
    }
    // Past the point where it would reply the message drags, so that the point can be felt.
    const pull = Math.max(0, -dx);
    s.offset = Math.min(REPLY_MAX, pull <= REPLY_AT ? pull : REPLY_AT + (pull - REPLY_AT) * 0.3);
    const m = s.message!,
      mark = m.querySelector<HTMLElement>(".swipe-reply");
    m.style.transition = "none";
    m.style.transform = `translateX(${-s.offset}px)`;
    m.classList.toggle("swipe-armed", pull >= REPLY_AT);
    if (mark) mark.style.opacity = String(Math.min(1, pull / REPLY_AT));
  },
  { passive: false },
);
// Let go, the drawer slides the rest of the way: after a flick the way it was flicked,
// otherwise to whichever side it is nearer. A message slides back to where it was.
function settle(finished: boolean) {
  const s = swipe;
  swipe = null;
  if (s?.dragging === "drawer") {
    const open = !finished
      ? s.open
      : Math.abs(s.speed) > 0.3
        ? s.speed > 0
        : s.offset > -s.width / 2;
    s.side!.classList.remove("dragging");
    s.side!.style.transform = s.side!.style.opacity = "";
    s.side!.classList.toggle("mobile-open", open);
  } else if (s?.dragging === "reply") {
    const m = s.message!,
      armed = finished && m.classList.contains("swipe-armed");
    m.style.transition = m.style.transform = "";
    setTimeout(() => {
      m.classList.remove("swiping", "swipe-armed");
      m.querySelector(".swipe-reply")?.remove();
    }, 200);
    if (armed) m.querySelector<HTMLElement>("[data-reply]")?.click();
  }
}
document.addEventListener("touchend", () => settle(true));
document.addEventListener("touchcancel", () => settle(false));

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
  hangUp();
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
  state.prefs = {};
  if (!state.session.user) return renderLogin();
  // What was just loaded is fresh; the stream's opening look can wait its turn.
  refreshedAt = Date.now();
  listen();
  if (state.session.user.admission_status !== "approved")
    return renderAdmission();
  [state.channels, state.emojis] = await Promise.all([
    api<Channel[]>("/channels"),
    api<CustomEmoji[]>("/emojis"),
    loadOverview(),
  ]);
  renderShell();
  renderSidebar();
  void syncPush().catch(() => {
    /* Notifications stay as they were; the settings page says how they stand. */
  });
  await route();
}
hooks.boot = boot;
hooks.account = renderAccount;
hooks.signOut = async () => {
  // This browser stops being notified for the account.
  await disablePush().catch(() => {});
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
    s.user?.instance_role?.id,
    s.user?.create_channels,
    s.user?.direct_messages,
    s.user?.attachments,
    s.user?.xmpp_rooms,
  ]);
function connection(up: boolean) {
  const status = document.querySelector<HTMLElement>("#connection-status");
  if (!status) return;
  status.classList.toggle("down", !up);
  status.title = up
    ? `Connected to ${state.session.instance}`
    : "Connection interrupted. Retrying…";
}
// ---- keeping up: the server says when something on screen may have changed, and the page
// looks again at what the notice names ----
type Notice = { all?: true; me?: true; admin?: true; channels?: string[] };
const GAP = 1500; // a busy conversation is looked at again this often at most
let stream: EventSource | null = null,
  news: Notice | null = null,
  refreshTimer = 0,
  refreshedAt = 0,
  retryTimer = 0;
async function refresh(notice: Notice) {
  const session = state.session;
  if (!session?.user) return;
  try {
    // A notice about conversations alone leaves the account, channel list and emoji as they are.
    if (!notice.all && !notice.me && session.user.admission_status === "approved") {
      const view = document.querySelector<HTMLElement>(".app")?.dataset.view;
      if (notice.channels) {
        await loadOverview();
        renderSidebar();
        if (view === "chat") {
          const open = chatChannel()?.id;
          if (open && notice.channels.includes(open)) await refreshCurrent();
          await tickInbox();
        }
      }
      if (notice.admin && view === "settings") await tickSettings();
      connection(true);
      return;
    }
    const latest = await api<Session>("/session");
    if (session.user.admission_status !== "approved") {
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
    const profileChanged = latest.user.avatar_url !== session.user.avatar_url ||
      latest.user.display_name !== session.user.display_name;
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
    } else {
      connection(false);
      // Nothing was learned; the stream coming back, or the next notice, asks again.
      throw error;
    }
  }
}
// Notices that arrive while the page is busy, hidden or was only just refreshed are kept
// together, and looked at in one go.
function changed(notice: Notice) {
  news = {
    ...news,
    ...notice,
    ...(news?.channels || notice.channels
      ? { channels: [...new Set([...(news?.channels || []), ...(notice.channels || [])])] }
      : {}),
  };
  if (refreshTimer || refreshBusy || document.hidden) return;
  refreshTimer = window.setTimeout(
    () => {
      refreshTimer = 0;
      const notice = news;
      news = null;
      if (!notice) return;
      refreshBusy = true;
      refreshedAt = Date.now();
      let failed = false;
      void refresh(notice)
        .catch(() => {
          // Tried again with the next notice, or when the stream is back: never in a loop.
          failed = true;
          news = { ...news, all: true };
        })
        .finally(() => {
          refreshBusy = false;
          if (news && !failed) changed({});
        });
    },
    Math.max(0, refreshedAt + GAP - Date.now()),
  );
}
function hangUp() {
  clearTimeout(retryTimer);
  retryTimer = 0;
  stream?.close();
  stream = null;
}
// One stream while the page is in view. Whenever it opens, or opens again after a break,
// everything is looked at once: whatever happened meanwhile was not announced.
function listen() {
  if (stream || retryTimer || document.hidden || !state.session?.user) return;
  const source = (stream = new EventSource("/api/events"));
  source.onopen = () => {
    connection(true);
    changed({ all: true });
  };
  source.onmessage = (event) => changed(JSON.parse(event.data));
  source.onerror = () => {
    connection(false);
    // The browser reconnects by itself after a dropped connection. Refused outright, the
    // session may be over: asking for it again finds out, and signs the page out if so.
    if (source.readyState !== EventSource.CLOSED || stream !== source) return;
    stream = null;
    changed({ all: true });
    retryTimer = window.setTimeout(() => {
      retryTimer = 0;
      listen();
    }, 4000);
  };
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) hangUp();
  else listen();
});
addEventListener("online", listen);
// Times such as "5 minutes ago" age without anything having changed.
setInterval(() => {
  if (!document.hidden) refreshTimes();
}, 30000);
void boot().catch((error) => {
  app.innerHTML = `<main class="page"><div class="card narrow"><h1>Could not reach Archipel</h1><p class="muted">${esc(error.message)}</p><button type="button" id="retry">Try again</button></div></main>`;
  $("#retry").addEventListener("click", () => location.reload());
});
