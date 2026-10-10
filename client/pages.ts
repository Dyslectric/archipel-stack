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

interface FeaturedChannel { id: string; name: string; description: string; mode: string; address: string; joined: boolean; }

const plainTop = () =>
  `<header class="top"><div class="top-inner"><a class="brand" href="/">${icon("logo", "brand-mark")}<span>Archipel</span></a><span class="grow"></span><span class="muted small">${esc(state.session.instance)}</span></div></header>`;

export function renderLogin() {
  const s = state.session;
  app.innerHTML = `${plainTop()}<main class="page"><div class="card narrow signin-card"><h1>Sign in</h1><p class="muted">to ${esc(s.instance)}</p>
    ${s.oidc_enabled ? `<a class="button signin-link" href="/auth/login">Sign in with your identity provider</a>` : ""}
    ${s.dev_auth ? `<h2>Local development accounts</h2><div class="persona-list">${["alice", "bob", "charlie"].map((name) => `<button type="button" class="secondary" data-persona="${name}">${avatar({ username: name, display_name: name })}<span class="grow"><strong>${name}</strong><span class="muted small">${name === "alice" ? "Instance administrator" : "Member"}</span></span>${icon("chevron-right")}</button>`).join("")}</div>` : ""}
    ${!s.oidc_enabled && !s.dev_auth ? '<p class="muted">Sign-in is not configured for this instance yet.</p>' : ""}
    <p class="muted small signin-footnote">${s.registration_mode === "invite_only" ? "This instance requires approval. After sign-in, administrators can review your identity and any verified socials you choose to share with Archipel through FedIdP." : "New accounts are admitted automatically."}</p>
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
  const workspace = sidebarFrame(view);
  workspace.insertAdjacentHTML("beforeend", `<div class="page"><div class="page-inner directory"><div class="feed-head"><div><h1>Channels</h1><p class="muted small">Everything you can see on ${esc(state.session.instance)}. Find <a href="#/settings/federation/remote">channels on other servers</a>.</p></div></div>
    <div class="directory-toolbar fusion-only">${state.session.user!.create_channels ? `<button type="button" class="secondary" id="open-create-channel">${icon("plus")} Create channel</button>` : ""}<a class="button secondary" href="#/settings/federation/remote">${icon("globe")} Join a federated channel</a><a class="button secondary" href="#/xmpp">${icon("xmpp")} Join an XMPP room</a></div>
    <div class="layout"><section><label class="search-field">${icon("search")}<input type="search" id="channel-search" placeholder="Search channels" aria-label="Search channels"></label><section id="featured-list" class="default-only" hidden></section><ul class="plain browse-list" id="browse-list"></ul><div class="channel-table-wrap"><table class="channel-table"><thead><tr><th>Name</th><th class="channel-description">Description</th><th>Style</th><th>Members</th><th>Status</th></tr></thead><tbody id="channel-table-body"></tbody></table></div></section>
    <aside><section class="card"><h2>Federated channels</h2><p class="muted">Follow a channel hosted on another Archipel instance.</p><a class="button secondary" href="#/settings/federation/remote">Join a federated channel</a></section><section class="card"><h2>XMPP rooms</h2><p class="muted">Join a conversation hosted on another XMPP server.</p><a class="button secondary" href="#/xmpp">Join an XMPP room</a></section>${state.session.user!.create_channels ? "" : '<section class="card"><h2>Create a channel</h2><p class="muted">Your role does not allow creating channels.</p></section>'}<section class="card" id="new-channel" ${state.session.user!.create_channels ? "" : "hidden"}><h2>Create a channel</h2><form class="stack">
      <label>Channel name<span class="input-prefix"><span>#</span><input name="name" required minlength="2" maxlength="40" pattern="[a-zA-Z0-9][a-zA-Z0-9_\\-]{1,39}" placeholder="general" autocomplete="off"></span></label>
      <p class="muted small" id="create-summary">A running conversation anyone on this instance can read and join.</p>
      <details class="create-options"><summary>More options</summary><div class="stack">
      <label>Description<textarea name="description" maxlength="500" rows="2" placeholder="What is it for?"></textarea></label>
      <label class="default-only">Conversation style<select name="mode"><option value="timeline">Timeline: one running conversation</option><option value="topical">Topics: messages grouped by subject</option><option value="threaded">Threads: posts with nested replies</option></select></label>
      <fieldset class="fusion-only mode-choices"><legend>Conversation style</legend>${[["timeline", "Timeline", "hash"], ["topical", "Topics", "folder"], ["threaded", "Threads", "needle-thread"]].map(([value, label, ico]) => `<label class="check"><input type="radio" name="fusion_mode" value="${value}" ${value === "timeline" ? "checked" : ""}>${icon(ico)} ${label}</label>`).join("")}</fieldset>
      <label class="check" id="create-optional-titles" hidden><input type="checkbox" name="optional_titles"> Let threads start without a title</label>
      <label>Who can read?<select name="visibility"><option value="public">Everyone on this instance</option><option value="members">Members only</option></select></label>
      <label>Who can join?<select name="admission"><option value="open">Anyone on this instance</option><option value="allowlist">Invited users only</option></select></label>
      <label class="check"><input type="checkbox" name="show_members" checked> Show the member list</label>
      <label class="check"><input type="checkbox" name="hide_handles"> Hide handles, leaving only display names</label>
      </div></details><p class="form-error" role="alert"></p><button>Create channel</button></form></section><span id="creator-home" hidden></span></aside></div><dialog class="create-channel-dialog" aria-labelledby="creator-heading"><div class="dialog-heading"><h2 id="creator-heading">Create a channel</h2><button type="button" class="icon-button" data-close-creator aria-label="Close create channel">${icon("x")}</button></div></dialog></div></div>`);
  const list = $("#browse-list"),
    search = $<HTMLInputElement>("#channel-search");
  $(".directory-toolbar").insertAdjacentHTML("afterend", '<span id="directory-toolbar-home" hidden></span>');
  $(".search-field").insertAdjacentHTML("afterend", '<span id="directory-search-home" hidden></span>');
  let featured: FeaturedChannel[] = [];
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
    const featuredRows = picks.map(c => `<tr><td><span class="directory-name">${icon("globe")}<strong>${esc(c.name)}</strong></span><div class="muted small">${esc(new URL(c.address).host)}</div></td><td class="channel-description">${esc(c.description)}</td><td>${esc(modeLabel(c.mode))}</td><td>—</td><td>${c.joined ? `<a class="button secondary small" href="#/c/${c.id}">Open</a>` : `<button type="button" class="secondary small" data-featured-join="${esc(c.address)}" ${state.session.federation_enabled && state.session.user?.federation_subscribe && state.session.user?.federation_receive ? "" : 'disabled title="Your role must allow subscribing to and receiving federated channels"'}>Subscribe</button>`}</td></tr>`).join("");
    const recommended = $("#featured-list");
    recommended.hidden = !picks.length;
    recommended.innerHTML = picks.length ? `<h2>Featured from other servers</h2><ul class="plain">${picks.map(c => `<li class="row">${icon("globe")}<div class="grow"><strong>${esc(c.name)}</strong><p class="muted small">${esc(c.description)} · ${esc(new URL(c.address).host)}</p></div>${c.joined ? `<a class="button secondary small" href="#/c/${c.id}">Open</a>` : `<button type="button" class="secondary small" data-featured-join="${esc(c.address)}" ${state.session.federation_enabled && state.session.user?.federation_subscribe && state.session.user?.federation_receive ? "" : "disabled"}>Subscribe</button>`}</li>`).join("")}</ul>` : "";
    const rows = visible.filter(c => !picks.some(p => p.id === c.id)).map(c => `<tr><td><a class="directory-name" href="#/c/${c.id}" data-id="${c.id}">${channelIcon(c)}<strong>${esc(c.name)}</strong></a></td><td class="channel-description">${esc(c.description)}</td><td>${modeLabel(c.mode)}</td><td>${c.member_count}</td><td>${c.role ? `<a class="button secondary small" href="#/c/${c.id}">Open</a>` : c.can_join ? `<button type="button" class="secondary small" data-directory-join="${c.id}">Join</button>` : c.readable ? `<a class="button secondary small" href="#/c/${c.id}">View</a>` : '<span class="muted">Invitation required</span>'}</td></tr>`).join("");
    const table = $("#channel-table-body");
    const tableHtml = `${featuredRows ? '<tr class="table-section"><th colspan="5">Featured from other servers</th></tr>' + featuredRows : ""}${rows ? '<tr class="table-section"><th colspan="5">Channels</th></tr>' + rows : ""}${!rows && !featuredRows ? '<tr><td colspan="5">No channels match.</td></tr>' : ""}`;
    if (table.dataset.html !== tableHtml) table.innerHTML = table.dataset.html = tableHtml;
  }
  draw();
  refreshFeatured = () => { void api<FeaturedChannel[]>("/featured-channels").then(result => { featured = result; if (search.isConnected) draw(); }).catch(() => {}); };
  refreshFeatured();
  search.addEventListener("input", draw);
  $(".directory").addEventListener("click", event => {
    const target = event.target as Element;
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
  const dialog = $<HTMLDialogElement>(".create-channel-dialog");
  $("[data-close-creator]", dialog).addEventListener("click", () => dialog.close());
  document.querySelector("#open-create-channel")?.addEventListener("click", () => { dialog.showModal(); $<HTMLInputElement>("input[name=name]", form).focus(); });
  adaptChannelCreator();
  form.addEventListener("change", () => {
    const data = new FormData(form);
    $("#create-optional-titles", form).hidden = data.get("mode") !== "threaded";
    const style = data.get("mode") === "threaded" ? "Posts with nested replies" : data.get("mode") === "topical" ? "Messages grouped by topic" : "A running conversation";
    $("#create-summary", form).textContent = `${style}. ${data.get("visibility") === "members" ? "Members can read" : "Anyone on this instance can read"}; ${data.get("admission") === "allowlist" ? "joining requires an invitation" : "anyone here can join"}.`;
  });
  for (const radio of $$<HTMLInputElement>("[name=fusion_mode]", form)) radio.addEventListener("change", () => {
    $<HTMLSelectElement>("[name=mode]", form).value = radio.value;
    form.dispatchEvent(new Event("change"));
  });
  onSubmit(form, async (data) => {
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
    state.channels = await api<Channel[]>("/channels");
    dialog.close();
    go(`#/c/${channel.id}`);
  });
  if (create) {
    if (isFusion() && state.session.user!.create_channels) dialog.showModal();
    $("#new-channel").scrollIntoView({ block: "nearest" });
    $<HTMLInputElement>("input[name=name]", form).focus();
  }
}
function adaptChannelCreator() {
  const creator = document.querySelector<HTMLElement>("#new-channel");
  const dialog = document.querySelector<HTMLDialogElement>(".create-channel-dialog");
  const home = document.querySelector<HTMLElement>("#creator-home");
  if (!creator || !dialog || !home) return;
  if (isFusion()) {
    dialog.append(creator);
    $<HTMLDetailsElement>(".create-options", creator).open = true;
    const tools = document.querySelector("#fusion-directory-tools");
    const toolbar = document.querySelector(".directory-toolbar");
    const search = document.querySelector(".search-field");
    if (tools && toolbar) { tools.replaceChildren(toolbar); if (search) tools.append(search); }
  } else {
    dialog.close();
    home.before(creator);
    const toolbar = document.querySelector(".directory-toolbar");
    const search = document.querySelector(".search-field");
    if (toolbar) document.querySelector("#directory-toolbar-home")?.before(toolbar);
    if (search) document.querySelector("#directory-search-home")?.before(search);
  }
  const mode = $<HTMLSelectElement>("[name=mode]", creator).value;
  for (const radio of $$<HTMLInputElement>("[name=fusion_mode]", creator)) radio.checked = radio.value === mode;
  document.querySelector<HTMLInputElement>("#channel-search")?.dispatchEvent(new Event("input"));
}
document.addEventListener("appearance-change", adaptChannelCreator);
let refreshFeatured = () => {};
// Kept up to date while it's on screen, unless someone is typing in the search.
export function tickChannels() {
  const search = document.querySelector<HTMLInputElement>("#channel-search");
  if (search) { search.dispatchEvent(new Event("input")); refreshFeatured(); }
}
