import { emojiParts, type CustomEmoji } from "../src/emojis.js";

export type { CustomEmoji };
export interface User {
  id: string;
  actor_url?: string;
  avatar_url?: string | null;
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
export interface Topic {
  id: string;
  title: string;
}
export interface Channel {
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
  dm?: Conversation; // a direct conversation, dressed as a channel for the chat view
}
// Someone you exchange direct messages with: here, or on another instance.
export interface Conversation {
  peer: string;
  id: string;
  username: string;
  display_name: string;
  contact_name?: string | null;
  avatar_url?: string | null;
  remote: boolean;
  unread?: number;
  blocked?: string | null;
}
// How the reader arranged one half of the sidebar: loose conversations, then named groups.
export interface SideGroup {
  id: string;
  name: string;
  collapsed: boolean;
  items: string[];
}
export interface SideSection {
  collapsed: boolean;
  items: string[];
  groups: SideGroup[];
}
export type SideKind = "dms" | "channels";
export type Layout = Record<SideKind, SideSection>;
export interface Overview {
  xmpp_rooms: XmppRoom[];
  dms: Conversation[];
  unread: Record<string, number>;
  layout: Layout | null;
  user_blocks: string[];
}
export interface XmppRoom {
  id: string; room: string; nick: string; desired: boolean; state: string;
  role: string; subject: string; error: string | null; blocked: string | null;
  can_post: boolean; post_blocked: string | null;
}
export interface Message {
  id: string;
  seq: number;
  author_id: string;
  username: string;
  display_name: string;
  avatar_url?: string | null;
  body: string;
  title: string | null;
  parent_id: string | null;
  topic_id: string | null;
  created_at: string;
  deleted_at: string | null;
  edited_at: string | null;
  emojis?: CustomEmoji[];
  queued?: boolean;
  author_actor_url?: string;
  history_placeholder?: number;
}
export interface Session {
  user: User | null;
  csrf: string | null;
  dev_auth: boolean;
  oidc_enabled: boolean;
  instance: string;
  registration_mode: "open" | "invite_only";
  federation_enabled: boolean;
}

export const app = document.querySelector<HTMLDivElement>("#app")!;
export const state = {
  session: null as unknown as Session,
  channels: [] as Channel[],
  emojis: [] as CustomEmoji[],
  dms: [] as Conversation[],
  xmppRooms: [] as XmppRoom[],
  // New messages per conversation: a channel's id, or dm:<peer>.
  unread: {} as Record<string, number>,
  layout: null as Layout | null,
  userBlocks: [] as string[],
};
// Set by main.ts: start over from the session (after sign-in or a lost session), sign out,
// and redraw the account button after a profile change.
export const hooks = {
  boot: async () => {},
  signOut: async () => {},
  account: () => {},
};

export const esc = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export const $ = <T extends HTMLElement = HTMLElement>(
  selector: string,
  root: ParentNode = document,
) => root.querySelector<T>(selector)!;
export const $$ = <T extends HTMLElement = HTMLElement>(
  selector: string,
  root: ParentNode = document,
) => [...root.querySelectorAll<T>(selector)];
export const go = (hash: string) => {
  if (location.hash === hash) dispatchEvent(new HashChangeEvent("hashchange"));
  else location.hash = hash;
};

const paths: Record<string, string> = {
  logo: '<circle class="solid" cx="7.5" cy="14" r="4.5"/><circle class="solid" cx="16" cy="7.5" r="3.5"/><circle class="solid" cx="18" cy="17.5" r="2.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  hash: '<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  globe:
    '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  send: '<path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7Z"/>',
  people:
    '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20.5a6.5 6.5 0 0 1 13 0M16 4.7a3.5 3.5 0 0 1 0 6.6M18.5 14.6a6.5 6.5 0 0 1 3 5.9"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  settings:
    '<path d="M4 6h9M19 6h1M4 12h3M13 12h7M4 18h11M21 18h-1"/><circle cx="16" cy="6" r="2.2"/><circle cx="10" cy="12" r="2.2"/><circle cx="18" cy="18" r="2.2"/>',
  reply: '<path d="M9 14 4 9l5-5"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/>',
  trash:
    '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6"/>',
  pencil: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  logout:
    '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z"/>',
  compass:
    '<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5Z"/>',
  smile:
    '<circle cx="12" cy="12" r="9"/><path d="M8 14s1.5 2 4 2 4-2 4-2M9 9.5h.01M15 9.5h.01"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/>',
  monitor:
    '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  block: '<circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/>',
  "arrow-down": '<path d="M12 5v14M19 12l-7 7-7-7"/>',
  "chevron-down": '<path d="m6 9 6 6 6-6"/>',
  "chevron-left": '<path d="m15 18-6-6 6-6"/>',
  "chevron-right": '<path d="m9 18 6-6-6-6"/>',
  inbox:
    '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1Z"/>',
  more: '<circle class="solid" cx="5" cy="12" r="1.6"/><circle class="solid" cx="12" cy="12" r="1.6"/><circle class="solid" cx="19" cy="12" r="1.6"/>',
  folder:
    '<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  "folder-plus":
    '<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M12 11v5M9.5 13.5h5"/>',
  "arrow-up": '<path d="M12 19V5M5 12l7-7 7 7"/>',
};
// Decorative: say what it means in text or a label next to it.
export const icon = (name: string, cls = "") =>
  `<svg class="i${cls ? ` ${cls}` : ""}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${paths[name] || paths.hash}</svg>`;

function hue(name: string) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 8;
}
export const avatar = (
  u: { username: string; display_name: string; avatar_url?: string | null },
  cls = "",
) =>
  `<span class="avatar av-${hue(u.username)}${cls ? ` ${cls}` : ""}" aria-hidden="true">${esc((u.display_name || u.username).trim().slice(0, 1).toUpperCase())}${u.avatar_url ? `<img src="${esc(u.avatar_url)}" alt="" loading="lazy" decoding="async">` : ""}</span>`;

