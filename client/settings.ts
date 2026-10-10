import {
  $,
  $$,
  action,
  api,
  avatar,
  canModerate,
  channelIcon,
  confirmDialog,
  emojiHtml,
  esc,
  full,
  go,
  hooks,
  listsMembers,
  icon,
  imageBase64,
  modeLabel,
  nameButton,
  onSubmit,
  shareDialog,
  socialsHtml,
  state,
  themeSeg,
  toast,
  when,
  refreshTimes,
  roleLabel,
  type Channel,
  type Conversation,
  type CustomEmoji,
  type Overview,
  type Session,
  type User,
} from "./shared.js";
import { chatChannel, resetChat } from "./chat.js";
import { hourChoices, styleChoices, textScaleControls } from "./appearance.js";
import { renderSidebar, sidebarFrame } from "./sidebar.js";
import { mirrorDialog } from "./mirrors.js";
import { subscribeRemote } from "./join.js";
import {
  disablePush,
  enablePush,
  pushBlocked,
  pushOn,
  pushSupported,
  testPush,
} from "./notify.js";
import type { Pref } from "./shared.js";

// Settings are pages you can move between from the list on the left: yours, federation,
// a channel's, and the instance's. Each section draws itself into the page and redraws
// (ctx.refresh) after a change.
interface Ctx {
  channel: Channel | null;
  refresh: () => Promise<void>;
}
interface Section {
  group: "personal" | "federation" | "channel" | "instance";
  key: string;
  label: string;
  about: string;
  icon: string;
  admin?: boolean; // instance administrators only
  mod?: boolean; // the channel's moderators only
  mirror?: boolean; // mirrors only
  draw: (el: HTMLElement, ctx: Ctx) => Promise<void>;
}
const groups = {
  personal: "Personal",
  federation: "Other servers",
  channel: "Channel",
  instance: "Instance",
};
const card = (title: string, body: string, about = "") =>
  `<section class="card settings-section"><h2>${title}</h2>${about ? `<p class="muted small">${about}</p>` : ""}${body}</section>`;
const error = '<p class="form-error" role="alert"></p>';
const shortcode =
  'required maxlength="64" pattern="[a-z0-9][a-z0-9_-]*" autocomplete="off"';
const images =
  'type="file" accept="image/png,image/jpeg,image/gif,image/webp" required';
// What a role grants, in the order the form lists it.
const rolePermissions = [
  ["create_channels", "Create channels"],
  ["federate_channels", "Open their channels to federation"],
  ["direct_messages", "Send direct messages"],
  ["attachments", "Attach images and videos"],
  ["xmpp_rooms", "Join XMPP rooms on other servers"],
  ["list_members", "See the list of everyone on this instance"],
  ["federation_send", "Send federated messages"],
  ["federation_receive", "Receive federated messages"],
  ["federation_subscribe", "Subscribe to remote channels"],
  ["federation_post", "Post in federated channels"],
] as const;
type RolePermission = (typeof rolePermissions)[number][0];
type Role = {
  id: string;
  name: string;
  is_default: boolean;
  members: number;
} & Record<RolePermission, boolean>;
const roleBoxes = (role?: Role) =>
  rolePermissions
    .map(
      ([flag, label]) =>
        `${flag === "federation_send" ? '<p class="muted small role-split">With other instances and servers, while federation is enabled:</p>' : ""}<label class="check"><input type="checkbox" name="${flag}" ${(role ? role[flag] : !flag.startsWith("federation_") && flag !== "list_members") ? "checked" : ""}> ${label}</label>`,
    )
    .join("");
const roleValues = (data: FormData) => ({
  name: data.get("name"),
  ...Object.fromEntries(
    rolePermissions.map(([flag]) => [flag, data.get(flag) === "on"]),
  ),
});
const person = (u: User, note: string, controls = "") =>
  `<li class="member-row">${avatar(u)}<div class="grow">${nameButton(u, u.actor_url)}${u.username ? ` <span class="muted">@${esc(u.username)}</span>` : ""}<div class="muted small">${note}</div></div>${controls}</li>`;
// Buttons that carry out one change and redraw the section.
function onClick(
  el: HTMLElement,
  selector: string,
  fn: (button: HTMLButtonElement) => Promise<void>,
) {
  for (const button of $$<HTMLButtonElement>(selector, el))
    button.addEventListener("click", () =>
      action(async () => {
        button.disabled = true;
        try {
          await fn(button);
        } finally {
          button.disabled = false;
        }
      }),
    );
}

async function drawDirectMessages(root: ParentNode = document) {
  const list = root.querySelector<HTMLElement>("#federated-direct-list");
  if (!list) return;
  const messages = await api<
    {
      id: string;
      peer: string;
      body: string;
      direction: string;
      created_at: string;
      emojis: CustomEmoji[];
      queued?: boolean;
      failed?: string;
    }[]
  >("/federation/messages");
  const html = messages.length
    ? messages
        .map(
          (m) =>
            `<li class="direct-message${m.queued ? ` queued${m.failed ? " failed" : ""}` : ""}"><div class="meta small"><span class="pill ${m.direction === "incoming" ? "new" : ""}">${m.direction === "incoming" ? "From" : "To"}</span> <span class="author">${esc(m.peer)}</span> · ${when(m.created_at)}${m.queued ? ` · <span role="status" class="${m.failed ? "bad-text" : ""}" title="${esc(m.failed || "Waiting for the other server")}">${m.failed ? "Not delivered" : "Sending…"}</span>` : ""}</div><div class="message-body">${emojiHtml(m.body, m.emojis)}</div></li>`,
        )
        .join("")
    : '<li class="muted">No federated direct messages.</li>';
  if (list.dataset.html !== html) list.innerHTML = list.dataset.html = html;
  refreshTimes(list);
}

