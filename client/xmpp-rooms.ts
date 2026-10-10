import { $, action, api, avatar, clock, dayLabel, esc, full, go, icon, nameButton, richHtml, emojiOnly, onSubmit, sameDay, shareDialog, state, type XmppRoom } from "./shared.js";
import { attachButton, pickFiles, quoteInto } from "./attach.js";
import { chatFrame, resetChat } from "./chat.js";
import { renderSidebar } from "./sidebar.js";
import { mirrorDialog } from "./mirrors.js";
import { joinXmppRoom } from "./join.js";
import { appStyle, isFusion } from "./appearance.js";

type Message = { id: string; seq: number; sender: string; sender_jid: string | null; blocked: boolean; body: string; created_at: string; status: string; error: string | null };
type Page = { room: XmppRoom; messages: Message[]; more: boolean };
let selected: string | undefined, generation = 0, more = false;
let messages = new Map<string, Message>();
document.addEventListener("appearance-change", () => {
  const room = state.xmppRooms.find(r => r.id === selected);
  if (room && document.querySelector(".xmpp-rows")) paint(room);
});

export async function showXmppRooms(view: HTMLElement, id?: string) {
  const token = ++generation;
  selected = id; messages = new Map(); more = false;
  resetChat();
  // A fresh frame ensures channel handlers and composer state do not carry over.
  view.innerHTML = "";
  chatFrame(view); renderSidebar();
  $("#rows").addEventListener("click", e => {
    const quoted = messages.get((e.target as Element).closest<HTMLElement>("[data-quote]")?.dataset.quote || "");
    const body = document.querySelector<HTMLTextAreaElement>("#xmpp-composer textarea");
    if (quoted && body) quoteInto(body, quoted.body);
  });
  $("#channel-actions").innerHTML = '<a class="button secondary" href="#/xmpp" data-open-window="xmpp">Join another room</a>';
  if (id) { await tickXmppRooms(true); return; }
  const connection = await api<{ enabled: boolean; jid?: string }>("/xmpp");
  if (token !== generation || !view.isConnected) return;
  $("#channel-heading").innerHTML = `<h1>${icon("globe")}XMPP rooms</h1>`;
  $("#composer-area").innerHTML = "";
  $("#feed-top").innerHTML = `<div class="channel-intro"><h2>${icon("globe")}Join a room hosted elsewhere</h2></div><section class="card xmpp-join">${connection.enabled && !state.session.user!.xmpp_rooms ? "<p>Your role does not allow joining XMPP rooms on other servers.</p>" : connection.enabled ?
    `<p class="muted">You join as ${esc(connection.jid)}. Your nickname is displayed in the room.</p><form class="stack" id="xmpp-room-join">
      <label>Room address<input name="room" required maxlength="512" placeholder="jdev@muc.xmpp.org" autocomplete="off"></label>
      <p class="muted small">A channel on another Archipel Server instance is <code>channel-name@channels.&lt;its XMPP domain&gt;</code>.</p>
      <label>Nickname<input name="nick" required maxlength="100" value="${esc(state.session.user!.username)}" autocomplete="off"></label>
      <p class="form-error" role="alert"></p><button>Join room</button></form>` : '<p>XMPP is not configured on this instance. Ask your administrator to enable it.</p>'}</section>`;
  $("#rows").className = "";
  $("#rows").innerHTML = `<section class="card xmpp-join"><h2>Your rooms</h2><ul class="plain">${state.xmppRooms.map(r => `<li class="member-row"><a class="grow" href="#/xmpp/${r.id}">${esc(r.room)}</a><span class="muted small">${esc(r.reconnecting ? "reconnecting" : r.state)}</span></li>`).join("") || '<li class="muted">You haven’t joined an external room yet.</li>'}</ul></section>`;
  $("#feed-empty").innerHTML = "";
  if (document.querySelector("#xmpp-room-join")) onSubmit($("#xmpp-room-join"), async data => {
    const room = await joinXmppRoom(connection.jid, String(data.get("room")), String(data.get("nick")));
    if (!room) return;
    if (token === generation && view.isConnected) go(`#/xmpp/${room.id}`);
  });
}