// Keep the initial visible if a removed or unavailable picture fails to load.
document.addEventListener("error", (event) => {
  const image = event.target;
  if (image instanceof HTMLImageElement && image.matches(".avatar > img")) image.remove();
}, true);

// The author of a message or a member in a list: a click offers to write to them (people.ts).
export const nameButton = (
  u: { username: string; display_name: string; avatar_url?: string | null },
  actor: string | undefined,
  cls = "author",
) =>
  actor
    ? `<button type="button" class="${cls} name-button" data-user="${esc(actor)}" data-username="${esc(u.username)}" data-name="${esc(u.display_name)}" data-avatar="${esc(u.avatar_url || "")}" title="About ${esc(u.display_name)}">${esc(u.display_name)}</button>`
    : `<strong class="${cls}">${esc(u.display_name)}</strong>`;
// Direct conversations accept a local member id, an actor URL, or an xmpp: address.
const localActors = () => `${location.origin}/actors/users/`;
export const dmHref = (peer: string) =>
  `#/dm/${peer.startsWith(localActors()) ? peer.slice(localActors().length) : encodeURIComponent(peer)}`;
export function dmPeer(key: string) {
  let value = key;
  try {
    value = decodeURIComponent(key);
  } catch {
    /* Taken as written. */
  }
  return value.startsWith("xmpp:") || value.includes("/")
    ? value
    : localActors() + value;
}

export const modeLabel = (mode: string) =>
  ({ timeline: "Timeline", topical: "Topics", threaded: "Threads" })[mode] ||
  mode;
export const channelIcon = (c: Channel) =>
  icon(c.remote_actor ? "globe" : c.visibility === "members" ? "lock" : "hash");
export const canModerate = (c: Channel) =>
  !c.remote_actor &&
  (!!state.session.user?.admin ||
    ["owner", "moderator"].includes(c.role || ""));

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
export const sameDay = (a: string, b: string) =>
  dayKey(new Date(a)) === dayKey(new Date(b));
export const clock = (ts: string) =>
  new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
