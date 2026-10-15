import {
  $, action, api, channelIcon, channelShares, esc, go, icon, onSubmit, shareDialog, state, toast,
  type Channel, type XmppRoom,
} from "./shared.js";
import { openWindow } from "./windows.js";

// Following a channel hosted on another instance, once what that shares is acknowledged.
export async function subscribeRemote(address: string) {
  const s = state.session, me = s.user!;
  if (!(await shareDialog(`Subscribe to ${address.slice(0, 80)}?`, [
    `Your address, <strong>@${esc(me.username)}@${esc(s.instance)}</strong>, your display name, <strong>${esc(me.display_name)}</strong>, and your profile picture, to the channel's home instance and to whoever it shows them.`,
    "That you follow the channel, to its home instance. Its owner decides whether other members see who is in it.",
    "What you write there, to the home instance and to the instances and XMPP servers of everyone following the channel.",
    me.verified_socials.length ? "Not your verified socials: they stay on this instance." : "",
  ].filter(Boolean), "Subscribe"))) return false;
  await api("/federation/subscriptions", "POST", { address });
  return true;
}
// Joining a room on another XMPP server, likewise.
export async function joinXmppRoom(jid: string | undefined, room: string, nick: string) {
  if (!(await shareDialog(`Join ${room.slice(0, 80)}?`, [
    `Your XMPP address, <strong>${esc(jid)}</strong>, to the room's server and its moderators, and to everyone in the room unless it hides addresses.`,
    `Your nickname, <strong>${esc(nick)}</strong>, and your profile picture, to everyone in the room.`,
    "What you write there, to everyone in the room and to its archive, under that server's rules.",
    state.session.user!.verified_socials.length ? "Not your verified socials: they stay on this instance." : "",
  ].filter(Boolean), "Join room"))) return null;
  const joined = await api<XmppRoom>("/xmpp/rooms", "POST", { room, nick });
  state.xmppRooms = await api("/xmpp/rooms");
  return joined;
}