const sections: Section[] = [
  {
    group: "personal",
    key: "xmpp",
    label: "XMPP clients",
    about: "Use your account on this instance in another messaging app.",
    icon: "chat",
    async draw(el, ctx) {
      const connection = await api<{
        enabled: boolean; jid?: string; domain?: string; port?: number;
        credentials?: { id: string; label: string; created_at: string }[];
        channels?: { name: string; jid: string }[];
      }>("/xmpp");
      if (!connection.enabled) {
        el.innerHTML = card("XMPP clients", '<p class="muted">XMPP connections have not been enabled by your instance administrator.</p>');
        return;
      }
      el.innerHTML = card("Connect a client", `<p>Account address: <strong>${esc(connection.jid)}</strong></p><p class="muted small">Connect to ${esc(connection.domain)} on port ${connection.port} using STARTTLS. Create a separate password for each app. Your identity-provider password is not used here.</p>
        <form class="stack narrow-form" id="xmpp-password-form"><label>App name<input name="label" maxlength="80" placeholder="My phone" required></label>${error}<button>Create app password</button></form><div id="xmpp-new-password" aria-live="polite"></div>`) +
        card("App passwords", `<ul class="member-list">${connection.credentials!.length ? connection.credentials!.map(item => `<li class="member-row"><div class="grow"><strong>${esc(item.label)}</strong><div class="muted small">Created ${when(item.created_at)}</div></div><button class="secondary" type="button" data-revoke-xmpp="${esc(item.id)}">Revoke</button></li>`).join("") : '<li class="muted">No active app passwords.</li>'}</ul>`, "Revoking a password disconnects that app. Your other apps keep their own passwords.") +
        card("Rooms", `<ul>${connection.channels!.map(room => `<li><strong>#${esc(room.name)}</strong> · <a href="xmpp:${esc(room.jid)}?join">${esc(room.jid)}</a></li>`).join("") || '<li class="muted">No timeline channels available.</li>'}</ul>`, "Timeline channels are available as XMPP rooms. Membership and moderation are managed in Archipel Web. Topics and threaded channels use the browser.");
        onSubmit($("#xmpp-password-form", el), async data => {
          const owner = state.session.user!.id, route = location.hash;
          const credential = await api<{ password: string; jid: string }>("/xmpp/credentials", "POST", { label: data.get("label") });
          if (!el.isConnected || state.session.user?.id !== owner || location.hash !== route) return;
          await ctx.refresh();
          const output = document.querySelector<HTMLElement>("#xmpp-new-password");
          if (output && state.session.user?.id === owner && location.hash === route) output.innerHTML = `<p>Save this password now; it will only be shown once.</p><input readonly aria-label="New XMPP app password" value="${esc(credential.password)}" autocomplete="off">`;
      });
      onClick(el, "[data-revoke-xmpp]", async button => {
        await api(`/xmpp/credentials/${button.dataset.revokeXmpp}`, "DELETE");
        toast("App password revoked.");
        await ctx.refresh();
      });
    },
  },
  {
    group: "personal",
    key: "profile",
    label: "Profile",
    about: "Who you are to the people you talk with.",
    icon: "user",
    async draw(el, ctx) {
      const u = state.session.user!;
      el.innerHTML =
        card(
          "Profile",
          `<div class="profile-heading"><span id="profile-picture-preview">${avatar(u, "large")}</span><div><strong>@${esc(u.username)}</strong><div class="muted small">${esc(state.session.instance)}</div></div></div>
          <form class="stack narrow-form profile-picture-form" id="profile-picture-form"><label>Profile picture<input name="image" ${images} aria-describedby="profile-picture-help"></label><p class="muted small" id="profile-picture-help">PNG, JPEG, GIF or WebP, up to 2 MiB. Pictures fill a square. Your picture is shared with members and, when federation permissions allow it, other instances and XMPP clients.</p>${error}<div class="row"><button>Upload picture</button>${u.avatar_url ? '<button type="button" class="secondary" id="remove-profile-picture">Remove picture</button>' : ""}</div></form>
          <form class="stack narrow-form" id="profile-form"><label>Display name<input name="display_name" maxlength="80" value="${esc(u.display_name)}" required></label>
          <label class="check"><input type="checkbox" name="share_socials" ${u.share_socials ? "checked" : ""}> Share verified socials with other members</label><p class="muted small">Your login works whether you share or not.</p>${error}<button>Save profile</button></form>`,
        ) +
        card(
          "Verified socials",
          socialsHtml(u.verified_socials),
          "Supplied by your identity provider when you sign in.",
        ) +
        card(
          "Session",
          `<button type="button" class="secondary" id="sign-out">${icon("logout")} Sign out</button>`,
          `Signed in to ${esc(state.session.instance)}.`,
        );
      onSubmit($("#profile-form", el), async (data) => {
        state.session.user = await api<User>("/profile", "PATCH", {
          display_name: data.get("display_name"),
          share_socials: data.get("share_socials") === "on",
        });
        hooks.account();
        toast("Profile saved.");
        ctx.refresh();
      });
      onClick(el, "#sign-out", hooks.signOut);
      const pictureForm = $<HTMLFormElement>("#profile-picture-form", el);
      const pictureInput = $<HTMLInputElement>('input[name="image"]', pictureForm);
      pictureInput.addEventListener("change", () => {
        const file = pictureInput.files?.[0];
        $(".form-error", pictureForm).textContent = "";
        if (!file) {
          $("#profile-picture-preview", el).innerHTML = avatar(u, "large");
          return;
        }
        void imageBase64(file, 2097152).then((encoded) => {
          if (pictureInput.files?.[0] !== file) return;
          if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.type))
            throw new Error("Choose a PNG, JPEG, GIF or WebP picture.");
          $("#profile-picture-preview", el).innerHTML = avatar({ ...u, avatar_url: `data:${file.type};base64,${encoded}` }, "large");
        }).catch((e: Error) => {
          if (!pictureInput.isConnected || pictureInput.files?.[0] !== file) return;
          $(".form-error", pictureForm).textContent = e.message;
          $("#profile-picture-preview", el).innerHTML = avatar(u, "large");
        });
      });
      const pictureChanged = (user: User) => {
        state.session.user = user;
        hooks.account();
        ctx.refresh();
      };
      onSubmit(pictureForm, async (data) => {
        pictureChanged(await api<User>("/profile/avatar", "POST", {
          image: await imageBase64(data.get("image") as File, 2097152),
        }));
        toast("Profile picture uploaded.");
      });
      onClick(el, "#remove-profile-picture", async () => {
        pictureChanged(await api<User>("/profile/avatar", "DELETE"));
        toast("Profile picture removed.");
      });
    },
  },
  {
    group: "personal",
    key: "notifications",
    label: "Notifications",
    about: "Where you are told about new messages, and what you hid.",
    icon: "bell",
    async draw(el, ctx) {
      const prefs = await api<
        {
          target: string;
          kind: "channel" | "dm" | "topic" | "thread";
          hidden: boolean;
          notify: boolean | "mentions" | null;
          channel: { id: string; name: string } | null;
          title: string | null;
        }[]
      >("/prefs");
      const device = !pushSupported()
        ? '<p class="muted">This browser cannot receive notifications. On an iPhone or iPad, add Archipel Web to the Home Screen from the share menu and open it from there.</p>'
        : pushBlocked()
          ? '<p class="muted">Notifications from this site are blocked in the browser. Allow them in its site settings, then reload.</p>'
          : pushOn()
            ? `<p><span class="pill good">${icon("check")} On</span> This browser is notified of new messages.</p><div class="row"><button type="button" class="secondary" id="push-test">Send a test notification</button><button type="button" class="secondary" id="push-off">Turn off</button></div>`
            : `<button type="button" id="push-on">${icon("bell")} Turn on notifications</button>`;
      const place = (p: (typeof prefs)[number]) =>
        p.kind === "dm"
          ? `<a href="#/dm/${encodeURIComponent(p.target.slice(3))}">${esc(p.title)}</a> <span class="muted">direct messages</span>`
          : `<a href="#/c/${p.channel!.id}${p.kind === "topic" ? `/t/${p.target.slice(6)}` : ""}">#${esc(p.channel!.name)}${p.kind === "channel" ? "" : ` › ${esc(p.title || "Untitled")}`}</a> <span class="muted">${p.kind}</span>`;
      el.innerHTML =
        card(
          "This device",
          device,
          "You are told when something new is said, even with Archipel Web closed. A notification names the conversation and who wrote, not what they said. Each browser and device is turned on by itself, and signing out turns it off.",
        ) +
        card(
          "Your choices",
          prefs.length
            ? `<ul class="plain">${prefs.map((p) => `<li class="member-row"><div class="grow">${place(p)}<div class="small">${p.hidden ? '<span class="pill warn">Hidden</span> ' : ""}${p.notify === false ? '<span class="pill">Never notifies</span>' : p.notify === "mentions" ? '<span class="pill">Mentions only</span>' : p.notify ? '<span class="pill new">Always notifies</span>' : ""}</div></div><button type="button" class="secondary small" data-reset-pref="${esc(p.target)}">Reset</button></li>`).join("")}</ul>`
            : '<p class="muted">Nothing is hidden, and every channel and direct conversation you are in notifies you.</p>',
          "Change what notifies you from the bell at the top of a conversation, and hide or silence a topic or thread from the button beside it. Hidden topics and threads leave the channel, your inbox and the counts of what is new.",
        );
      onClick(el, "#push-on", async () => {
        await enablePush();
        toast("Notifications are on in this browser.");
        await ctx.refresh();
      });
      onClick(el, "#push-off", async () => {
        await disablePush();
        await ctx.refresh();
      });
      onClick(el, "#push-test", async () => {
        await testPush();
        toast("Sent. It should appear in a moment.");
      });
      onClick(el, "[data-reset-pref]", async (button) => {
        state.prefs = await api<Record<string, Pref>>("/prefs", "PUT", {
          target: button.dataset.resetPref,
          hidden: false,
          notify: null,
        });
        await ctx.refresh();
      });
    },
  },
  {
    group: "personal",
    key: "closed",
    label: "Closed conversations",
    about: "Direct conversations you closed, and how to get them back.",
    icon: "chat",
    async draw(el, ctx) {
      const closed =
        await api<(Conversation & { last_at: string })[]>("/dms/closed");
      el.innerHTML = card(
        "Closed conversations",
        `<ul class="plain member-list">${closed.length ? closed.map((c) => `<li class="member-row">${avatar(c)}<div class="grow"><strong>${esc(c.display_name)}</strong> <span class="muted">@${esc(c.username)}</span><div class="muted small">Last message ${when(c.last_at)}</div></div><button type="button" class="secondary small" data-reopen="${esc(c.peer)}">Reopen</button></li>`).join("") : '<li class="muted">You have no closed conversations.</li>'}</ul>`,
        "Close a conversation from its menu in the sidebar. Its messages are kept, and it comes back by itself when either of you writes in it again.",
      );
      onClick(el, "[data-reopen]", async (button) => {
        await api("/dms/close", "POST", {
          peer: button.dataset.reopen,
          closed: false,
        });
        state.dms = (await api<Overview>("/overview")).dms;
        renderSidebar();
        toast("Conversation reopened.");
        await ctx.refresh();
      });
    },
  },
  {
    group: "personal",
    key: "appearance",
    label: "Appearance",
    about: "How Archipel Web looks in this browser.",
    icon: "sun",
    async draw(el) {
      el.innerHTML = card("Interface style", styleChoices(), "Applied immediately and kept for this browser. Each style supports light and dark colors.") + card("Text size", textScaleControls(), "Applied immediately to all interface styles and saved in this browser.") + card(
        "Theme",
        themeSeg(),
        "Kept for this browser only, so each device can have its own. Device follows your system's light or dark setting.",
      ) + card("Time format", hourChoices(), "How the time of a message is written. Kept for this browser.");
    },
  },
  {
    group: "personal",
    key: "emoji",
    label: "Your emoji",
    about:
      "Your shortcodes are personal. Other readers see the emoji you used in a message.",
    icon: "smile",
    async draw(el, ctx) {
      const saved =
        await api<(CustomEmoji & { source_url: string })[]>("/personal-emojis");
      el.innerHTML =
        card(
          "Saved emoji",
          `<ul class="plain personal-emoji-list">${saved.length ? saved.map((e) => `<li class="row" data-emoji-row="${e.id}"><span class="emoji-sample">${emojiHtml(`:${e.name}:`, [e])}</span><code class="grow">:${esc(e.name)}:</code><button type="button" class="small secondary" data-rename-emoji="${e.id}">Rename</button><button type="button" class="small secondary bad-text" data-delete-personal="${e.id}">Remove</button></li>`).join("") : '<li class="muted">You have no personal emoji yet.</li>'}</ul>`,
        ) +
        `<div class="grid2">${card(
          "Upload an emoji",
          `<form class="stack" id="personal-upload"><label>Personal shortcode<input name="name" ${shortcode} placeholder="my_wave"></label><label>Personal emoji image<input name="image" ${images}></label>${error}<button>Upload personal emoji</button></form>`,
          "PNG, JPEG, GIF or WebP, up to 256 KiB.",
        )}${card(
          "Adopt from another instance",
          `<form class="stack" id="personal-adopt"><label>Remote instance URL<input name="instance" type="url" placeholder="https://chat.example.org" required></label><button type="button" id="load-source-emojis" class="secondary">Load instance emoji</button><label>Remote emoji<select name="source_name" required><option value="">Load a catalog above</option></select></label><label>Save as shortcode<input name="name" ${shortcode}></label>${error}<button>Adopt emoji</button></form>`,
          "Copies one of their custom emoji to your own set.",
        )}</div>`;
      const changed = async () => {
        state.emojis = await api<CustomEmoji[]>("/emojis");
        ctx.refresh();
      };
      onSubmit($("#personal-upload", el), async (data) => {
        await api("/personal-emojis", "POST", {
          name: data.get("name"),
          image: await imageBase64(data.get("image") as File),
        });
        await changed();
      });
      const adopt = $<HTMLFormElement>("#personal-adopt", el);
      onSubmit(adopt, async (data) => {
        await api("/personal-emojis/adopt", "POST", Object.fromEntries(data));
        await changed();
      });
      onClick(el, "#load-source-emojis", async () => {
        const failed = $(".form-error", adopt);
        failed.textContent = "";
        try {
          const catalog = await api<{ name: string }[]>(
            `/emoji-sources?instance=${encodeURIComponent(new FormData(adopt).get("instance") as string)}`,
          );
          $("select", adopt).innerHTML = catalog.length
            ? catalog
                .map(
                  (e) =>
                    `<option value="${esc(e.name)}">:${esc(e.name)}:</option>`,
                )
                .join("")
            : '<option value="">No instance emoji available</option>';
          $<HTMLInputElement>('input[name="name"]', adopt).value =
            catalog[0]?.name || "";
        } catch (e) {
          failed.textContent = (e as Error).message;
        }
      });
      onClick(el, "[data-delete-personal]", async (button) => {
        await api(`/personal-emojis/${button.dataset.deletePersonal}`, "DELETE");
        await changed();
      });
      // Renaming happens in the row itself.
      for (const button of $$("[data-rename-emoji]", el))
        button.addEventListener("click", () => {
          const emoji = saved.find((e) => e.id === button.dataset.renameEmoji)!,
            row = button.closest("li")!;
          row.className = "emoji-edit";
          row.innerHTML = `<form><span class="emoji-sample">${emojiHtml(`:${emoji.name}:`, [emoji])}</span><label class="grow"><input name="name" value="${esc(emoji.name)}" aria-label="New shortcode" ${shortcode}></label><button class="small">Save shortcode</button><button type="button" class="small secondary" data-cancel>Cancel</button>${error}</form><p class="muted small">Older messages keep their original emoji.</p>`;
          $("[data-cancel]", row).addEventListener("click", ctx.refresh);
          $<HTMLInputElement>("input", row).select();
          onSubmit($("form", row), async (data) => {
            await api(`/personal-emojis/${emoji.id}`, "PATCH", {
              name: data.get("name"),
            });
            await changed();
          });
        });
    },
  },
  {
    group: "federation",
    key: "featured",
    label: "Featured channels",
    about: "Recommend public channels from other servers in the channel directory.",
    icon: "globe",
    admin: true,
    async draw(el, ctx) {
      type Candidate = { id: string; name: string; address: string };
      const settings = await api<{ enabled: boolean; channels: { id: string; enabled: boolean }[]; candidates: Candidate[] }>("/admin/featured-channels");
      // Drop stale entries when a channel has become private or is no longer followed.
      settings.channels = settings.channels.filter(item => settings.candidates.some(c => c.id === item.id));
      el.innerHTML = card("Featured channels", `<label class="check"><input type="checkbox" id="featured-enabled" ${settings.enabled ? "checked" : ""}> Show featured external channels in the directory</label><ul class="plain">${settings.channels.map((item, i) => {
        const c = settings.candidates.find(c => c.id === item.id)!;
        return `<li class="member-row"><label class="check grow"><input type="checkbox" data-featured-toggle="${esc(c.id)}" ${item.enabled ? "checked" : ""}> ${esc(c.name)}<span class="muted small">${esc(new URL(c.address).host)}</span></label><button type="button" class="icon-button" data-featured-up="${esc(c.id)}" aria-label="Move ${esc(c.name)} up" ${i === 0 ? "disabled" : ""}>${icon("arrow-up")}</button><button type="button" class="icon-button" data-featured-down="${esc(c.id)}" aria-label="Move ${esc(c.name)} down" ${i === settings.channels.length - 1 ? "disabled" : ""}>${icon("arrow-down")}</button><button type="button" class="secondary small" data-featured-remove="${esc(c.id)}">Remove</button></li>`;
      }).join("") || '<li class="muted">No featured channels yet.</li>'}</ul><form id="featured-add" class="stack narrow-form"><label>External channel<select name="id" required><option value="">Choose a followed public channel</option>${settings.candidates.filter(c => !settings.channels.some(item => item.id === c.id)).map(c => `<option value="${esc(c.id)}">${esc(c.name)} · ${esc(new URL(c.address).host)}</option>`).join("")}</select></label>${error}<button>Add featured channel</button></form>`, "Only instance administrators manage this list. A channel must be public and already followed by someone here. Featuring it shares its name and description; each member subscribes with their own federation permissions.");
      const save = async () => {
        await api("/admin/featured-channels", "PUT", { enabled: settings.enabled, channels: settings.channels });
        await ctx.refresh();
      };
      $<HTMLInputElement>("#featured-enabled", el).addEventListener("change", event => action(async () => {
        settings.enabled = (event.target as HTMLInputElement).checked;
        await save();
      }));
      for (const box of $$<HTMLInputElement>("[data-featured-toggle]", el)) box.addEventListener("change", () => action(async () => {
        settings.channels.find(item => item.id === box.dataset.featuredToggle)!.enabled = box.checked;
        await save();
      }));
      onClick(el, "[data-featured-up], [data-featured-down], [data-featured-remove]", async button => {
        const id = button.dataset.featuredUp || button.dataset.featuredDown || button.dataset.featuredRemove;
        const i = settings.channels.findIndex(item => item.id === id);
        if (button.dataset.featuredRemove) settings.channels.splice(i, 1);
        else {
          const to = i + (button.dataset.featuredUp ? -1 : 1);
          if (i < 0 || to < 0 || to >= settings.channels.length) return;
          [settings.channels[i], settings.channels[to]] = [settings.channels[to]!, settings.channels[i]!];
        }
        await save();
      });
      onSubmit($("#featured-add", el), async data => {
        settings.channels.push({ id: String(data.get("id")), enabled: true });
        await save();
      });
    },
  },
  {
    group: "federation",
    key: "remote",
    label: "Channels on other servers",
    about: "Channels hosted on other instances that you follow from here.",
    icon: "globe",
    async draw(el, ctx) {
      const s = state.session;
      const subscriptions = await api<
        { channel_id: string; name: string; status: string }[]
      >("/federation/subscriptions");
      const allowed =
        s.federation_enabled &&
        s.user?.federation_subscribe &&
        s.user?.federation_receive;
      el.innerHTML =
        `<p class="flash ${allowed ? "" : "warn-flash"}">${s.federation_enabled ? (allowed ? "Your role decides which federation actions your account may use." : "Your role does not allow subscribing to and receiving remote channels.") : "Federation is disabled on this instance."}</p>` +
        card(
          "Subscribe to a channel",
          `<form class="stack narrow-form" id="remote-subscribe"><label>Channel address<input name="address" placeholder="#general@chat.example.org or an actor URL" required></label>${error}<button ${allowed ? "" : "disabled"}>Subscribe to channel</button></form>`,
        ) +
        card(
          "Your subscriptions",
          `<ul class="plain remote-subscriptions">${subscriptions.length ? subscriptions.map((sub) => `<li class="row">${icon("globe")}<strong class="grow">${esc(sub.name)}</strong><span class="pill ${sub.status === "accepted" ? "good" : sub.status === "pending" ? "warn" : "bad"}">${esc(sub.status)}</span>${sub.status === "accepted" ? `<button type="button" class="small" data-open-remote="${sub.channel_id}">Open channel</button>` : ""}${["pending", "accepted"].includes(sub.status) ? `<button type="button" class="small secondary bad-text" data-unsubscribe="${sub.channel_id}">Unsubscribe</button>` : ""}</li>`).join("") : '<li class="muted">You follow no remote channels.</li>'}</ul><button type="button" id="refresh-subscriptions" class="small secondary">Refresh subscriptions</button>`,
          "A subscription is pending until the channel's home instance accepts it.",
        );
      onSubmit($("#remote-subscribe", el), async (data) => {
        if (!(await subscribeRemote(String(data.get("address"))))) return;
        ctx.refresh();
      });
      onClick(el, "#refresh-subscriptions", async () => ctx.refresh());
      onClick(el, "[data-open-remote]", async (button) => {
        state.channels = await api<Channel[]>("/channels");
        go(`#/c/${button.dataset.openRemote}`);
      });
      onClick(el, "[data-unsubscribe]", async (button) => {
        await api(
          `/federation/subscriptions/${button.dataset.unsubscribe}`,
          "DELETE",
        );
        state.channels = await api<Channel[]>("/channels");
        ctx.refresh();
      });
    },
  },
  {
    group: "federation",
    key: "direct",
    label: "Messages to other servers",
    about: "Private messages with people on other instances.",
    icon: "chat",
    async draw(el) {
      const s = state.session,
        allowed = s.federation_enabled && s.user?.federation_send;
      el.innerHTML =
        card(
          "Send a message",
          `<form class="stack narrow-form" id="remote-direct"><label>Remote user address<input name="address" placeholder="user@chat.example.org or an actor URL" required></label><label>Direct message<textarea name="body" required maxlength="8000" rows="3"></textarea></label>${error}<button ${allowed ? "" : "disabled"}>Send federated message</button></form>`,
          allowed
            ? ""
            : s.federation_enabled
              ? "Your role does not allow sending federated messages."
              : "Federation is disabled on this instance.",
        ) +
        card(
          "Messages",
          '<ul class="plain" id="federated-direct-list"></ul>',
        );
      const form = $<HTMLFormElement>("#remote-direct", el);
      onSubmit(form, async (data) => {
        await api("/federation/messages", "POST", Object.fromEntries(data));
        $<HTMLTextAreaElement>("textarea", form).value = "";
        await drawDirectMessages();
      });
      await drawDirectMessages(el);
    },
  },
  {
    group: "federation",
    key: "instance",
    label: "Instance federation",
    about:
      "Federation starts disabled, and no role grants it until you say so. Local conversations remain available either way.",
    icon: "shield",
    admin: true,
    async draw(el) {
      const status = await api<{
        enabled: boolean;
        sending: { batch: number; interval: number };
      }>("/admin/federation");
      el.innerHTML =
        card(
          "Federation",
          `<form class="stack" id="federation-enable"><label class="check"><input type="checkbox" name="enabled" ${status.enabled ? "checked" : ""}> Enable federation for this instance</label>${error}<button>Save federation setting</button></form>`,
        ) +
        card(
          "Sending to other instances",
          `<form class="stack narrow-form" id="federation-sending"><label>Send every (seconds)<input name="interval" type="number" min="0.1" max="600" step="0.1" required value="${status.sending.interval / 1000}"></label><label>Messages each time<input name="batch" type="number" min="1" max="1000" step="1" required value="${status.sending.batch}"></label>${error}<button>Save sending pace</button></form>`,
          "What members write in federated channels, and everything else meant for another instance, waits in a queue. Each time, up to this many are sent, across all instances; one that could not be delivered is tried again later.",
        ) +
        card(
          "Who may federate",
          '<p>Sending, receiving, following remote channels and posting in federated ones are granted by role.</p><a class="button secondary" href="#/settings/instance/roles">Manage roles</a>',
        );
      onSubmit($("#federation-enable", el), async (data) => {
        await api("/admin/federation", "PATCH", {
          enabled: data.get("enabled") === "on",
        });
        state.session = await api<Session>("/session");
        toast("Federation setting saved.");
      });
      onSubmit($("#federation-sending", el), async (data) => {
        await api("/admin/federation/sending", "PATCH", {
          interval: Math.round(Number(data.get("interval")) * 1000),
          batch: Number(data.get("batch")),
        });
        toast("Sending pace saved.");
      });
    },
  },
  {
    group: "federation",
    key: "blocks",
    label: "Remote blocks",
    about: "Instances and remote actors this instance refuses to talk to.",
    icon: "lock",
    admin: true,
    async draw(el, ctx) {
      const status = await api<{ blocks: { target: string; kind: string }[] }>(
        "/admin/federation",
      );
      el.innerHTML =
        card(
          "Block a remote target",
          `<form class="stack narrow-form" id="federation-block"><label>Block type<select name="kind"><option value="instance">Whole instance</option><option value="actor">Remote user or channel actor</option></select></label><label>Remote HTTPS URL<input name="target" type="url" required></label>${error}<button class="danger">Block remote target</button></form>`,
        ) +
        card(
          "Blocked",
          `<ul class="plain">${status.blocks.length ? status.blocks.map((b) => `<li class="row"><span class="pill bad">${esc(b.kind)}</span><code class="grow">${esc(b.target)}</code><button type="button" class="small secondary" data-unblock="${esc(b.target)}" data-kind="${esc(b.kind)}">Unblock</button></li>`).join("") : '<li class="muted">Nothing is blocked.</li>'}</ul>`,
        );
      onSubmit($("#federation-block", el), async (data) => {
        await api("/admin/federation/blocks", "POST", {
          ...Object.fromEntries(data),
          blocked: true,
        });
        ctx.refresh();
      });
      onClick(el, "[data-unblock]", async (button) => {
        await api("/admin/federation/blocks", "POST", {
          target: button.dataset.unblock,
          kind: button.dataset.kind,
          blocked: false,
        });
        ctx.refresh();
      });
    },
  },
  {
    group: "federation",
    key: "deliveries",
    label: "Deliveries",
    about: "The most recent messages queued for other instances.",
    icon: "send",
    admin: true,
    async draw(el) {
      const status = await api<{
        recent: { recipient: string; status: string; error: string | null }[];
      }>("/admin/federation");
      el.innerHTML = status.recent.length
        ? `<table class="list"><thead><tr><th>Status</th><th>Recipient</th><th>Error</th></tr></thead><tbody>${status.recent.map((d) => `<tr><td><span class="pill ${d.status === "delivered" ? "good" : d.error ? "bad" : "warn"}">${esc(d.status)}</span></td><td><code>${esc(d.recipient)}</code></td><td class="muted">${esc(d.error || "")}</td></tr>`).join("")}</tbody></table>`
        : '<p class="card empty muted">No queued deliveries yet.</p>';
    },
  },
  {
    group: "channel",
    key: "overview",
    label: "Overview",
    about: "What this channel is and how it's set up.",
    icon: "hash",
    async draw(el, ctx) {
      const c = ctx.channel!,
        owning =
          !c.remote_actor &&
          (!!state.session.user?.admin || c.role === "owner");
      const reacting = !c.remote_actor && canModerate(c);
      const address =`#${c.name}@${c.remote_actor ? new URL(c.remote_actor).host : state.session.instance}`;
      el.innerHTML =
        card(
          `${channelIcon(c)} ${esc(c.name)}`,
          `<dl class="info"><dt>Address</dt><dd><code>${esc(address)}</code></dd><dt>Description</dt><dd>${esc(c.description || "None")}</dd><dt>Conversation style</dt><dd>${modeLabel(c.mode)}${c.mode === "threaded" ? ` · titles ${c.optional_titles ? "optional" : "required"}` : ""}</dd><dt>Who can read</dt><dd>${c.visibility === "members" ? "Members only" : "Everyone on this instance"}</dd><dt>Who can join</dt><dd>${c.admission === "allowlist" ? "Invited users only" : "Anyone on this instance"}</dd><dt>Members</dt><dd><a href="#/settings/channel/members/${c.id}">${c.member_count}</a></dd><dt>Your role</dt><dd>${roleLabel(c.role)}</dd><dt>Shared with</dt><dd>${c.remote_actor ? "Hosted on another server" : c.federation_enabled ? "Members here and on other servers" : "People on this instance"}</dd></dl><p><a class="button secondary" href="#/c/${c.id}">${icon("chat")} Open channel</a></p>`,
        ) +
        (c.role && c.role !== "owner"
          ? card(
              "Leave",
              `<button type="button" class="danger" id="leave-channel">Leave this channel</button>`,
              c.remote_actor
                ? "Unsubscribes you from this remote channel."
                : "You can join again later if the channel allows it.",
            )
          : "") +
        (c.remote_actor && c.role
          ? card(
              "Mirror",
              `<button type="button" class="secondary" id="mirror-channel">Mirror this channel</button>`,
              "Keeps your own copy in a channel you own here, so the conversation stays readable if this one goes away.",
            )
          : "") +
        (reacting
          ? card(
              "Reactions",
              `<form class="stack narrow-form" id="channel-reactions"><label class="check"><input type="checkbox" name="reactions" ${c.reactions ? "checked" : ""}> Let members react to messages with emoji</label>${error}<button>Save</button></form>`,
              "Turning reactions off hides them in this channel. Existing reactions are kept and show again if you turn them back on.",
            ) +
            card(
              "Banned reactions",
              `${c.reaction_bans.length ? `<ul class="plain stack">${c.reaction_bans.map((name) => `<li class="row"><span class="grow">${emojiHtml(`:${name}:`)} <code>:${esc(name)}:</code></span><button type="button" class="small secondary" data-unban="${esc(name)}">Allow again</button></li>`).join("")}</ul>` : '<p class="muted">No emoji is banned.</p>'}<form class="stack narrow-form" id="reaction-ban"><label>Emoji shortcode<input name="emoji" required maxlength="66" pattern=":?[a-z0-9_+\\-]+:?" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="eggplant"></label>${error}<button>Ban emoji</button></form>`,
              "A banned emoji is taken off every message in this channel and cannot be given as a reaction again, here or from an instance following the channel. A single unwanted reaction can be removed from its message instead.",
            )
          : "") +
        (reacting && c.mode === "threaded"
          ? card(
              "Thread titles",
              `<form class="stack narrow-form" id="channel-titles"><label class="check"><input type="checkbox" name="optional" ${c.optional_titles ? "checked" : ""}> Let threads start without a title</label>${error}<button>Save</button></form>`,
              "When titles are required, every new thread needs one. Threads already posted keep the title they have, or none, either way.",
            )
          : "") +
        (owning
          ? card(
              "Rename",
              `<form class="stack narrow-form" id="rename-channel"><label>Channel name<span class="input-prefix"><span>#</span><input name="name" value="${esc(c.name)}" required minlength="2" maxlength="40" pattern="[a-zA-Z0-9][a-zA-Z0-9_\\-]{1,39}" autocomplete="off"></span></label>${error}<button>Rename channel</button></form>`,
              "Renaming changes the channel's address. Links to it keep working; anyone using the old address, or its XMPP room, has to switch to the new one.",
            ) +
            card(
              "Delete",
              `<button type="button" class="danger" id="delete-channel">Delete this channel</button>`,
              "Removes the channel and every message in it for everyone. This can't be undone.",
            )
          : "");
      if (reacting && c.mode === "threaded")
        onSubmit($("#channel-titles", el), async (data) => {
          await api(`/channels/${c.id}/titles`, "PATCH", {
            optional: data.get("optional") === "on",
          });
          state.channels = await api<Channel[]>("/channels");
          if (chatChannel()?.id === c.id) resetChat();
          toast("Channel updated.");
          ctx.refresh();
        });
      if (reacting) {
        const ban = async (emoji: string, banned: boolean) => {
          await api(`/channels/${c.id}/reaction-bans`, "PUT", { emoji, banned });
          state.channels = await api<Channel[]>("/channels");
          if (chatChannel()?.id === c.id) resetChat();
          toast(banned ? `:${emoji}: is banned from reactions.` : `:${emoji}: can be given again.`);
          ctx.refresh();
        };
        onSubmit($("#reaction-ban", el), (data) =>
          ban(String(data.get("emoji")).trim().replaceAll(":", ""), true),
        );
        onClick(el, "[data-unban]", (button) => ban(button.dataset.unban!, false));
      }
      if (reacting)
        onSubmit($("#channel-reactions", el), async (data) => {
          await api(`/channels/${c.id}/reactions`, "PATCH", {
            enabled: data.get("reactions") === "on",
          });
          state.channels = await api<Channel[]>("/channels");
          if (chatChannel()?.id === c.id) resetChat();
          toast("Channel updated.");
          ctx.refresh();
        });
      if (owning) {
        onSubmit($("#rename-channel", el), async (data) => {
          await api(`/channels/${c.id}`, "PATCH", { name: data.get("name") });
          state.channels = await api<Channel[]>("/channels");
          if (chatChannel()?.id === c.id) resetChat();
          toast("Channel renamed.");
          ctx.refresh();
        });
        onClick(el, "#delete-channel", async () => {
          if (
            !(await confirmDialog(
              `Delete #${c.name}?`,
              `All of its messages${c.member_count > 1 ? ` and its ${c.member_count} memberships` : ""} will be removed permanently.`,
              "Delete channel",
            ))
          )
            return;
          await api(`/channels/${c.id}`, "DELETE");
          if (chatChannel()?.id === c.id) resetChat();
          state.channels = await api<Channel[]>("/channels");
          toast("Channel deleted.");
          go("#/channels");
        });
      }
      onClick(el, "#mirror-channel", async () =>
        mirrorDialog("channel", c.id, `#${c.name}`, c.mode),
      );
      onClick(el, "#leave-channel", async () => {
        if (
          !(await confirmDialog(
            `Leave #${c.name}?`,
            "You'll stop seeing it in your channels.",
            "Leave channel",
          ))
        )
          return;
        await api(`/channels/${c.id}/leave`, "POST", {});
        if (chatChannel()?.id === c.id) resetChat();
        state.channels = await api<Channel[]>("/channels");
        go("#/channels");
      });
    },
  },
  {
    group: "channel",
    key: "members",
    label: "Members",
    about: "The people in this channel.",
    icon: "people",
    async draw(el, ctx) {
      const c = ctx.channel!,
        moderating = canModerate(c),
        promoting = !!state.session.user?.admin || c.role === "owner",
        owning = !c.remote_actor && promoting;
      if (!c.sees_members) {
        el.innerHTML =
          '<p class="card empty muted">This channel doesn\'t show its members.</p>';
        return;
      }
      // Where the channel keeps something from its members, a moderator can let one of them see it.
      const allow = (u: User, grant: "see_members" | "see_handles", what: string) =>
        `<button type="button" class="small secondary" data-member="${u.id}" data-grant="${grant}" data-allow="${u[grant] ? "" : "1"}">${u[grant] ? `Stop showing ${what}` : `Show ${what}`}</button>`;
      const grants = (u: User) =>
        u.role !== "member"
          ? ""
          : (c.show_members ? "" : allow(u, "see_members", "members")) +
            (c.hide_handles ? allow(u, "see_handles", "handles") : "");
      el.innerHTML = (owning
        ? card(
            "What members see of each other",
            `<form class="stack narrow-form" id="channel-privacy"><label class="check"><input type="checkbox" name="show_members" ${c.show_members ? "checked" : ""}> Show the list of who is in this channel</label><label class="check"><input type="checkbox" name="hide_handles" ${c.hide_handles ? "checked" : ""}> Hide handles, leaving only display names</label>${error}<button>Save</button></form>`,
            `The owner and moderators always see both. Other members can be allowed one at a time, below.${c.federation_enabled ? " Instances following this channel are told to do the same for their own members." : ""}`,
          )
        : "") + card(
        `${c.member_count} member${c.member_count === 1 ? "" : "s"}`,
        `<ul class="plain member-list">${(c.members || [])
          .map((u) =>
            person(
              u,
              `<span class="pill ${u.role === "owner" ? "kept" : u.role === "moderator" ? "new" : ""}">${roleLabel(u.role)}</span>${moderating && u.role === "member" && ((!c.show_members && u.see_members) || (c.hide_handles && u.see_handles)) ? ` <span class="pill good">Sees ${[!c.show_members && u.see_members ? "members" : "", c.hide_handles && u.see_handles ? "handles" : ""].filter(Boolean).join(" and ")}</span>` : ""}${u.verified_socials.length ? `<details class="socials"><summary>Shared socials</summary>${socialsHtml(u.verified_socials)}</details>` : ""}`,
              moderating && u.role !== "owner" && u.held !== false
                ? `${grants(u)}${promoting ? `<button type="button" class="small secondary" data-member="${u.id}" data-role="${u.role === "moderator" ? "member" : "moderator"}">${u.role === "moderator" ? "Make member" : "Make moderator"}</button>` : ""}<button type="button" class="small secondary bad-text" data-member="${u.id}" data-remove>Remove</button>`
                : "",
            ),
          )
          .join("")}</ul>`,
        moderating
          ? `Invite or block people under <a href="#/settings/channel/access/${c.id}">Access rules</a>.`
          : "",
      );
      if (owning)
        onSubmit($("#channel-privacy", el), async (data) => {
          await api(`/channels/${c.id}/privacy`, "PATCH", {
            show_members: data.get("show_members") === "on",
            hide_handles: data.get("hide_handles") === "on",
          });
          state.channels = await api<Channel[]>("/channels");
          if (chatChannel()?.id === c.id) resetChat();
          toast("Channel updated.");
          ctx.refresh();
        });
      onClick(el, "[data-member]", async (button) => {
        await api(
          `/channels/${c.id}/members/${button.dataset.member}`,
          "PATCH",
          "remove" in button.dataset
            ? { remove: true }
            : button.dataset.grant
              ? { [button.dataset.grant]: !!button.dataset.allow }
              : { role: button.dataset.role },
        );
        toast("Channel permissions updated.");
        ctx.refresh();
      });
    },
  },
  {
    group: "channel",
    key: "access",
    label: "Access rules",
    about: "Who is invited to, or blocked from, this channel.",
    icon: "lock",
    mod: true,
    async draw(el, ctx) {
      const c = ctx.channel!;
      // Without the instance's member list, the person is named by their handle.
      const [users, rules] = await Promise.all([
        listsMembers() ? api<User[]>("/users") : null,
        api<{ user_id: string; rule: string; username: string }[]>(
          `/channels/${c.id}/rules`,
        ),
      ]);
      el.innerHTML =
        card(
          "Change someone's access",
          `<form class="stack narrow-form" id="access-form"><label>Person${
            users
              ? `<select name="user">${users
                  .filter((u) => u.id !== c.owner_id)
                  .map((u) => `<option value="${u.id}">@${esc(u.username)}</option>`)
                  .join("")}</select>`
              : `<span class="input-prefix"><span>@</span><input name="handle" required maxlength="64" placeholder="handle" autocomplete="off"></span>`
          }</label><label>Action<select name="action"><option value="allow">Allow to join</option><option value="block">Block and remove membership</option><option value="clear">Clear access rule</option><option value="remove">Remove membership</option>${state.session.user?.admin || c.role === "owner" ? '<option value="moderator">Make moderator</option><option value="member">Make member</option>' : ""}</select></label>${error}<button>Apply change</button></form>`,
          `${c.visibility === "members" ? "Members-only" : "Public"} · ${c.admission === "allowlist" ? "invitation required" : "open membership"}`,
        ) +
        card(
          "Access rules",
          `<ul class="plain rules-list">${rules.length ? rules.map((r) => `<li class="row"><span class="grow">@${esc(r.username)}</span><span class="pill ${r.rule === "block" ? "bad" : "good"}">${esc(r.rule)}</span><button type="button" class="small secondary" data-clear="${r.user_id}">Clear</button></li>`).join("") : '<li class="muted">No individual access rules.</li>'}</ul>`,
        );
      const change = async (user: unknown, selected: string) => {
        await api(
          `/channels/${c.id}/members/${user}`,
          "PATCH",
          ["moderator", "member"].includes(selected)
            ? { role: selected }
            : selected === "remove"
              ? { remove: true }
              : { rule: selected },
        );
        toast("Channel permissions updated.");
        ctx.refresh();
      };
      onSubmit($("#access-form", el), async (data) =>
        change(
          users
            ? data.get("user")
            : (await api<Conversation>("/dms/resolve", "POST", { to: `@${String(data.get("handle")).trim().replace(/^@/, "")}@${state.session.instance}` })).peer.split("/").pop(),
          data.get("action") as string,
        ),
      );
      onClick(el, "[data-clear]", (button) =>
        change(button.dataset.clear, "clear"),
      );
    },
  },
  {
    group: "channel",
    key: "mirror",
    label: "Mirror",
    about: "What this mirror copies, and whether people can write in it.",
    icon: "globe",
    mod: true,
    mirror: true,
    async draw(el, ctx) {
      const c = ctx.channel!,
        owning = !!state.session.user?.admin || c.role === "owner";
      const mirror = await api<{
        writable: boolean;
        sources: {
          id: string;
          kind: string;
          name: string;
          state: string;
          active: boolean;
        }[];
      }>(`/channels/${c.id}/mirror`);
      const live = (state: string) => state === "following" || state === "joined";
      el.innerHTML =
        card(
          "Sources",
          `<ul class="plain mirror-sources">${
            mirror.sources
              .map(
                (s) =>
                  `<li class="row">${icon(s.kind === "xmpp" ? "globe" : "hash")}<strong class="grow">${esc(s.name)}</strong><span class="pill ${!s.active ? "" : live(s.state) ? "good" : "warn"}">${s.active ? esc(s.state) : "stopped"}</span>${owning ? `<button type="button" class="small secondary" data-source="${s.id}" data-active="${!s.active}">${s.active ? "Stop consuming" : "Resume"}</button><button type="button" class="small secondary bad-text" data-source="${s.id}" data-remove>Remove</button>` : ""}</li>`,
              )
              .join("") || '<li class="muted">No sources yet.</li>'
          }</ul>`,
          "Copied from the owner's own subscriptions, without telling the sources. To add one, use Mirror on a channel you follow from another instance (in its settings) or in an XMPP room you've joined. Copies stay as they arrived even if the source later edits or removes them.",
        ) +
        (owning
          ? card(
              "Writing",
              mirror.writable
                ? `<p>Members can write here. Sources keep arriving alongside.</p><button type="button" class="secondary" id="mirror-writable" data-writable="false">Make read-only again</button>`
                : `<p>Nobody can write here yet.</p><button type="button" id="mirror-writable" data-writable="true">Open for writing</button>`,
              "Opening the mirror makes it a fork: what is written here stays here and is not sent to the sources.",
            )
          : "");
      onClick(el, "[data-source]", async (button) => {
        const path = `/channels/${c.id}/mirror/sources/${button.dataset.source}`;
        if ("remove" in button.dataset) {
          if (
            !(await confirmDialog(
              "Remove this source?",
              "The mirror stops copying it. Messages already copied stay.",
              "Remove source",
            ))
          )
            return;
          await api(path, "DELETE");
        } else
          await api(path, "PATCH", { active: button.dataset.active === "true" });
        ctx.refresh();
      });
      onClick(el, "#mirror-writable", async (button) => {
        await api(`/channels/${c.id}/mirror`, "PATCH", {
          writable: button.dataset.writable === "true",
        });
        state.channels = await api<Channel[]>("/channels");
        if (chatChannel()?.id === c.id) resetChat();
        ctx.refresh();
      });
    },
  },
  {
    group: "channel",
    key: "bridge",
    label: "XMPP bridge",
    about: "Carry this channel and a room on another XMPP server as one conversation.",
    icon: "globe",
    mod: true,
    async draw(el, ctx) {
      const c = ctx.channel!,
        owning = !!state.session.user?.admin || c.role === "owner";
      const bridge = await api<{
        room: string | null;
        state?: string;
        error?: string | null;
      }>(`/channels/${c.id}/bridge`);
      const how =
        "Messages from the room appear here under their authors' room names. What members write here is repeated in the room under their own XMPP identity, if their account may send and post to federated rooms; otherwise it stays in this channel. Edits and removals are not carried across.";
      el.innerHTML = !state.xmppEnabled
        ? '<p class="card empty muted">XMPP is not configured on this instance.</p>'
        : c.mode !== "timeline"
          ? '<p class="card empty muted">Only timeline channels can be bridged with an XMPP room.</p>'
          : bridge.room
            ? card(
                "Bridged room",
                `<dl class="info"><dt>Room</dt><dd><code>${esc(bridge.room)}</code></dd><dt>Connection</dt><dd><span class="pill ${bridge.state === "joined" ? "good" : bridge.state === "joining" ? "warn" : "bad"}">${esc(bridge.state)}</span></dd></dl>${bridge.error ? `<p class="flash error">${esc(bridge.error)}</p>` : ""}${owning ? `<div class="row"><button type="button" class="secondary" id="bridge-reconnect">Reconnect</button><button type="button" class="danger" id="bridge-remove">Remove bridge</button></div>` : ""}`,
                how,
              )
            : owning
              ? card(
                  "Bridge with a room",
                  `<form class="stack narrow-form" id="bridge-form"><label>Room address<input name="room" required maxlength="512" placeholder="lounge@muc.example.org" autocomplete="off"></label>${error}<button>Bridge channel</button></form>`,
                  how,
                )
              : '<p class="card empty muted">This channel is not bridged. Only its owner can bridge it.</p>';
      const form = el.querySelector<HTMLFormElement>("#bridge-form");
      if (form)
        onSubmit(form, async (data) => {
          await api(`/channels/${c.id}/bridge`, "PUT", { room: data.get("room") });
          state.channels = await api<Channel[]>("/channels");
          if (chatChannel()?.id === c.id) resetChat();
          toast("Channel bridged.");
          ctx.refresh();
        });
      onClick(el, "#bridge-reconnect", async () => {
        await api(`/channels/${c.id}/bridge`, "PUT", { room: bridge.room });
        ctx.refresh();
      });
      onClick(el, "#bridge-remove", async () => {
        if (
          !(await confirmDialog(
            "Remove the bridge?",
            "The channel and the room go their separate ways. Messages already here stay.",
            "Remove bridge",
          ))
        )
          return;
        await api(`/channels/${c.id}/bridge`, "DELETE");
        state.channels = await api<Channel[]>("/channels");
        if (chatChannel()?.id === c.id) resetChat();
        toast("Bridge removed.");
        ctx.refresh();
      });
    },
  },
  {
    group: "channel",
    key: "federation",
    label: "Federation",
    about: "Whether other instances can follow this channel, and who does.",
    icon: "globe",
    mod: true,
    async draw(el, ctx) {
      const c = ctx.channel!;
      const followers = await api<{ actor: string; status: string }[]>(
        `/channels/${c.id}/followers`,
      );
      el.innerHTML =
        card(
          "Federation",
          `<form class="stack" id="channel-federation"><label class="check"><input type="checkbox" name="enabled" ${c.federation_enabled ? "checked" : ""}> Allow this channel to federate</label>${error}<button>Save channel federation</button></form>`,
          "Open channels accept remote subscribers automatically. Invited channels require approval here. Turning federation off stops channel delivery and removes remote admission.",
        ) +
        card(
          "Remote followers",
          `<ul class="plain remote-followers">${followers.length ? followers.map((f) => `<li class="row"><code class="grow">${esc(f.actor)}</code><span class="pill ${f.status === "accepted" ? "good" : f.status === "blocked" ? "bad" : "warn"}">${esc(f.status)}</span>${f.status !== "accepted" ? `<button type="button" class="small" data-follower="${esc(f.actor)}" data-decision="accepted">Accept follower</button>` : ""}${f.status !== "blocked" ? `<button type="button" class="small secondary bad-text" data-follower="${esc(f.actor)}" data-decision="blocked">Block follower</button>` : ""}</li>`).join("") : '<li class="muted">No remote follows yet.</li>'}</ul>`,
        );
      onSubmit($("#channel-federation", el), async (data) => {
        await api(`/channels/${c.id}/federation`, "PATCH", {
          enabled: data.get("enabled") === "on",
        });
        toast("Channel federation saved.");
        ctx.refresh();
      });
      onClick(el, "[data-follower]", async (button) => {
        await api(`/channels/${c.id}/followers`, "PATCH", {
          actor: button.dataset.follower,
          status: button.dataset.decision,
        });
        ctx.refresh();
      });
    },
  },
  {
    group: "instance",
    key: "membership",
    label: "Membership",
    about: "Who may join this instance, and the people waiting to.",
    icon: "shield",
    admin: true,
    async draw(el, ctx) {
      const [applications, settings] = await Promise.all([
        api<
          (User & {
            created_at: string;
            identities: { issuer: string; subject: string }[];
          })[]
        >("/admin/applications"),
        api<{ registration_mode: string }>("/admin/settings"),
      ]);
      el.innerHTML =
        card(
          "Membership policy",
          `<form class="stack narrow-form" id="registration-form"><label>New user access<select name="registration_mode"><option value="open" ${settings.registration_mode === "open" ? "selected" : ""}>Open: admit new users automatically</option><option value="invite_only" ${settings.registration_mode === "invite_only" ? "selected" : ""}>Invite only: require administrator approval</option></select></label>${error}<button>Save membership policy</button></form>`,
          "Existing members keep access. Pending or declined applications still need a decision when registration is opened.",
        ) +
        card(
          `Applications${applications.length ? ` <span class="count">${applications.length}</span>` : ""}`,
          `<div class="applications">${applications.length ? applications.map((u) => `<article class="application" data-application="${u.id}"><div class="row">${avatar(u)}<div class="grow">${nameButton(u, u.actor_url)}${u.username ? ` <span class="muted">@${esc(u.username)}</span>` : ""}<div class="muted small"><span class="pill ${u.admission_status === "rejected" ? "bad" : "warn"}">${esc(u.admission_status)}</span> Applied ${esc(full(u.created_at))}${u.banned ? " · also suspended" : ""}</div></div><button type="button" class="small" data-review="${u.id}" data-decision="approved">Approve</button>${u.admission_status !== "rejected" ? `<button type="button" class="small secondary bad-text" data-review="${u.id}" data-decision="rejected">Decline</button>` : ""}</div>${u.identities.map((identity) => `<dl class="info small"><dt>Issuer</dt><dd><code>${esc(identity.issuer)}</code></dd><dt>Subject</dt><dd><code>${esc(identity.subject)}</code></dd></dl>`).join("")}<h3>Provider-verified socials</h3>${socialsHtml(u.verified_socials)}</article>`).join("") : '<p class="muted">No applications waiting for review.</p>'}</div>`,
        );
      onSubmit($("#registration-form", el), async (data) => {
        const result = await api<{
          registration_mode: Session["registration_mode"];
        }>("/admin/settings", "PATCH", {
          registration_mode: data.get("registration_mode"),
        });
        state.session.registration_mode = result.registration_mode;
        toast("Membership policy saved.");
      });
      onClick(el, "[data-review]", async (button) => {
        await api(`/admin/applications/${button.dataset.review}`, "PATCH", {
          admission_status: button.dataset.decision,
        });
        ctx.refresh();
      });
    },
  },
  {
    group: "instance",
    key: "roles",
    label: "Roles",
    about:
      "What accounts on this instance may do. Everyone has the default role unless given another under People.",
    icon: "lock",
    admin: true,
    async draw(el, ctx) {
      const roles = await api<Role[]>("/admin/roles");
      el.innerHTML =
        roles
          .map((role) =>
            card(
              `${esc(role.name)}${role.is_default ? ' <span class="pill kept">Default</span>' : ""} <span class="pill">${role.members} account${role.members === 1 ? "" : "s"}</span>`,
              `<form class="stack narrow-form role-form" data-role="${role.id}" aria-label="Role ${esc(role.name)}"><label>Role name<input name="name" required maxlength="40" value="${esc(role.name)}" autocomplete="off"></label>${roleBoxes(role)}${error}<div class="row"><button>Save role</button>${role.is_default ? "" : `<button type="button" class="secondary" data-default-role="${role.id}">Make default</button><button type="button" class="secondary bad-text" data-delete-role="${role.id}">Delete role</button>`}</div></form>`,
            ),
          )
          .join("") +
        card(
          "Create a role",
          `<form class="stack narrow-form" id="role-create"><label>New role name<input name="name" required maxlength="40" placeholder="Federated" autocomplete="off"></label>${roleBoxes()}${error}<button>Create role</button></form>`,
          "Changes reach open browser sessions and queued deliveries within seconds.",
        );
      const changed = async (message: string) => {
        state.session = await api<Session>("/session");
        toast(message);
        await ctx.refresh();
      };
      for (const form of $$<HTMLFormElement>(".role-form", el))
        onSubmit(form, async (data) => {
          await api(`/admin/roles/${form.dataset.role}`, "PATCH", roleValues(data));
          await changed("Role saved.");
        });
      onSubmit($("#role-create", el), async (data) => {
        await api("/admin/roles", "POST", roleValues(data));
        await changed("Role created.");
      });
      onClick(el, "[data-default-role]", async (button) => {
        await api(`/admin/roles/${button.dataset.defaultRole}`, "PATCH", {
          is_default: true,
        });
        await changed("Default role changed.");
      });
      onClick(el, "[data-delete-role]", async (button) => {
        if (
          !(await confirmDialog(
            "Delete this role?",
            "Accounts that have it go back to the default role.",
            "Delete role",
          ))
        )
          return;
        await api(`/admin/roles/${button.dataset.deleteRole}`, "DELETE");
        await changed("Role deleted.");
      });
    },
  },
  {
    group: "instance",
    key: "people",
    label: "People",
    about: "Everyone with an account on this instance.",
    icon: "people",
    admin: true,
    async draw(el, ctx) {
      const [users, roles] = await Promise.all([
        api<User[]>("/users"),
        api<Role[]>("/admin/roles"),
      ]);
      el.innerHTML = card(
        `${users.length} account${users.length === 1 ? "" : "s"}`,
        `<ul class="plain admin-users">${users
          .map((u) =>
            person(
              u,
              `<span class="pill ${u.admin ? "kept" : u.banned ? "bad" : "good"}">${u.admin ? "Administrator" : u.banned ? "Suspended" : "Active"}</span>`,
              `<select class="role-select" data-role-for="${u.id}" aria-label="Role for @${esc(u.username)}" title="Role">${roles.map((r) => `<option value="${r.id}" ${r.id === u.instance_role?.id ? "selected" : ""}>${esc(r.name)}${r.is_default ? " (default)" : ""}</option>`).join("")}</select>` +
              (u.admin
                ? ""
                : `<button type="button" class="small secondary ${u.banned ? "" : "bad-text"}" data-ban="${u.id}" data-status="${u.banned ? "false" : "true"}">${u.banned ? "Restore" : "Suspend"}</button>`),
            ),
          )
          .join("")}</ul>`,
        'What each role allows is set under <a href="#/settings/instance/roles">Roles</a>.',
      );
      for (const select of $$<HTMLSelectElement>("[data-role-for]", el))
        select.addEventListener("change", () =>
          action(async () => {
            await api(`/admin/users/${select.dataset.roleFor}/role`, "PATCH", {
              role_id: select.value,
            });
            state.session = await api<Session>("/session");
            toast("Role changed.");
          }),
        );
      onClick(el, "[data-ban]", async (button) => {
        await api(`/admin/users/${button.dataset.ban}`, "PATCH", {
          banned: button.dataset.status === "true",
        });
        ctx.refresh();
      });
    },
  },
  {
    group: "instance",
    key: "emoji",
    label: "Custom emoji",
    about: "Emoji everyone on this instance can use by :shortcode:.",
    icon: "smile",
    admin: true,
    async draw(el, ctx) {
      const emojis = await api<CustomEmoji[]>("/admin/emojis");
      el.innerHTML =
        card(
          "Add an emoji",
          `<form class="stack narrow-form" id="emoji-form"><label>Emoji shortcode<input name="name" ${shortcode} placeholder="island_wave"></label><label>Emoji image<input name="image" ${images}></label>${error}<button>Add emoji</button></form>`,
          "PNG, JPEG, GIF or WebP, up to 256 KiB. Standard emoji names are reserved.",
        ) +
        card(
          "Instance emoji",
          `<ul class="plain admin-emojis">${emojis.length ? emojis.map((e) => `<li class="row"><span class="emoji-sample">${emojiHtml(`:${e.name}:`, [e])}</span><code class="grow">:${esc(e.name)}:</code><button type="button" class="small secondary" data-rename-instance-emoji="${esc(e.name)}">Rename</button><button type="button" class="small secondary bad-text" data-remove-emoji="${esc(e.name)}">Remove</button></li>`).join("") : '<li class="muted">No custom emoji yet.</li>'}</ul>`,
        );
      const changed = async () => {
        state.emojis = await api<CustomEmoji[]>("/emojis");
        ctx.refresh();
      };
      onSubmit($("#emoji-form", el), async (data) => {
        await api("/admin/emojis", "POST", {
          name: data.get("name"),
          image: await imageBase64(data.get("image") as File),
        });
        await changed();
      });
      // Renaming happens in the row itself.
      for (const button of $$("[data-rename-instance-emoji]", el))
        button.addEventListener("click", () => {
          const emoji = emojis.find((e) => e.name === button.dataset.renameInstanceEmoji)!,
            row = button.closest("li")!;
          row.className = "emoji-edit";
          row.innerHTML = `<form><span class="emoji-sample">${emojiHtml(`:${emoji.name}:`, [emoji])}</span><label class="grow"><input name="name" value="${esc(emoji.name)}" aria-label="New shortcode" ${shortcode}></label><button class="small">Save shortcode</button><button type="button" class="small secondary" data-cancel>Cancel</button>${error}</form><p class="muted small">Older messages keep showing the emoji under its original shortcode.</p>`;
          $("[data-cancel]", row).addEventListener("click", ctx.refresh);
          $<HTMLInputElement>("input", row).select();
          onSubmit($("form", row), async (data) => {
            await api(`/admin/emojis/${encodeURIComponent(emoji.name)}`, "PATCH", {
              name: data.get("name"),
            });
            await changed();
          });
        });
      onClick(el, "[data-remove-emoji]", async (button) => {
        await api(`/admin/emojis/${button.dataset.removeEmoji}`, "DELETE");
        await changed();
      });
    },
  },
  {
    group: "instance",
    key: "moderation",
    label: "Moderation log",
    about: "The last hundred administrative and moderation actions.",
    icon: "shield",
    admin: true,
    async draw(el) {
      const audit = await api<
        { action: string; username: string; created_at: string; target: string }[]
      >("/admin/audit");
      el.innerHTML = audit.length
        ? `<table class="list"><thead><tr><th>Action</th><th>By</th><th>When</th><th>Target</th></tr></thead><tbody>${audit.map((a) => `<tr><td>${esc(a.action.replaceAll(".", " "))}</td><td>@${esc(a.username)}</td><td class="nowrap">${when(a.created_at)}</td><td><code>${esc(a.target || "")}</code></td></tr>`).join("")}</tbody></table>`
        : '<p class="card empty muted">No moderation actions yet.</p>';
    },
  },
];