export const full = (ts: string) => new Date(ts).toLocaleString();
export function dayLabel(ts: string) {
  const d = new Date(ts),
    now = new Date(),
    yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (dayKey(d) === dayKey(now)) return "Today";
  if (dayKey(d) === dayKey(yesterday)) return "Yesterday";
  return d.toLocaleDateString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  });
}
function ago(ts: string) {
  const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ts).toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
// Relative times are filled in afterwards (refreshTimes), so the markup stays the same as they age.
export const when = (ts: string) =>
  `<time datetime="${esc(ts)}" title="${esc(full(ts))}" data-ago></time>`;
export function refreshTimes(root: ParentNode = document) {
  for (const t of $$<HTMLTimeElement>("time[data-ago]", root)) {
    const text = ago(t.dateTime);
    if (t.textContent !== text) t.textContent = text;
  }
}

export function toast(message: string, error = false) {
  const el = document.createElement("div");
  el.className = `toast${error ? " error" : ""}`;
  el.innerHTML = `<span>${esc(message)}</span><button type="button" class="link toast-close" aria-label="Dismiss">×</button>`;
  $("#toast").append(el);
  $("button", el).addEventListener("click", () => el.remove());
  setTimeout(() => el.remove(), 6000);
}
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const csrf = state.session?.csrf;
  const response = await fetch(`/api${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(csrf ? { "X-CSRF-Token": csrf } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (!response.ok)
    throw new ApiError(response.status, data.error || "Something went wrong.");
  return data as T;
}
export function emojiHtml(body: string, emojis = state.emojis) {
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
export function action(fn: () => Promise<void>) {
  void fn().catch((error) =>
    toast(error.message || "Could not connect. Please try again.", true),
  );
}
// Runs fn on submit, with the button disabled meanwhile and a failure shown in the form's .form-error.
export function onSubmit(
  element: HTMLFormElement,
  fn: (data: FormData, submitter: HTMLButtonElement | null) => Promise<void>,
) {
  element.addEventListener("submit", async (e) => {
    e.preventDefault();
    const buttons = $$<HTMLButtonElement>("button:not([type=button])", element);
    if (buttons.some((b) => b.disabled)) return;
    const data = new FormData(element),
      error = element.querySelector<HTMLElement>(".form-error");
    buttons.forEach((b) => (b.disabled = true));
    if (error) error.textContent = "";
    try {
      await fn(data, e.submitter as HTMLButtonElement | null);
    } catch (err) {
      if (error) error.textContent = (err as Error).message;
      else toast((err as Error).message, true);
    } finally {
      buttons.forEach((b) => (b.disabled = false));
    }
  });
}
export function confirmDialog(title: string, copy: string, label: string) {
  return new Promise<boolean>((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "card dialog";
    dialog.innerHTML = `<h2>${esc(title)}</h2><p class="muted">${esc(copy)}</p><form method="dialog" class="row end"><button value="no" class="secondary">Cancel</button><button value="yes" class="danger">${esc(label)}</button></form>`;
    document.body.append(dialog);
    dialog.addEventListener("close", () => {
      dialog.remove();
      resolve(dialog.returnValue === "yes");
    });
    dialog.showModal();
  });
}
// Asks for one short line of text; null when dismissed.
export function promptDialog(
  title: string,
  label: string,
  value = "",
  action = "Save",
) {
  return new Promise<string | null>((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "card dialog";
    dialog.innerHTML = `<h2>${esc(title)}</h2><form method="dialog" class="stack"><label>${esc(label)}<input name="value" maxlength="40" required value="${esc(value)}" autocomplete="off"></label><div class="row end"><button type="button" class="secondary" data-cancel>Cancel</button><button value="yes">${esc(action)}</button></div></form>`;
    document.body.append(dialog);
    $("[data-cancel]", dialog).addEventListener("click", () => dialog.close());
    dialog.addEventListener("close", () => {
      dialog.remove();
      const text = $<HTMLInputElement>("input", dialog).value.trim();
      resolve(dialog.returnValue === "yes" && text ? text : null);
    });
    dialog.showModal();
    $<HTMLInputElement>("input", dialog).select();
  });
}
// A small panel floating by the thing that opened it; one at a time, gone on a click elsewhere or Escape.
let closePopup: (() => void) | null = null;
export function popup(anchor: HTMLElement, html: string) {
  const wasOpen = anchor.getAttribute("aria-expanded") === "true";
  closePopup?.();
  if (wasOpen) return null;
  const panel = document.createElement("div");
  panel.className = "menu-panel popup";
  panel.innerHTML = html;
  document.body.append(panel);
  anchor.setAttribute("aria-expanded", "true");
  const box = anchor.getBoundingClientRect(),
    width = panel.offsetWidth,
    height = panel.offsetHeight;
  panel.style.left = `${Math.max(8, Math.min(box.left, innerWidth - width - 8))}px`;
  panel.style.top = `${box.bottom + height + 8 > innerHeight && box.top > height + 8 ? box.top - height - 4 : box.bottom + 4}px`;
  const away = (e: Event) => {
    const at = e.target as Node;
    if (
      e instanceof KeyboardEvent
        ? e.key === "Escape"
        : !panel.contains(at) && !anchor.contains(at)
    )
      close();
  };
  const close = () => {
    panel.remove();
    anchor.removeAttribute("aria-expanded");
    document.removeEventListener("pointerdown", away, true);
    document.removeEventListener("keydown", away, true);
    removeEventListener("hashchange", close);
    if (closePopup === close) closePopup = null;
  };
  closePopup = close;
  document.addEventListener("pointerdown", away, true);
  document.addEventListener("keydown", away, true);
  addEventListener("hashchange", close);
  // Whatever is chosen in it, the panel has done its job.
  panel.addEventListener("click", (e) => {
    if ((e.target as Element).closest("button, a")) close();
  });
  panel.querySelector<HTMLElement>("button, a")?.focus();
  return panel;
}
export async function imageBase64(file: File, maxBytes = 262144) {
  if (!file.size || file.size > maxBytes)
    throw new Error(`Choose an image up to ${maxBytes >= 1048576 ? `${maxBytes / 1048576} MiB` : `${maxBytes / 1024} KiB`}.`);
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = () => reject(new Error("Could not read the image."));
    reader.readAsDataURL(file);
  });
}
export function socialsHtml(socials: unknown[]) {
  if (!socials.length)
    return '<p class="muted small">No verified socials were shared by the identity provider.</p>';
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
      return `<div class="verified-social"><strong>${esc(handle)}</strong><span class="muted small">${esc(provider)}${typeof claim.domain === "string" ? ` · ${esc(claim.domain)}` : ""}</span>${profile ? `<a class="small" href="${esc(profile)}" target="_blank" rel="noopener noreferrer">View profile</a>` : ""}</div>`;
    })
    .join("")}</div>`;
}