// An unlisted channel is in no list, so its name is asked for; opening one that must be
// joined first asks to join.
export const channelNameQuery = (query: string) => {
  const name = query.trim().replace(/^#/, "").toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{1,39}$/.test(name) && !state.channels.some((c) => !c.remote_actor && c.name === name) ? name : "";
};
export const findByNameHtml = (name: string, cls = "") =>
  name ? `<button type="button" class="secondary small ${cls}" data-find-channel="${esc(name)}">${icon("search")} Look up #${esc(name)}</button>` : "";
export async function openChannelByName(name: string) {
  const c = await api<Channel>(`/channel-names/${encodeURIComponent(name)}`);
  if (!c.role && !c.readable) {
    if (!(await shareDialog(`Join #${c.name}?`, channelShares(c), "Join channel"))) return false;
    await api(`/channels/${c.id}/join`, "POST", {});
  }
  state.channels = await api<Channel[]>("/channels");
  go(`#/c/${c.id}`);
  return true;
}

const cancel = '<button type="button" class="secondary" data-close-window>Cancel</button>';
const close = '<button type="button" class="secondary" data-close-window>Close</button>';
// The Fusion directory's windows for both.
// The channels of this instance not joined yet, to pick one from; those hosted elsewhere have
// windows of their own.
export function channelWindow() {
  const dialog = openWindow("Join a channel",
    `<label class="search-field">${icon("search")}<input type="search" id="join-search" placeholder="Search channels" aria-label="Search channels" autocomplete="off"></label>
      <ul class="plain join-list" id="join-list"></ul>`,
    `<a href="#/channels" data-close-window>All channels</a><span class="grow"></span>${state.session.federation_enabled ? '<button type="button" class="secondary" data-close-window data-open-window="federated">On another server…</button>' : ""}${state.xmppEnabled ? '<button type="button" class="secondary" data-close-window data-open-window="xmpp">XMPP room…</button>' : ""}${close}`);
  const list = $("#join-list", dialog), search = $<HTMLInputElement>("#join-search", dialog);
  const draw = () => {
    const query = search.value.trim().toLowerCase(), named = channelNameQuery(query);
    list.innerHTML = (state.channels
      .filter((c) => !c.role && (c.can_join || c.readable) && `${c.name} ${c.description}`.toLowerCase().includes(query))
      .map((c) => `<li>${channelIcon(c, false)}<div class="grow"><strong>${esc(c.name)}</strong><span class="muted small">${esc(c.description || "No description.")}</span></div><span class="muted small">${c.member_count} member${c.member_count === 1 ? "" : "s"}</span>${c.can_join ? `<button type="button" class="secondary small" data-join="${c.id}">Join</button>` : `<a class="button secondary small" href="#/c/${c.id}" data-close-window>View</a>`}</li>`)
      .join("") || `<li class="muted">${query ? "No channels match." : "There is no channel here you have not joined."}</li>`) +
      (named ? `<li><span class="muted small grow">An unlisted channel is found by its exact name.</span>${findByNameHtml(named)}</li>` : "");
  };
  draw();
  search.addEventListener("input", draw);
  // Enter in the search is not an answer to the window.
  $("form", dialog).addEventListener("submit", (e) => e.preventDefault());
  list.addEventListener("click", (e) => {
    const named = (e.target as Element).closest<HTMLElement>("[data-find-channel]")?.dataset.findChannel;
    if (named) action(async () => { if (await openChannelByName(named)) dialog.close(); });
    const id = (e.target as Element).closest<HTMLElement>("[data-join]")?.dataset.join,
      c = state.channels.find((c) => c.id === id);
    if (c) action(async () => {
      if (!(await shareDialog(`Join #${c.name}?`, channelShares(c), "Join channel"))) return;
      await api(`/channels/${c.id}/join`, "POST", {});
      state.channels = await api<Channel[]>("/channels");
      dialog.close();
      go(`#/c/${c.id}`);
    });
  });
}
export function federatedWindow() {
  const s = state.session;
  const allowed = s.federation_enabled && s.user?.federation_subscribe && s.user?.federation_receive;
  const dialog = openWindow("Join a federated channel", allowed
    ? `<div class="field-grid"><label for="join-address">Address</label><input id="join-address" name="address" required placeholder="#general@chat.example.org or an actor URL" autocomplete="off"></div>
      <p class="muted">A channel hosted on another instance. The subscription is pending until its home instance accepts it.</p>`
    : `<p>${s.federation_enabled ? "Your role does not allow subscribing to and receiving remote channels." : "Federation is disabled on this instance."}</p>`,
    `<a href="#/settings/federation/remote" data-close-window>Your subscriptions</a><span class="grow"></span>${allowed ? `${cancel}<button>Subscribe</button>` : close}`, "narrow");
  onSubmit($("form", dialog), async (data) => {
    if (!(await subscribeRemote(String(data.get("address"))))) return;
    dialog.close();
    toast("Subscription requested. Its home instance must accept it.");
  });
}
export async function xmppWindow() {
  const connection = await api<{ enabled: boolean; jid?: string }>("/xmpp");
  const me = state.session.user!, allowed = connection.enabled && !!me.xmpp_rooms;
  const dialog = openWindow("Join an XMPP room", allowed
    ? `<div class="field-grid"><label for="join-room">Room</label><input id="join-room" name="room" required maxlength="512" placeholder="jdev@muc.xmpp.org" autocomplete="off">
      <label for="join-nick">Nickname</label><input id="join-nick" name="nick" required maxlength="100" value="${esc(me.username)}" autocomplete="off"></div>
      <p class="muted">You join as ${esc(connection.jid)}. Your nickname is displayed in the room. A channel on another Archipel Server instance is <code>channel-name@channels.&lt;its XMPP domain&gt;</code>.</p>`
    : `<p>${connection.enabled ? "Your role does not allow joining XMPP rooms on other servers." : "XMPP is not configured on this instance. Ask your administrator to enable it."}</p>`,
    `<a href="#/xmpp" data-close-window>Your rooms</a><span class="grow"></span>${allowed ? `${cancel}<button>Join room</button>` : close}`, "narrow");
  onSubmit($("form", dialog), async (data) => {
    const joined = await joinXmppRoom(connection.jid, String(data.get("room")), String(data.get("nick")));
    if (!joined) return;
    dialog.close();
    go(`#/xmpp/${joined.id}`);
  });
}