function paint(room: XmppRoom) {
  $("#channel-heading").innerHTML = `<h1>${icon("globe")}<span class="topic-name">${esc(room.room)}</span></h1><span class="desc">${esc(room.state)} · ${esc(room.nick)}${room.role !== "none" ? ` · ${esc(room.role)}` : ""}</span>`;
  $("#channel-actions").innerHTML = `<a class="button secondary" href="#/xmpp" data-open-window="xmpp">Join another room</a><button type="button" class="secondary" id="xmpp-mirror" title="Keep your own copy of this room in a channel you own">Mirror</button><button type="button" class="secondary" id="xmpp-rejoin">${room.desired && room.state === "joined" ? "Reconnect" : "Join again"}</button>${room.desired ? '<button type="button" class="secondary" id="xmpp-leave">Leave room</button>' : ""}`;
  $("#xmpp-mirror").addEventListener("click", () => mirrorDialog("xmpp", room.id, room.room));
  $("#xmpp-rejoin").addEventListener("click", () => action(async () => {
    await api("/xmpp/rooms", "POST", { room: room.room, nick: room.nick, reconnect: true });
    await tickXmppRooms();
  }));
  document.querySelector("#xmpp-leave")?.addEventListener("click", () => action(async () => {
    await api(`/xmpp/rooms/${room.id}`, "DELETE");
    state.xmppRooms = await api("/xmpp/rooms"); renderSidebar();
    await tickXmppRooms();
  }));
  $("#feed-top").innerHTML = `${more ? '<button type="button" class="secondary small older-button" id="xmpp-older">Load earlier messages</button>' :
    `<div class="channel-intro"><h2>${icon("globe")}${esc(room.room)}</h2><p class="muted xmpp-subject">${esc(room.subject || "A room hosted on another XMPP server.")}</p><p class="muted small">You appear as <code>${esc(room.nick)}</code></p></div>`}${
    more && room.subject ? `<p class="muted xmpp-subject">${esc(room.subject)}</p>` : ""}${room.blocked || room.error ? `<p class="card" role="status">${esc(room.blocked || room.error)}${!room.blocked && room.reconnecting ? " Joining again automatically…" : ""}</p>` : ""}`;
  document.querySelector("#xmpp-older")?.addEventListener("click", () => action(async () => {
    const id = selected, token = generation, before = Math.min(...[...messages.values()].map(m => m.seq));
    const page = await api<Page>(`/xmpp/rooms/${id}/messages?before=${before}`);
    if (token !== generation || id !== selected || !document.querySelector(".xmpp-rows")) return;
    for (const message of page.messages) messages.set(message.id, message);
    more = page.more; paint(page.room);
  }));
  const rows = $("#rows"), feed = $("#message-list"), bottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
  // The same day groups and message rows as a channel. Authors are room nicknames, with their own
  // address beside it when the room discloses one; otherwise they can only be blocked by nickname.
  let html = "", prev: Message | undefined;
  for (const m of [...messages.values()].sort((a, b) => a.seq - b.seq)) {
    const nick = m.sender.slice(m.sender.indexOf("/") + 1);
    const status = m.status === "queued" ? "Queued" : m.status === "sent" ? "Awaiting room confirmation" : m.status === "failed" ? `Failed: ${m.error || "Message was rejected"}` : "";
    const day = !prev || !sameDay(prev.created_at, m.created_at);
    const cont = !isFusion() && !day && prev!.sender === m.sender && new Date(m.created_at).getTime() - new Date(prev!.created_at).getTime() < 600000;
    const time = `<time datetime="${esc(m.created_at)}" title="${esc(full(m.created_at))}">${esc(clock(m.created_at))}</time>`;
    const note = status ? `<span class="edited">${esc(status)}</span>` : "";
    if (day) html += `${prev ? "</div></section>" : ""}<section class="day-group"><div class="day-divider"><span>${esc(dayLabel(m.created_at))}</span></div><div class="group-body">`;
    const own = m.sender === `${room.room}/${room.nick}`, who = { username: m.sender_jid || m.sender, display_name: nick };
    const name = own ? `<span class="author" title="${esc(m.sender)}">${esc(nick)}</span>`
      : `${nameButton(who, `xmpp:${m.sender_jid || m.sender}`)}${m.sender_jid ? ` <span class="handle">${esc(m.sender_jid)}</span>` : ""}`;
    if (appStyle() === "fusion-compact") {
      html += `<article class="message compact-message xmpp-message${status ? ` queued${m.status === "failed" ? " failed" : ""}` : ""}"><span class="compact-time">${time}</span><div class="compact-author">${name}</div><div class="message-content"><div class="message-body${m.blocked ? " faded" : " markdown"}${!m.blocked && emojiOnly(m.body) ? " emoji-only" : ""}">${m.blocked ? esc(m.body) : richHtml(m.body)}</div>${note}</div>${room.can_post && !m.blocked ? `<div class="message-actions"><button type="button" class="icon-button quote-button" data-quote="${esc(m.id)}" aria-label="Quote ${esc(nick)}" title="Quote">${icon("quote")}</button></div>` : ""}</article>`;
    } else html += `<article class="message xmpp-message${cont ? " cont" : ""}${status ? ` queued${m.status === "failed" ? " failed" : ""}` : ""}"><div class="msg-gutter">${cont ? time : avatar(who)}</div>
      <div class="message-content">${cont ? "" : `<div class="message-meta">${name}${time}${note}</div>`}<div class="message-body${m.blocked ? " faded" : " markdown"}${!m.blocked && emojiOnly(m.body) ? " emoji-only" : ""}">${m.blocked ? esc(m.body) : richHtml(m.body)}</div>${cont ? note : ""}</div>${
        room.can_post && !m.blocked ? `<div class="message-actions"><button type="button" class="icon-button quote-button" data-quote="${esc(m.id)}" aria-label="Quote ${esc(nick)}" title="Quote">${icon("quote")}</button></div>` : ""}</article>`;
    prev = m;
  }
  if (prev) html += "</div></section>";
  if (rows.dataset.html !== html) rows.innerHTML = rows.dataset.html = html;
  if (bottom) feed.scrollTop = feed.scrollHeight;
  $("#feed-empty").innerHTML = messages.size ? "" : `<p class="empty muted">${room.state === "joining" ? "Waiting for the room to accept your join…" : "No messages received yet."}</p>`;
  const area = $("#composer-area");
  const reason = room.blocked || room.post_blocked || (room.state !== "joined" ? "Join the room to send messages." : "Your room role allows reading only.");
  if (!room.can_post) {
    if (area.dataset.permission !== reason) area.innerHTML = `<div class="composer-wrap"><p class="card composer-hint muted">${esc(reason)}</p></div>`;
    area.dataset.permission = reason; return;
  }
  if (area.dataset.permission === "post") return;
  area.dataset.permission = "post";
  area.innerHTML = `<div class="composer-wrap"><form class="composer" id="xmpp-composer"><textarea name="body" maxlength="8000" rows="2" aria-label="Message" placeholder="Message ${esc(room.room)}" required></textarea><p class="form-error" role="alert"></p><div class="composer-bar">${attachButton('id="xmpp-attach"')}<span class="grow"></span><span class="muted small composer-hint-keys"><kbd>Enter</kbd> to send · <kbd>Shift</kbd> + <kbd>Enter</kbd> for a new line · Markdown</span><button type="submit" aria-label="Send message">${icon("send")}<span>Send</span></button></div></form></div>`;
  const form = $<HTMLFormElement>("#xmpp-composer"), body = $<HTMLTextAreaElement>("textarea", form);
  form.querySelector("#xmpp-attach")?.addEventListener("click", () => pickFiles(body));
  onSubmit(form, async data => {
    const id = selected, token = generation;
    await api(`/xmpp/rooms/${id}/messages`, "POST", { body: data.get("body") });
    if (token !== generation || !form.isConnected) return;
    body.value = ""; await tickXmppRooms(); body.focus();
  });
  body.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
  });
}

export async function tickXmppRooms(initial = false) {
  const id = selected, token = generation;
  if (!id || document.querySelector(".app")?.getAttribute("data-view") !== "xmpp") return;
  const room = state.xmppRooms.find(r => r.id === id);
  if (!room) { $("#channel-heading").textContent = "XMPP room not found"; return; }
  $("#rows").className = "xmpp-rows";
  if (room.blocked) { messages.clear(); more = false; paint(room); return; }
  const page = await api<Page>(`/xmpp/rooms/${id}/messages`);
  if (token !== generation || selected !== id || !document.querySelector(".xmpp-rows")) return;
  for (const message of page.messages) messages.set(message.id, message);
  if (initial) more = page.more;
  paint(page.room);
}
