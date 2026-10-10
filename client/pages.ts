import {
  $,
  $$,
  action,
  api,
  app,
  avatar,
  channelIcon,
  channelShares,
  esc,
  go,
  hooks,
  icon,
  modeLabel,
  shareDialog,
  onSubmit,
  socialsHtml,
  state,
  themeSeg,
  toast,
  type Channel,
} from "./shared.js";
import { sidebarFrame } from "./sidebar.js";
import { isFusion } from "./appearance.js";
import { updateFusionToolbar } from "./chat.js";
import { windowHtml } from "./windows.js";
import { channelWindow, federatedWindow, xmppWindow } from "./join.js";

interface FeaturedChannel { id: string; name: string; description: string; mode: string; address: string; joined: boolean; }

const plainTop = () =>
  `<header class="top"><div class="top-inner"><a class="brand" href="/">${icon("logo", "brand-mark")}<span>Archipel</span></a><span class="grow"></span><span class="muted small">${esc(state.session.instance)}</span></div></header>`;

export function renderLogin() {
  const s = state.session;
  app.innerHTML = `${plainTop()}<main class="page"><div class="card narrow signin-card"><h1>Sign in</h1><p class="muted">to ${esc(s.instance)}</p>
    ${s.oidc_enabled ? `<a class="button signin-link" href="/auth/login">Sign in with your identity provider</a>` : ""}
    ${s.dev_auth ? `<h2>Local development accounts</h2><div class="persona-list">${["alice", "bob", "charlie"].map((name) => `<button type="button" class="secondary" data-persona="${name}">${avatar({ username: name, display_name: name })}<span class="grow"><strong>${name}</strong><span class="muted small">${name === "alice" ? "Instance administrator" : "Member"}</span></span>${icon("chevron-right")}</button>`).join("")}</div>` : ""}
    ${!s.oidc_enabled && !s.dev_auth ? '<p class="muted">Sign-in is not configured for this instance yet.</p>' : ""}
    <p class="muted small signin-footnote">${s.registration_mode === "invite_only" ? "This instance requires approval. After sign-in, administrators can review your identity and any verified socials you choose to share with this instance through FedIdP." : "New accounts are admitted automatically."}</p>
    ${themeSeg()}</div></main>`;
  for (const button of $$<HTMLButtonElement>("[data-persona]"))
    button.addEventListener("click", () =>
      action(async () => {
        button.disabled = true;
        try {
          await api("/dev-login", "POST", { username: button.dataset.persona });
          await hooks.boot();
        } finally {
          button.disabled = false;
        }
      }),
    );
  if (new URLSearchParams(location.search).get("signin") === "failed") {
    toast("Sign-in could not be completed. Please try again.", true);
    history.replaceState(null, "", "/");
  }
}

export function renderAdmission() {
  const user = state.session.user!,
    rejected = user.admission_status === "rejected";
  app.innerHTML = `${plainTop()}<main class="page"><div class="card narrow-wide admission-screen"><h1>${rejected ? "Membership was declined" : "Waiting for approval"}</h1>
    <p>You're signed in as <strong>@${esc(user.username)}</strong> at ${esc(state.session.instance)}.</p>
    <p class="muted">${rejected ? "An instance administrator has declined your application. Contact the instance administrators if you want them to reconsider." : "An instance administrator will review your application before you can access conversations. This page updates when you are approved."}</p>
    <h2>Verified socials shared with administrators</h2>${socialsHtml(user.verified_socials)}
    <p class="muted small">Your provider supplies these claims. You can change what you share in FedIdP and sign in again to refresh them.</p>
    <button type="button" id="admission-signout" class="secondary">Sign out</button></div></main>`;
  $("#admission-signout").addEventListener("click", () =>
    action(async () => {
      await api("/logout", "POST", {});
      await hooks.boot();
    }),
  );
}