let token = 0;
export async function showSettings(
  view: HTMLElement,
  group?: string,
  key?: string,
  id?: string,
) {
  const mine = ++token,
    admin = !!state.session.user?.admin;
  // Channels whose settings can be opened: the ones you're in, and for administrators every local one.
  const channels = state.channels.filter(
    (c) => c.role || (admin && c.readable && !c.remote_actor),
  );
  const listed =
    channels.find((c) => c.id === id) ||
    state.channels.find((c) => c.id === id && c.readable) ||
    channels.find((c) => c.id === chatChannel()?.id) ||
    channels[0];
  const allowed = (s: Section) =>
    (!s.admin || admin) &&
    (s.group !== "channel" ||
      (!!listed &&
        (!s.mod || canModerate(listed)) &&
        (!s.mirror || !!listed.mirror)));
  const section = sections.find((s) => s.group === group && s.key === key);
  const href = (s: Section) =>
    `#/settings/${s.group}/${s.key}${s.group === "channel" ? `/${listed!.id}` : ""}`;
  if (group && (!section || !allowed(section))) {
    const fallback = sections.find((s) => s.group === group && allowed(s));
    return go(fallback ? href(fallback) : "#/settings");
  }
  // On a wide screen there's always a section open; on a phone the list comes first.
  if (!section && matchMedia("(min-width: 721px)").matches)
    return go("#/settings/personal/profile");
  if (section?.group === "channel" && id !== listed!.id)
    return go(href(section));
  const nav = (Object.keys(groups) as Section["group"][])
    .map((g) => {
      const links = sections
        .filter((s) => s.group === g && allowed(s))
        .map(
          (s) =>
            `<a class="menu-item${s === section ? " on" : ""}" href="${href(s)}"${s === section ? ' aria-current="page"' : ""}>${icon(s.icon)}<span class="grow">${s.label}</span></a>`,
        )
        .join("");
      if (g === "channel")
        return `<div class="nav-group"><div class="menu-label">Channel</div>${channels.length || listed ? `<select id="settings-channel" aria-label="Channel">${[...new Set([...(listed ? [listed] : []), ...channels])].map((c) => `<option value="${c.id}" ${c.id === listed!.id ? "selected" : ""}>#${esc(c.name)}</option>`).join("")}</select>${links}` : '<p class="muted small menu-note">Join a channel to see its settings.</p>'}</div>`;
      return links
        ? `<div class="nav-group"><div class="menu-label">${groups[g]}</div>${links}</div>`
        : "";
    })
    .join("");
  // The frame and the list stay put between sections: only the list's markup (when it
  // changed) and the page beside it are replaced, once the new page is ready to show.
  let page = view.querySelector<HTMLElement>(".page.settings-page");
  if (!page) {
    const workspace = sidebarFrame(view);
    workspace.insertAdjacentHTML("beforeend", `<div class="page settings-page"><div class="page-inner settings-layout"><nav class="settings-nav" aria-label="Settings"></nav><section class="settings-body"></section></div></div>`);
    page = $(".page", view);
    $(".settings-nav", view).addEventListener("change", (e) => {
      const select = e.target as HTMLSelectElement,
        [, at, was] = location.hash.split("/").slice(1);
      if (select.id === "settings-channel")
        go(
          `#/settings/channel/${at === "channel" && was ? was : "overview"}/${select.value}`,
        );
    });
  }
  const list = $(".settings-nav", view),
    body = $(".settings-body", view),
    same = page.dataset.at === location.hash,
    html = `<h1>Settings</h1>${nav}`;
  if (list.dataset.html !== html) {
    const at = list.scrollTop;
    list.innerHTML = list.dataset.html = html;
    list.scrollTop = at;
  }
  $(".settings-layout", view).classList.toggle("at-index", !section);
  if (!section) {
    page.dataset.at = location.hash;
    body.innerHTML = "";
    return;
  }
  const show = (content: HTMLElement, detail: Channel | null) => {
    const scrolled = same ? page.scrollTop : 0;
    body.innerHTML = `<a class="back-link" href="#/settings">${icon("chevron-left")} Settings</a><div class="feed-head"><div><p class="muted small crumb">${groups[section.group]}${detail ? ` · #${esc(detail.name)}` : ""}</p><h1>${section.label}</h1><p class="muted">${section.about}</p></div></div>`;
    content.id = "section";
    body.append(content);
    refreshTimes(content);
    page.dataset.at = location.hash;
    page.scrollTop = scrolled;
  };
  const content = document.createElement("div");
  let detail: Channel | null = null;
  try {
    if (section.group === "channel")
      detail = await api<Channel>(`/channels/${listed!.id}`);
    if (mine !== token) return;
    await section.draw(content, {
      channel: detail,
      refresh: () => showSettings(view, group, key, id),
    });
    if (mine !== token) return;
    show(content, detail);
  } catch (e) {
    if (mine !== token) return;
    content.innerHTML = `<p class="flash error">${esc((e as Error).message)}</p>`;
    show(content, detail);
  }
}
export async function tickSettings() {
  await drawDirectMessages();
  const section = document.querySelector("#section");
  if (section) refreshTimes(section);
}
