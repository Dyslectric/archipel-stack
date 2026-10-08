import { $, action, api, esc, go, icon, onSubmit, refreshTimes, state, when, type XmppRoom } from "./shared.js";
import { chatFrame, resetChat } from "./chat.js";
import { renderSidebar } from "./sidebar.js";

type Message = { id: string; seq: number; sender: string; body: string; created_at: string; status: string; error: string | null };
type Page = { room: XmppRoom; messages: Message[]; more: boolean };
let selected: string | undefined, generation = 0, more = false;
let messages = new Map<string, Message>();

export async function showXmppRooms(view: HTMLElement, id?: string) {
  const token = ++generation;
  selected = id; messages = new Map(); more = false;
  resetChat();
  // A fresh frame ensures channel handlers and composer state do not carry over.
  view.innerHTML = "";
  chatFrame(view); renderSidebar();
  $("#channel-actions").innerHTML = '<a class="button secondary" href="#/xmpp">Join another room</a>';
  if (id) { await tickXmppRooms(true); return; }
  const connection = await api<{ enabled: boolean; jid?: string }>("/xmpp");
  if (token !== generation || !view.isConnected) return;
  $("#channel-heading").innerHTML = "<h1>XMPP rooms</h1>";
  $("#composer-area").innerHTML = "";
  $("#feed-top").innerHTML = `<section class="card xmpp-join"><h2>Join a room hosted elsewhere</h2>${connection.enabled ?
    `<p class="muted">You join as ${esc(connection.jid)}. Your nickname is displayed in the room.</p><form class="stack" id="xmpp-room-join">
      <label>Room address<input name="room" required maxlength="512" placeholder="jdev@muc.xmpp.org" autocomplete="off"></label>
      <label>Nickname<input name="nick" required maxlength="100" value="${esc(state.session.user!.username)}" autocomplete="off"></label>
      <p class="form-error" role="alert"></p><button>Join room</button></form>` : '<p>XMPP is not configured on this instance. Ask your administrator to enable it.</p>'}</section>`;
  $("#rows").innerHTML = `<section class="card xmpp-join"><h2>Your rooms</h2><ul class="plain">${state.xmppRooms.map(r => `<li class="member-row"><a class="grow" href="#/xmpp/${r.id}">${esc(r.room)}</a><span class="muted small">${esc(r.state)}</span></li>`).join("") || '<li class="muted">You haven’t joined an external room yet.</li>'}</ul></section>`;
  if (connection.enabled) onSubmit($("#xmpp-room-join"), async data => {
    const room = await api<XmppRoom>("/xmpp/rooms", "POST", Object.fromEntries(data));
    state.xmppRooms = await api("/xmpp/rooms");
    if (token === generation && view.isConnected) go(`#/xmpp/${room.id}`);
  });
}

function paint(room: XmppRoom) {
  $("#channel-heading").innerHTML = `<h1><strong>${esc(room.room)}</strong></h1><p class="muted small">${esc(room.state)} · ${esc(room.nick)}${room.role !== "none" ? ` · ${esc(room.role)}` : ""}</p>`;
  $("#channel-actions").innerHTML = `<a class="button secondary" href="#/xmpp">Join another room</a><button type="button" class="secondary" id="xmpp-rejoin">${room.desired && room.state === "joined" ? "Reconnect" : "Join again"}</button>${room.desired ? '<button type="button" class="secondary" id="xmpp-leave">Leave room</button>' : ""}`;
  $("#xmpp-rejoin").addEventListener("click", () => action(async () => {
    await api("/xmpp/rooms", "POST", { room: room.room, nick: room.nick, reconnect: true });
    await tickXmppRooms();
  }));
  document.querySelector("#xmpp-leave")?.addEventListener("click", () => action(async () => {
    await api(`/xmpp/rooms/${room.id}`, "DELETE");
    state.xmppRooms = await api("/xmpp/rooms"); renderSidebar();
    await tickXmppRooms();
  }));
  $("#feed-top").innerHTML = `${room.subject ? `<p class="card xmpp-subject">${esc(room.subject)}</p>` : ""}${room.blocked || room.error ? `<p class="card" role="status">${esc(room.blocked || room.error)}</p>` : ""}${more ? '<button class="secondary" id="xmpp-older">Load earlier messages</button>' : ""}`;
  document.querySelector("#xmpp-older")?.addEventListener("click", () => action(async () => {
    const id = selected, token = generation, before = Math.min(...[...messages.values()].map(m => m.seq));
    const page = await api<Page>(`/xmpp/rooms/${id}/messages?before=${before}`);
    if (token !== generation || id !== selected || !document.querySelector(".xmpp-rows")) return;
    for (const message of page.messages) messages.set(message.id, message);
    more = page.more; paint(page.room);
  }));
  const rows = $("#rows"), feed = $("#message-list"), bottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
  const html = [...messages.values()].sort((a, b) => a.seq - b.seq).map(m => {
    const nick = m.sender.slice(m.sender.indexOf("/") + 1);
    const status = m.status === "queued" ? "Queued" : m.status === "sent" ? "Awaiting room confirmation" : m.status === "failed" ? `Failed: ${m.error || "Message was rejected"}` : "";
    return `<article class="xmpp-message"><div class="row"><strong title="${esc(m.sender)}">${esc(nick)}</strong><span class="muted small">${when(m.created_at)}</span>${status ? `<span class="muted small">${esc(status)}</span>` : ""}</div><div class="message-body">${esc(m.body)}</div></article>`;
  }).join("");
  if (rows.dataset.html !== html) rows.innerHTML = rows.dataset.html = html;
  if (bottom) feed.scrollTop = feed.scrollHeight;
  refreshTimes(rows);
  $("#feed-empty").innerHTML = messages.size ? "" : `<p class="empty muted">${room.state === "joining" ? "Waiting for the room to accept your join…" : "No messages received yet."}</p>`;
  const area = $("#composer-area");
  const reason = room.blocked || room.post_blocked || (room.state !== "joined" ? "Join the room to send messages." : "Your room role allows reading only.");
  if (!room.can_post) {
    if (area.dataset.permission !== reason) area.innerHTML = `<div class="composer-wrap"><p class="card muted">${esc(reason)}</p></div>`;
    area.dataset.permission = reason; return;
  }
  if (area.dataset.permission === "post") return;
  area.dataset.permission = "post";
  area.innerHTML = `<div class="composer-wrap"><form class="composer" id="xmpp-composer"><textarea name="body" maxlength="8000" rows="2" aria-label="Message" placeholder="Message the room" required></textarea><p class="form-error" role="alert"></p><div class="composer-bar"><span class="grow"></span><button aria-label="Send message">${icon("send")} Send</button></div></form></div>`;
  const form = $<HTMLFormElement>("#xmpp-composer"), body = $<HTMLTextAreaElement>("textarea", form);
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