// Every channel this account can see, and a form to start one.
export function showChannels(view: HTMLElement, create: boolean) {
  document.querySelector("#fusion-directory-tools")?.replaceChildren();
  // Offered while the instance federates; a role that may not open channels to it sees why not.
  const mayFederate = !!state.session.user!.federate_channels;
  const federate = (cls: string) => state.session.federation_enabled
    ? `<label class="${cls}"${mayFederate ? "" : ' title="Your role does not allow opening channels to federation."'}><input type="checkbox" name="federate"${mayFederate ? "" : " disabled"}> Allow this channel to federate</label>`
    : "";
  const workspace = sidebarFrame(view);
  workspace.insertAdjacentHTML("beforeend", `<div class="page"><div class="page-inner directory"><div class="feed-head"><div><h1>Channels</h1><p class="muted small">Everything you can see on ${esc(state.session.instance)}.${state.session.federation_enabled ? ' Find <a href="#/settings/federation/remote">channels on other servers</a>.' : ""}</p></div></div>
    <div class="directory-toolbar fusion-only">${state.session.user!.create_channels ? `<button type="button" class="secondary" id="open-create-channel">${icon("plus")} New channel</button>` : ""}${state.session.federation_enabled ? `<button type="button" class="secondary" data-open-window="federated">${icon("globe")} Join a federated channel</button>` : ""}${state.xmppEnabled ? `<button type="button" class="secondary" data-open-window="xmpp">${icon("xmpp")} Join an XMPP room</button>` : ""}</div>
    <div class="layout"><section><label class="search-field">${icon("search")}<input type="search" id="channel-search" placeholder="Search channels" aria-label="Search channels"></label><section id="featured-list" class="default-only" hidden></section><ul class="plain browse-list" id="browse-list"></ul><div class="channel-table-wrap"><table class="channel-table"><thead><tr><th>Name</th><th class="channel-description">Description</th><th>Style</th><th>Members</th><th>Status</th><th class="directory-action"><span class="visually-hidden">Action</span></th></tr></thead><tbody id="channel-table-body"></tbody></table></div></section>
    <aside>${state.session.federation_enabled ? '<section class="card"><h2>Federated channels</h2><p class="muted">Follow a channel hosted on another Archipel instance.</p><a class="button secondary" href="#/settings/federation/remote">Join a federated channel</a></section>' : ""}${state.xmppEnabled ? '<section class="card"><h2>XMPP rooms</h2><p class="muted">Join a conversation hosted on another XMPP server.</p><a class="button secondary" href="#/xmpp">Join an XMPP room</a></section>' : ""}${state.session.user!.create_channels ? "" : '<section class="card"><h2>Create a channel</h2><p class="muted">Your role does not allow creating channels.</p></section>'}<section class="card" id="new-channel" ${state.session.user!.create_channels ? "" : "hidden"}><h2>Create a channel</h2><form class="stack">
      <label>Channel name<span class="input-prefix"><span>#</span><input name="name" required minlength="2" maxlength="40" pattern="[a-zA-Z0-9][a-zA-Z0-9_\\-]{1,39}" placeholder="general" autocomplete="off"></span></label>
      <p class="muted small" id="create-summary">A running conversation anyone on this instance can read and join.</p>
      <details class="create-options"><summary>More options</summary><div class="stack">
      <label>Description<textarea name="description" maxlength="500" rows="2" placeholder="What is it for?"></textarea></label>
      <label>Conversation style<select name="mode"><option value="timeline">Timeline: one running conversation</option><option value="topical">Topics: messages grouped by subject</option><option value="threaded">Threads: posts with nested replies</option></select></label>
      <label class="check" id="create-optional-titles" hidden><input type="checkbox" name="optional_titles"> Let threads start without a title</label>
      <label>Who can read?<select name="visibility"><option value="public">Everyone on this instance</option><option value="members">Members only</option></select></label>
      <label>Who can join?<select name="admission"><option value="open">Anyone on this instance</option><option value="allowlist">Invited users only</option></select></label>
      <label class="check"><input type="checkbox" name="show_members" checked> Show the member list</label>
      <label class="check"><input type="checkbox" name="hide_handles"> Hide handles, leaving only display names</label>
      ${federate("check")}
      </div></details><p class="form-error" role="alert"></p><button>Create channel</button></form></section></aside></div></div></div>`);
  const list = $("#browse-list"),
    search = $<HTMLInputElement>("#channel-search");
  $(".directory-toolbar").insertAdjacentHTML("afterend", '<span id="directory-toolbar-home" hidden></span>');
  $(".search-field").insertAdjacentHTML("afterend", '<span id="directory-search-home" hidden></span>');
  let featured: FeaturedChannel[] = [];
  // The Fusion table: sections fold, and a row is selected before it is opened.
  const folded = new Set<string>();
  let picked = "";
  const plural = (n: number) => `${n} channel${n === 1 ? "" : "s"}`;
  const section = (key: string, title: string, note: string, rows: string[]) => rows.length
    ? `<tr class="table-section"><th colspan="6"><div class="table-section-row"><button type="button" class="section-toggle" data-directory-section="${key}" aria-expanded="${!folded.has(key)}">${icon("chevron-down", "chev")}<strong>${title}</strong></button><span class="muted grow">${note}</span><span class="muted">${plural(rows.length)}</span></div></th></tr>${folded.has(key) ? "" : rows.join("")}`
    : "";
  const row = (id: string, cells: string, status: string, joined: boolean, control: string) =>
    `<tr class="directory-row${picked === id ? " selected-row" : ""}" data-directory-row="${esc(id)}">${cells}<td class="${joined ? "" : "muted"}">${status}</td><td class="directory-action">${control}</td></tr>`;
  function draw() {
    const query = search.value.trim().toLowerCase();
    const visible = state.channels.filter(
      (c) =>
        c.name.toLowerCase().includes(query) ||
        c.description.toLowerCase().includes(query),
    );
    const html = visible.length
      ? visible
          .map(
            (c) =>
              `<li class="browse-channel"><a href="#/c/${c.id}" data-id="${c.id}" class="browse-name">${channelIcon(c)}<strong>${esc(c.name)}</strong></a><span class="pill">${modeLabel(c.mode)}</span>${c.visibility === "members" ? '<span class="pill">Members only</span>' : ""}${c.remote_actor ? '<span class="pill new">Remote</span>' : ""}${c.role ? '<span class="pill good">Joined</span>' : !c.readable ? '<span class="pill warn">Invited</span>' : ""}
              <p class="muted">${esc(c.description || "No description.")}</p><span class="muted small">${c.member_count} member${c.member_count === 1 ? "" : "s"}</span></li>`,
          )
          .join("")
      : `<li class="muted">${query ? "No channels match." : "No channels yet. Create the first one."}</li>`;
    if (list.dataset.html !== html) list.innerHTML = list.dataset.html = html;
    const picks = featured.filter(c => `${c.name} ${c.description} ${c.address}`.toLowerCase().includes(query));
    const mayFollow = state.session.federation_enabled && state.session.user?.federation_subscribe && state.session.user?.federation_receive;
    const featuredRows = picks.map(c => row(`featured:${c.id}`, `<td><span class="directory-name">${icon("globe")}<strong>${esc(c.name)}</strong><span class="muted">@${esc(new URL(c.address).host)}</span></span></td><td class="channel-description">${esc(c.description)}</td><td>${esc(modeLabel(c.mode))}</td><td class="muted">n/a</td>`, c.joined ? "Joined" : "Not joined", c.joined,
      c.joined ? `<a class="button secondary small" href="#/c/${c.id}">Open</a>` : `<button type="button" class="secondary small" data-featured-join="${esc(c.address)}" ${mayFollow ? "" : 'disabled title="Your role must allow subscribing to and receiving federated channels"'}>Join</button>`));
    const recommended = $("#featured-list");
    recommended.hidden = !picks.length;
    recommended.innerHTML = picks.length ? `<h2>Featured from other servers</h2><ul class="plain">${picks.map(c => `<li class="row">${icon("globe")}<div class="grow"><strong>${esc(c.name)}</strong><p class="muted small">${esc(c.description)} · ${esc(new URL(c.address).host)}</p></div>${c.joined ? `<a class="button secondary small" href="#/c/${c.id}">Open</a>` : `<button type="button" class="secondary small" data-featured-join="${esc(c.address)}" ${state.session.federation_enabled && state.session.user?.federation_subscribe && state.session.user?.federation_receive ? "" : "disabled"}>Subscribe</button>`}</li>`).join("")}</ul>` : "";
    const rows = visible.filter(c => !picks.some(p => p.id === c.id)).map(c => row(c.id, `<td><a class="directory-name" href="#/c/${c.id}" data-id="${c.id}">${channelIcon(c, false)}<strong>${esc(c.name)}</strong></a></td><td class="channel-description${c.description ? "" : " muted"}">${esc(c.description || "No description.")}</td><td>${modeLabel(c.mode)}</td><td>${c.member_count}</td>`,
      c.role ? "Joined" : c.can_join && c.admission === "allowlist" ? "Invited" : c.can_join || c.readable ? "Not joined" : "Invitation required", !!c.role || (c.can_join && c.admission === "allowlist"),
      c.role ? `<a class="button secondary small" href="#/c/${c.id}">Open</a>` : c.can_join ? `<button type="button" class="secondary small" data-directory-join="${c.id}">Join</button>` : c.readable ? `<a class="button secondary small" href="#/c/${c.id}">View</a>` : ""));
    const table = $("#channel-table-body");
    const tableHtml = `${section("featured", "Featured from other servers", "Chosen by this instance's administrators", featuredRows)}${section("local", "On this instance", "", rows)}${!rows.length && !featuredRows.length ? '<tr><td colspan="6">No channels match.</td></tr>' : ""}`;
    table.dataset.summary = `${plural(rows.length)} here${featuredRows.length ? `, ${featuredRows.length} featured` : ""}`;
    updateFusionToolbar();
    if (table.dataset.html !== tableHtml) table.innerHTML = table.dataset.html = tableHtml;
  }
  draw();
  refreshFeatured = () => { void api<FeaturedChannel[]>("/featured-channels").then(result => { featured = result; if (search.isConnected) draw(); }).catch(() => {}); };
  refreshFeatured();
  search.addEventListener("input", draw);
  $(".directory").addEventListener("click", event => {
    const target = event.target as Element;
    const fold = target.closest<HTMLElement>("[data-directory-section]");
    if (fold) {
      const key = fold.dataset.directorySection!;
      if (!folded.delete(key)) folded.add(key);
      return draw();
    }
    const chosen = target.closest<HTMLElement>("[data-directory-row]");
    if (chosen) {
      picked = chosen.dataset.directoryRow!;
      for (const el of $$("[data-directory-row]", $("#channel-table-body"))) el.classList.toggle("selected-row", el === chosen);
    }
    const join = target.closest<HTMLElement>("[data-directory-join]");
    const external = target.closest<HTMLElement>("[data-featured-join]");
    if (join) action(async () => {
      const c = state.channels.find(c => c.id === join.dataset.directoryJoin)!;
      if (!(await shareDialog(`Join #${c.name}?`, channelShares(c), "Join channel"))) return;
      await api(`/channels/${c.id}/join`, "POST", {});
      state.channels = await api<Channel[]>("/channels");
      go(`#/c/${c.id}`);
    });
    if (external) action(async () => {
      if (!(await shareDialog("Subscribe to this featured channel?", ["Your address, display name and profile picture are shared with the channel's home instance and whoever it shows them to.", "Your messages are shared with the channel's home and the servers of its subscribers."], "Subscribe"))) return;
      await api("/federation/subscriptions", "POST", { address: external.dataset.featuredJoin });
      toast("Subscription requested. Its home instance must accept it.");
      go("#/settings/federation/remote");
    });
    const link = target.closest<HTMLElement>("[data-id]");
    const c = state.channels.find(c => c.id === link?.dataset.id);
    if (c && !c.readable && c.can_join && !link!.closest("#browse-list")) {
      event.preventDefault();
      action(async () => {
        if (!(await shareDialog(`Join #${c.name}?`, channelShares(c), "Join channel"))) return;
        await api(`/channels/${c.id}/join`, "POST", {});
        state.channels = await api<Channel[]>("/channels");
        go(`#/c/${c.id}`);
      });
    }
  });
  $(".directory").addEventListener("dblclick", event => {
    const target = event.target as Element;
    if (target.closest("a, button")) return;
    target.closest("[data-directory-row]")?.querySelector<HTMLElement>(".directory-action :is(a, button)")?.click();
  });
  // An invitation makes a members-only channel readable once it's accepted, so opening it joins.
  list.addEventListener("click", (e) => {
    const link = (e.target as Element).closest<HTMLElement>("[data-id]");
    const channel = state.channels.find((c) => c.id === link?.dataset.id);
    if (!channel || channel.readable || !channel.can_join) return;
    e.preventDefault();
    action(async () => {
      if (!(await shareDialog(`Join #${channel.name}?`, channelShares(channel), "Join channel")))
        return;
      await api(`/channels/${channel.id}/join`, "POST", {});
      state.channels = await api<Channel[]>("/channels");
      go(`#/c/${channel.id}`);
    });
  });
  const form = $<HTMLFormElement>("#new-channel form");
  // The card and the Fusion window ask the same things, each in its own form.
  const summary = (data: FormData) => {
    const style = data.get("mode") === "threaded" ? "Posts with nested replies" : data.get("mode") === "topical" ? "Messages grouped by topic" : "A running conversation";
    return `${style}. ${data.get("visibility") === "members" ? "Members can read" : "Anyone on this instance can read"}; ${data.get("admission") === "allowlist" ? "joining requires an invitation" : "anyone here can join"}.${data.get("federate") === "on" ? " Other instances can follow it." : ""}`;
  };
  form.addEventListener("change", () => {
    const data = new FormData(form);
    $("#create-optional-titles", form).hidden = data.get("mode") !== "threaded";
    $("#create-summary", form).textContent = summary(data);
  });
  const submit = (each: HTMLFormElement) => onSubmit(each, async (data) => {
    const open = data.get("federate") === "on";
    data.delete("federate");
    const channel = await api<Channel>(
      "/channels",
      "POST",
      {
        ...Object.fromEntries(data),
        show_members: data.get("show_members") === "on",
        hide_handles: data.get("hide_handles") === "on",
        optional_titles: data.get("mode") === "threaded" && data.get("optional_titles") === "on",
      },
    );
    // The channel exists by now, whatever comes of opening it to other instances.
    if (open)
      await api(`/channels/${channel.id}/federation`, "PATCH", { enabled: true }).catch((error) =>
        toast(`The channel was created, but is not federated: ${error instanceof Error ? error.message : "that could not be saved."}`));
    state.channels = await api<Channel[]>("/channels");
    dialog?.close();
    go(`#/c/${channel.id}`);
  });
  submit(form);
  // Fusion asks in a window instead. It is on the page only in that style, and keeps a draft while the directory stays open.
  let dialog: HTMLDialogElement | null = null;
  mountCreator = () => {
    const directory = document.querySelector(".directory");
    if (!directory || !isFusion() || !state.session.user!.create_channels) {
      dialog?.remove();
      dialog = null;
      return;
    }
    if (dialog?.isConnected) return;
    directory.insertAdjacentHTML("beforeend", `<dialog class="fusion-window create-channel-dialog" aria-labelledby="creator-heading">${windowHtml("creator-heading", "Create a channel", `
      <div class="field-grid"><label for="cc-name">Name</label><div class="icon-field">${icon("hash")}<input id="cc-name" name="name" required minlength="2" maxlength="40" pattern="[a-zA-Z0-9][a-zA-Z0-9_\\-]{1,39}" autocomplete="off"></div>
        <label for="cc-desc" class="top">Description</label><textarea id="cc-desc" name="description" maxlength="500" rows="2" placeholder="What is it for?"></textarea></div>
      <fieldset><legend>Conversation style</legend>${[["timeline", "Timeline", "hash", "one running conversation"], ["topical", "Topics", "folder", "messages grouped by subject"], ["threaded", "Threads", "needle-thread", "posts with nested replies"]].map(([value, label, ico, about]) => `<label class="choice"><input type="radio" name="mode" value="${value}" ${value === "timeline" ? "checked" : ""}>${icon(ico)}<span><strong>${label}</strong> <span class="muted">${about}</span></span></label>`).join("")}
        <label class="choice sub"><input type="checkbox" name="optional_titles" disabled>Let threads start without a title</label></fieldset>
      <fieldset><legend>Access</legend><div class="field-grid"><label for="cc-read">Who can read</label><select id="cc-read" name="visibility"><option value="public">Everyone on this instance</option><option value="members">Members only</option></select>
        <label for="cc-join">Who can join</label><select id="cc-join" name="admission"><option value="open">Anyone on this instance</option><option value="allowlist">Invited users only</option></select></div></fieldset>
      <fieldset><legend>Members</legend><label class="choice"><input type="checkbox" name="show_members" checked>Show the member list</label>
        <label class="choice"><input type="checkbox" name="hide_handles">Hide handles, leaving only display names</label></fieldset>
      ${state.session.federation_enabled ? `<fieldset><legend>Federation</legend>${federate("choice")}</fieldset>` : ""}
      <p class="muted" id="fusion-create-summary"></p>`, '<button type="button" class="secondary" data-close-window>Cancel</button><button>Create channel</button>', "Close create channel")}</dialog>`);
    dialog = $<HTMLDialogElement>(".create-channel-dialog", directory as HTMLElement);
    const windowForm = $<HTMLFormElement>("form", dialog);
    const describe = () => {
      const data = new FormData(windowForm);
      $<HTMLInputElement>("[name=optional_titles]", windowForm).disabled = data.get("mode") !== "threaded";
      $("#fusion-create-summary", windowForm).textContent = summary(data);
    };
    windowForm.addEventListener("change", describe);
    describe();
    submit(windowForm);
  };
  const openCreator = () => {
    dialog?.showModal();
    dialog?.querySelector<HTMLInputElement>("input[name=name]")?.focus();
  };
  document.querySelector("#open-create-channel")?.addEventListener("click", openCreator);
  adaptChannelCreator();
  if (create) {
    if (dialog) openCreator();
    else {
      $("#new-channel").scrollIntoView({ block: "nearest" });
      $<HTMLInputElement>("input[name=name]", form).focus();
    }
  }
}
// Fusion puts the directory's commands and search in the command strip, and asks in windows.
function adaptChannelCreator() {
  const toolbar = document.querySelector(".directory-toolbar"), search = document.querySelector(".search-field");
  mountCreator();
  if (!toolbar || !search) return;
  if (isFusion()) {
    const tools = document.querySelector("#fusion-directory-tools");
    if (tools) { tools.replaceChildren(toolbar); tools.append(search); }
  } else {
    for (const open of document.querySelectorAll<HTMLDialogElement>("dialog.fusion-window[open]")) open.close();
    document.querySelector("#directory-toolbar-home")?.before(toolbar);
    document.querySelector("#directory-search-home")?.before(search);
  }
  document.querySelector<HTMLInputElement>("#channel-search")?.dispatchEvent(new Event("input"));
}
document.addEventListener("click", (event) => {
  const opener = (event.target as Element).closest<HTMLElement>("[data-open-window]"),
    which = opener?.dataset.openWindow;
  // The windows are Fusion's: in another style a link goes to the page that asks the same.
  if (!opener || (!isFusion() && opener.matches("a[href]"))) return;
  event.preventDefault();
  if (which === "federated") federatedWindow();
  else if (which === "xmpp") action(xmppWindow);
  else if (which === "channel") channelWindow();
});
document.addEventListener("appearance-change", adaptChannelCreator);
let refreshFeatured = () => {}, mountCreator = () => {};
// Kept up to date while it's on screen, unless someone is typing in the search.
export function tickChannels() {
  const search = document.querySelector<HTMLInputElement>("#channel-search");
  if (search) { search.dispatchEvent(new Event("input")); refreshFeatured(); }
}
