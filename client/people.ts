import {
  $,
  action,
  api,
  avatar,
  dmHref,
  esc,
  go,
  hooks,
  listsMembers,
  icon,
  onSubmit,
  popup,
  state,
  toast,
  type Conversation,
  type User,
} from "./shared.js";

// People: a click on someone's name offers to write to or block them, and "New direct message" finds
// someone to write to. Whether a message can be delivered is only known once it's tried —
// the conversation says why not when it can't.
document.addEventListener("click", (e) => {
  const at = e.target as Element,
    name = at.closest<HTMLElement>("[data-user]");
  if (name) {
    e.preventDefault();
    const { user: actor = "", username = "", name: shown = "", avatar: picture = "" } = name.dataset,
      self = actor === state.session.user!.actor_url,
      remote = actor.startsWith("xmpp:") || !actor.startsWith(state.session.user!.actor_url!.slice(0, state.session.user!.actor_url!.lastIndexOf("/") + 1)),
      blocked = state.userBlocks.includes(actor),
      // Someone in an XMPP room that hides its members' addresses: xmpp:room@host/nickname.
      occupant = /^xmpp:[^/]+\/./.test(actor);
    const panel = popup(
      name,
      `<div class="user-card">${avatar({ username, display_name: shown, avatar_url: picture }, "large")}<div class="grow"><strong>${esc(shown)}</strong><div class="handle">${occupant ? `In ${esc(username.split("/")[0])}` : `@${esc(username)}`}</div></div></div>
      <div class="menu-section">${
        self
          ? `<a class="menu-item" href="#/settings/personal/profile">${icon("user")}<span class="grow">This is you. Edit your profile</span></a>`
          : occupant
            ? `<p class="muted small menu-note">This room hides its members' addresses, so they can't be messaged directly and are blocked by nickname.</p>
             <button type="button" class="menu-item${blocked ? "" : " bad-text"}" data-user-block>${icon(blocked ? "check" : "block")}<span class="grow">${blocked ? "Unblock in this room" : "Block in this room"}</span></button>`
          : `<a class="menu-item" href="${esc(dmHref(actor))}">${icon("chat")}<span class="grow">${blocked ? "Open direct conversation" : "Send a direct message"}</span></a>
             ${remote ? `<button type="button" class="menu-item" data-contact-name>${icon("pencil")}<span class="grow">Set display name</span></button>` : ""}
             <button type="button" class="menu-item${blocked ? "" : " bad-text"}" data-user-block>${icon(blocked ? "check" : "block")}<span class="grow">${blocked ? "Unblock user" : "Block user"}</span></button>`
      }</div>`,
    );
    panel?.querySelector("[data-contact-name]")?.addEventListener("click", () =>
      action(() => editContactName(actor)),
    );
    panel?.querySelector("[data-user-block]")?.addEventListener("click", () =>
      action(async () => {
        await api("/user-blocks", "POST", { peer: actor, blocked: !blocked });
        await hooks.boot();
        toast(`${shown} ${blocked ? "unblocked" : "blocked"}.`);
      }),
    );
  } else if (at.closest("[data-new-dm]")) newDirectMessage();
});

async function editContactName(peer: string) {
  if (document.querySelector(".contact-name-dialog")) return;
  const contact = await api<Conversation>(`/contact-names?peer=${encodeURIComponent(peer)}`);
  const dialog = document.createElement("dialog");
  dialog.className = "card dialog contact-name-dialog";
  dialog.innerHTML = `<h2>Set display name</h2><p class="muted small">Choose a name for this contact. Only you will see it.</p>
    <p class="handle">${esc(contact.username)}</p>
    <form class="stack"><label>Display name<input name="display_name" maxlength="80" autocomplete="off" value="${esc(contact.contact_name ?? "")}" placeholder="${esc(contact.display_name)}"></label>
    <p class="muted small">Leave blank to use their original name.</p><p class="form-error" role="alert"></p>
    <div class="row end"><button type="button" class="secondary" data-cancel>Cancel</button><button>Save name</button></div></form>`;
  document.body.append(dialog);
  $("[data-cancel]", dialog).addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => dialog.remove());
  onSubmit($<HTMLFormElement>("form", dialog), async (data) => {
    await api("/contact-names", "POST", { peer, display_name: data.get("display_name") });
    dialog.close();
    await hooks.boot();
    toast("Contact name saved.");
  });
  dialog.showModal();
  $<HTMLInputElement>("input", dialog).select();
}

function newDirectMessage() {
  if (document.querySelector(".dm-dialog")) return;
  const dialog = document.createElement("dialog");
  dialog.className = "card dialog dm-dialog";
  dialog.innerHTML = `<h2>New direct message</h2><p class="muted small">${listsMembers() ? `Pick someone on ${esc(state.session.instance)}, or type` : `Type the handle of someone on ${esc(state.session.instance)}, or`} the address of someone elsewhere, like <code>name@other.example</code>.</p>
    <form class="stack"><label>To<input name="to" required maxlength="2048" autocomplete="off" placeholder="Name or address"></label>
    <ul class="plain people-list" aria-label="Members"></ul><p class="form-error" role="alert"></p>
    <div class="row end"><button type="button" class="secondary" data-cancel>Cancel</button><button>Open conversation</button></div></form>`;
  document.body.append(dialog);
  const input = $<HTMLInputElement>("input", dialog),
    list = $(".people-list", dialog),
    me = state.session.user!.id;
  let people: User[] = [];
  const draw = () => {
    const query = input.value.trim().replace(/^@/, "").toLowerCase();
    const found = people
      .filter(
        (u) =>
          u.id !== me &&
          (u.username.toLowerCase().includes(query) ||
            u.display_name.toLowerCase().includes(query)),
      )
      .slice(0, 6);
    list.innerHTML = found
      .map(
        (u) =>
          `<li><button type="button" class="menu-item" data-open="${esc(u.actor_url)}">${avatar(u, "small")}<span class="grow"><strong>${esc(u.display_name)}</strong> <span class="handle">@${esc(u.username)}</span></span></button></li>`,
      )
      .join("");
  };
  const open = (peer: string) => {
    dialog.close();
    go(dmHref(peer));
  };
  input.addEventListener("input", draw);
  list.addEventListener("click", (e) => {
    const peer = (e.target as Element).closest<HTMLElement>("[data-open]")
      ?.dataset.open;
    if (peer) open(peer);
  });
  $("[data-cancel]", dialog).addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => dialog.remove());
  onSubmit($<HTMLFormElement>("form", dialog), async (data) => {
    const found = await api<Conversation>("/dms/resolve", "POST", {
      to: data.get("to"),
    });
    open(found.peer);
  });
  dialog.showModal();
  if (!listsMembers()) return;
  void api<User[]>("/users")
    .then((users) => {
      people = users;
      draw();
    })
    .catch(() => {
      /* The address can still be typed in full. */
    });
}