// ---- theme: the device's, or the one picked in the menu (kept for this browser) ----
const themes = [
  ["light", "Light", "sun"],
  ["dark", "Dark", "moon"],
  ["", "Device", "monitor"],
];
function storedTheme() {
  try {
    const theme = localStorage.getItem("archipel-theme") || "";
    return theme === "light" || theme === "dark" ? theme : "";
  } catch {
    return "";
  }
}
export function applyTheme(theme = storedTheme()) {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  for (const b of $$<HTMLButtonElement>("[data-set-theme]")) {
    const on = b.dataset.setTheme === theme;
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", String(on));
  }
}
export const themeSeg = () =>
  `<div class="seg theme-seg" role="group" aria-label="Theme">${themes.map(([key, label, ico]) => `<button type="button" data-set-theme="${key}" class="${storedTheme() === key ? "on" : ""}" aria-pressed="${storedTheme() === key}">${icon(ico)} ${label}</button>`).join("")}</div>`;
document.addEventListener("click", (e) => {
  const button = (e.target as Element).closest<HTMLElement>("[data-set-theme]");
  if (!button) return;
  try {
    if (button.dataset.setTheme)
      localStorage.setItem("archipel-theme", button.dataset.setTheme);
    else localStorage.removeItem("archipel-theme");
  } catch {
    /* Without storage the theme lasts until the page is reloaded. */
  }
  applyTheme(button.dataset.setTheme);
});
