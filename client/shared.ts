import { emojiParts, emojiData, emojiNames, markEmoji, type CustomEmoji } from "../src/emojis.js";
import { markdownHtml } from "./markdown.js";
import { isFusion, hour12 } from "./appearance.js";

export type { CustomEmoji };
export interface User {
  id: string;
  actor_url?: string | null; // kept back, with the handle, where a channel hides handles
  avatar_url?: string | null;
  username: string;
  display_name: string;
  admin?: boolean;
  banned?: boolean;
  admission_status?: "pending" | "approved" | "rejected";
  share_socials?: boolean;
  verified_socials: unknown[];
  role?: string;
  // In a member list: false for someone whose membership another instance holds.
  held?: boolean;
  // What a channel's owner or moderator allowed this member to see there.
  see_members?: boolean;
  see_handles?: boolean;
  federation_send?: boolean;
  federation_receive?: boolean;
  federation_subscribe?: boolean;
  federation_post?: boolean;
  // What the account's instance role grants, on the account's own profile.
  instance_role?: { id: string; name: string };
  create_channels?: boolean;
  federate_channels?: boolean;
  direct_messages?: boolean;
  attachments?: boolean;
  xmpp_rooms?: boolean;
  list_members?: boolean;
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
  // What the channel shows its members of one another, and whether this reader sees it anyway.
  show_members: number;
  hide_handles: number;
  reactions: number; // members may react to messages with emoji
  optional_titles: number; // threads may start without a title
  reaction_bans: string[]; // emoji its moderators keep out of its reactions
  sees_members: boolean;
  sees_handles: boolean;
  topics?: Topic[];
  remote_actor: string | null;
  federation_enabled: number;
  bridge_room?: string | null; // the room on another XMPP server this channel is bridged with
  mirror?: "read-only" | "writable" | null; // a copy of sources hosted elsewhere, and whether it was opened
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
// How the reader arranged one section of the sidebar: loose conversations, then named groups.
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
export type SideKind = "dms" | "channels" | "xmpp";
// The sections, the order they are listed in, and whether XMPP rooms are listed among the channels.
export type Layout = Record<SideKind, SideSection> & { order?: SideKind[]; merged?: boolean };
export interface Overview {
  xmpp_enabled: boolean;
  xmpp_rooms: XmppRoom[];
  dms: Conversation[];
  unread: Record<string, number>;
  layout: Layout | null;
  user_blocks: string[];
  prefs: Record<string, Pref>;
}
// What the reader chose for a channel, a direct conversation (dm:<peer>), a topic (topic:<id>) or
// a thread (thread:<its first message>): hidden from them, and whether it notifies them.
// A topic or thread with no choice of its own (null) follows its channel.
export interface Pref {
  hidden: boolean;
  notify: boolean | "mentions" | null;
}
export interface XmppRoom {
  id: string; room: string; nick: string; desired: boolean; state: string;
  role: string; subject: string; error: string | null; blocked: string | null;
  can_post: boolean; post_blocked: string | null;
  reconnecting?: boolean; // the room dropped the session and it is being joined again
}
export interface Reaction {
  emoji: string; // a shortcode name
  count: number;
  mine: boolean;
  url?: string; // a custom emoji's picture, which may be another instance's
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
  reactions?: Reaction[];
  queued?: boolean; // still on its way to another instance
  failed?: string; // why it never got there
  author_actor_url?: string | null;
  history_placeholder?: number;
  hidden_thread?: boolean; // in a thread the reader hid
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
  xmppEnabled: false,
  xmppRooms: [] as XmppRoom[],
  // New messages per conversation: a channel's id, or dm:<peer>.
  unread: {} as Record<string, number>,
  layout: null as Layout | null,
  userBlocks: [] as string[],
  prefs: {} as Record<string, Pref>,
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
  "fusion-pencil": '<path d="M4 20h4L18.5 9.5a2.828 2.828 0 1 0-4-4L4 16zm9.5-13.5l4 4"/>',
  "fusion-reply": '<path d="m9 14-4-4 4-4M5 10h11a4 4 0 1 1 0 8h-1"/>',
  "fusion-smile": '<path d="M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0m6-2h.01M15 10h.01M9.5 15a3.5 3.5 0 0 0 5 0"/>',
  "fusion-quote": '<path d="M10 11H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v6q0 4-4 5m13-7h-4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v6q0 4-4 5"/>',
  "fusion-chevron-down": '<path class="solid" d="M4 8h16l-8 10z"/>',
  "fusion-folder": '<g transform="scale(1.5)"><path d="M3.2 3.6h2.6c.5 0 .9.2 1.2.6l.6.8c.2.2.4.3.7.3h4.5c.7 0 1.2.5 1.2 1.2v4.8c0 .7-.5 1.2-1.2 1.2H3.2c-.7 0-1.2-.5-1.2-1.2V4.8c0-.7.5-1.2 1.2-1.2z"/></g>',
  "folder-open": '<path d="M5 20h14l3-10H8L5 20zm0 0H3V5a1 1 0 0 1 1-1h5l3 3h7a1 1 0 0 1 1 1v2"/>',
  collapse: '<path d="M12 3v6l3-3M9 6l3 3m0 12v-6l3 3m-6 0l3-3m-8-3h1m4 0h1m4 0h1m4 0h1"/>',
  "fusion-hash": '<path d="M5 9h14M5 15h14M11 4 7 20M17 4l-4 16"/>',
  "fusion-globe": '<path d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0-18 0M3.6 9h16.8M3.6 15h16.8M11.5 3a17 17 0 0 0 0 18M12.5 3a17 17 0 0 1 0 18"/>',
  "needle-thread": '<path d="M3 21Q2 20 14.785 4.291a3.5 3.5 0 1 1 5.078 4.791Q4.001 22 3 21M17.5 6.5l-1 1"/><path d="M17 7c-2.333-2.667-3.5-4-5-4s-2 1-2 2c0 4 8.161 8.406 6 11c-1.056 1.268-3.363 1.285-5.75.808m-4.511-1.383C4.346 14.86 2 13.5 2 12m17.5-2.5L21 11"/>',
  xmpp: '<path class="solid" d="M1.2 3.9l3.75 1.2c.6 3.9 1.8 6.9 3.6 9.75C5.1 12.3 2.25 8.7 1.2 3.9zm21.6 0-3.75 1.2c-.6 3.9-1.8 6.9-3.6 9.75 3.45-2.55 6.3-6.15 7.35-10.95zM6.45 5.4l3.9-1.35c.15 4.65 1.35 8.55 3.45 11.85 1.2 1.8 2.7 3.3 4.5 4.5-3.9-1.05-6.9-3.3-9-6.6-1.5-2.4-2.55-5.25-2.85-8.4zm11.1 0-3.9-1.35c-.15 4.65-1.35 8.55-3.45 11.85-1.2 1.8-2.7 3.3-4.5 4.5 3.9-1.05 6.9-3.3 9-6.6 1.5-2.4 2.55-5.25 2.85-8.4z"/>',
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
  quote:
    '<path d="M3 21c3 0 7-1 7-8V5c0-1.2-.8-2-2-2H4c-1.2 0-2 .8-2 2v6c0 1.2.8 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 0-1 1v2c0 1 0 1 1 1Z"/><path d="M15 21c3 0 7-1 7-8V5c0-1.2-.8-2-2-2h-4c-1.2 0-2 .8-2 2v6c0 1.2.8 2 2 2h.8c0 2.2.2 4-2.8 4v3c0 1 0 1 1 1Z"/>',
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
  paperclip:
    '<path d="m21 12-8.6 8.6a5 5 0 0 1-7-7L14 5a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.5a1.7 1.7 0 0 1-2.4-2.4l8-7.9"/>',
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  at: '<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  "bell-off":
    '<path d="M8.7 3A6 6 0 0 1 18 8a21.3 21.3 0 0 0 .6 5M17 17H3s3-2 3-9a4.67 4.67 0 0 1 .3-1.7M10.3 21a1.94 1.94 0 0 0 3.4 0M2 2l20 20"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  "eye-off":
    '<path d="M9.9 5.2A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-2.2 3.1M6.6 6.6A17.3 17.3 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2M2 2l20 20"/>',
};
// Decorative: say what it means in text or a label next to it.
export const icon = (name: string, cls = "") =>
  `<svg class="i${cls ? ` ${cls}` : ""}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${paths[isFusion() && paths[`fusion-${name}`] ? `fusion-${name}` : name] || paths.hash}</svg>`;

function hue(name: string) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 8;
}
export const avatar = (
  u: { username: string; display_name: string; avatar_url?: string | null },
  cls = "",
) =>
  `<span class="avatar av-${hue(u.username || u.display_name)}${cls ? ` ${cls}` : ""}" aria-hidden="true">${esc((u.display_name || u.username).trim().slice(0, 1).toUpperCase())}${u.avatar_url ? `<img src="${esc(u.avatar_url)}" alt="" loading="lazy" decoding="async">` : ""}</span>`;

// Keep the initial visible if a removed or unavailable picture fails to load.
document.addEventListener("error", (event) => {
  const image = event.target;
  if (image instanceof HTMLImageElement && image.matches(".avatar > img")) image.remove();
}, true);

// The author of a message or a member in a list: a click offers to write to them (people.ts).
export const nameButton = (
  u: { username: string; display_name: string; avatar_url?: string | null },
  actor: string | null | undefined,
  cls = "author",
) =>
  actor
    ? `<button type="button" class="${cls} name-button" data-user="${esc(actor)}" data-username="${esc(u.username)}" data-name="${esc(u.display_name)}" data-avatar="${esc(u.avatar_url || "")}" title="About ${esc(u.display_name)}">${esc(u.display_name)}</button>`
    : `<strong class="${cls}">${esc(u.display_name)}</strong>`;
// Whether this account may see everyone on the instance: its role's grant, or being an administrator.
export const listsMembers = () =>
  !!(state.session.user?.admin || state.session.user?.list_members);
// The handle beside a name; a channel that hides handles sends none.
export const handleTag = (username: string) =>
  username ? `<span class="handle">@${esc(username)}</span>` : "";
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
export const channelIcon = (c: Channel, badges = true) =>
  isFusion()
    ? icon(c.mode === "topical" ? "folder" : c.mode === "threaded" ? "needle-thread" : "hash") + (!badges ? "" : c.remote_actor ? `<span class="mode-tag" title="On another instance" aria-label="On another instance">${icon("globe")}</span>` : c.visibility === "members" ? `<span class="mode-tag" title="Members only" aria-label="Members only">${icon("lock")}</span>` : "")
    : icon(c.remote_actor ? "globe" : c.visibility === "members" ? "lock" : "hash");
export const canModerate = (c: Channel) =>
  !c.remote_actor &&
  (!!state.session.user?.admin ||
    ["owner", "moderator"].includes(c.role || ""));

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
export const sameDay = (a: string, b: string) =>
  dayKey(new Date(a)) === dayKey(new Date(b));
export const clock = (ts: string) =>
  new Date(ts).toLocaleTimeString([], hour12()
    ? { hour: "numeric", minute: "2-digit", hour12: true }
    : { hour: isFusion() ? "2-digit" : "numeric", minute: "2-digit", hourCycle: "h23" });
export const full = (ts: string) => new Date(ts).toLocaleString([], { hour12: hour12() });
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
        ? markEmoji(esc(part.text))
        : "emoji" in part
          ? `<span class="emoji" title=":${esc(part.name)}:">${esc(part.emoji)}</span>`
          : `<img class="custom-emoji" src="${esc(part.url)}" alt=":${esc(part.name)}:"${part.kind ? emojiData(part, esc) : ` title=":${esc(part.name)}:"`}>`,
    )
    .join("");
}
// A custom emoji that is not in the reader's own set yet (someone's personal one, or one from
// another server) can be kept: its id, if so.
export function adoptable(img: Element) {
  const id = /^\/api\/emojis\/([^/]+)\/image$/.exec(img.getAttribute("src") || "")?.[1];
  return id && !state.emojis.some((e) => e.id === id) ? id : null;
}
// Whether the reader is using a finger, which cannot hover: what a mouse finds by pointing is
// then shown by a tap, and <html class="touch"> says so to the stylesheet. A screen that takes
// both goes by whichever was used last.
let fingers = typeof matchMedia !== "undefined" && matchMedia("(hover: none)").matches;
export const touch = () => fingers;
if (typeof document !== "undefined") {
  const set = (on: boolean) => document.documentElement.classList.toggle("touch", (fingers = on));
  set(fingers);
  // A tap's pointerdown comes before the mouse events made up for it, so nothing is revealed
  // by their hover in time to take the tap.
  document.addEventListener("pointerdown", (e) => e.pointerType !== "pen" && set(e.pointerType === "touch"), true);
  document.addEventListener("pointermove", (e) => e.pointerType === "mouse" && fingers && set(false), true);
}
// Hovering over an emoji enlarges it and gives its shortcode: for a standard emoji every
// shortcode it answers to, for a custom one whose it is and where it comes from. The pointer
// can move onto the card, where clicking the picture keeps an emoji that can be kept.
// By touch a tap on an emoji in a message brings the card up, and so does holding a reaction,
// whose tap is the reaction itself.
function standardCard(span: HTMLElement) {
  // The card stands in for the tooltip, which would otherwise come up over it.
  const title = span.getAttribute("title");
  if (title) span.dataset.name = title.replaceAll(":", "");
  span.removeAttribute("title");
  const glyph = span.textContent || "",
    names = emojiNames(glyph),
    name = span.dataset.name || names[0],
    also = names.filter((n) => n !== name);
  return name
    ? `<span class="ec-glyph">${esc(glyph)}</span><div class="ec-text"><strong>:${esc(name)}:</strong><span class="ec-kind">Standard emoji</span>${also.length ? `<span class="ec-kind">Also ${also.map((n) => `:${esc(n)}:`).join(" ")}</span>` : ""}</div>`
    : "";
}
if (typeof document !== "undefined") {
  let card: HTMLElement | null = null,
    shown: Element | null = null,
    leaving = 0;
  const hide = () => {
    clearTimeout(leaving);
    card?.remove();
    card = shown = null;
  };
  // Long enough to cross the gap between the emoji and its card.
  const leave = () => {
    clearTimeout(leaving);
    leaving = window.setTimeout(hide, 35);
  };
  const place = (at: DOMRect) => {
    const box = card!.getBoundingClientRect(),
      left = Math.max(8, Math.min(innerWidth - box.width - 8, at.left + at.width / 2 - box.width / 2)),
      top = at.top - box.height - 4 < 8 ? at.bottom + 4 : at.top - box.height - 4;
    card!.style.left = `${left}px`;
    card!.style.top = `${top}px`;
  };
  const show = (img: HTMLElement) => {
    clearTimeout(leaving);
    if (shown === img && card) return;
    hide();
    if (!(img instanceof HTMLImageElement)) {
      const html = standardCard(img);
      if (!html) return;
      shown = img;
      card = document.createElement("div");
      card.className = "emoji-card";
      card.innerHTML = html;
      document.body.append(card);
      card.addEventListener("mouseenter", () => clearTimeout(leaving));
      card.addEventListener("mouseleave", leave);
      return place(img.getBoundingClientRect());
    }
    shown = img;
    const { kind, origin, owner } = img.dataset,
      name = (img.getAttribute("alt") || "").replaceAll(":", ""),
      what = kind === "personal" ? "Personal emoji" : kind === "instance" ? "Instance emoji" : "Custom emoji",
      where = origin ? ` on ${esc(origin)}` : "",
      id = adoptable(img),
      picture = `<img src="${esc(img.getAttribute("src") || "")}" alt="">`;
    card = document.createElement("div");
    card.className = "emoji-card";
    card.innerHTML = `${id ? `<button type="button" class="ec-keep" aria-label="Keep :${esc(name)}:" title="Keep this emoji">${picture}</button>` : picture}<div class="ec-text"><strong>:${esc(name)}:</strong><span class="ec-kind">${what}</span>${kind || origin ? `<span class="ec-kind">${kind === "personal" && owner ? `From ${esc(owner)}${where}` : `From ${esc(origin || "this instance")}`}</span>` : ""}${id ? `<span class="ec-hint">${fingers ? "Tap" : "Click"} the picture to keep it</span>` : ""}</div>`;
    document.body.append(card);
    card.addEventListener("mouseenter", () => clearTimeout(leaving));
    card.addEventListener("mouseleave", leave);
    card.querySelector(".ec-keep")?.addEventListener("click", () => {
      hide();
      adoptEmojiDialog({ id: id!, name });
    });
    place(img.getBoundingClientRect());
  };
  const emoji = "img.custom-emoji, span.emoji";
  // Only where an emoji was used: not where one is being chosen, listed or summarised.
  const used = (at: Element | null) => {
    const img = at?.closest?.(".reaction")?.querySelector<HTMLElement>(emoji) || at?.closest?.<HTMLElement>(emoji);
    return img && !img.closest(".emoji-picker, .emoji-suggest, .emoji-sample, .reply-context, dialog") ? img : null;
  };
  document.addEventListener("mouseover", (e) => {
    // A tap is followed by a made-up mouseover: the card is not for that to show or hide.
    if (fingers) return;
    const at = e.target as Element | null,
      img = used(at);
    if (img) show(img);
    else if (card && !card.contains(at)) leave();
  });
  document.addEventListener("click", (e) => {
    const img = fingers ? used(e.target as Element) : null;
    if (img && !img.closest(".reaction")) show(img);
  });
  document.addEventListener("focusin", e => {
    if (!fingers && (e.target as Element).closest?.(".reaction")) {
      const img = used(e.target as Element);
      if (img) show(img);
    }
  });
  document.addEventListener("focusout", e => {
    if ((e.target as Element).closest?.(".reaction") && !card?.contains(e.relatedTarget as Node | null)) leave();
  });
  document.addEventListener("contextmenu", e => {
    if (!(e.target as Element).closest?.(".reaction")) return;
    const img = used(e.target as Element);
    if (img) { e.preventDefault(); e.stopPropagation(); show(img); }
  }, true);
  // A reaction held for a moment shows its card; the tap that lifting would make is dropped.
  let holding = 0,
    held = false;
  const release = () => clearTimeout(holding);
  document.addEventListener(
    "pointerdown",
    (e) => {
      const at = e.target as Element;
      release();
      held = false;
      if (e.pointerType !== "touch") return;
      if (card && !card.contains(at) && used(at) !== shown) hide();
      const img = at.closest?.(".reaction")?.querySelector<HTMLElement>(emoji);
      if (!img) return;
      const { clientX: x, clientY: y } = e;
      const moved = (m: PointerEvent) => Math.hypot(m.clientX - x, m.clientY - y) > 10 && done();
      const done = () => {
        release();
        document.removeEventListener("pointermove", moved, true);
      };
      document.addEventListener("pointermove", moved, true);
      holding = window.setTimeout(() => {
        done();
        held = true;
        show(img);
      }, 450);
    },
    true,
  );
  for (const type of ["pointerup", "pointercancel"]) document.addEventListener(type, release, true);
  document.addEventListener(
    "click",
    (e) => {
      if (!held) return;
      held = false;
      if (!(e.target as Element).closest?.(".reaction")) return;
      e.preventDefault();
      e.stopPropagation();
    },
    true,
  );
  // Holding is ours there: not the browser's menu for the picture or the text.
  document.addEventListener("contextmenu", (e) => {
    if (fingers && (e.target as Element).closest?.(".reaction")) e.preventDefault();
  });
  document.addEventListener("mouseleave", leave);
  document.addEventListener("scroll", hide, true);
  document.addEventListener("keydown", (e) => e.key === "Escape" && hide());
}
// A message as it is shown: Markdown, with emoji.
export const richHtml = (body: string, emojis = state.emojis) =>
  markdownHtml(body, emojis);
// A message made of nothing but a few emoji (typed, shortcode or custom) is shown larger.
const bareEmoji =
  /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[‍️\u{1f3fb}-\u{1f3ff}⃣]|\s)+$/u;
export function emojiOnly(body: string, emojis = state.emojis) {
  let count = 0;
  for (const part of emojiParts(body, emojis)) {
    if ("text" in part) {
      if (!part.text.trim()) continue;
      if (!bareEmoji.test(part.text)) return false;
      count += [...part.text.replace(/[\s‍️]/gu, "")].length;
    } else count++;
  }
  return count > 0 && count <= 10;
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
// Before joining somewhere, what joining shares, to be acknowledged. Each line is markup.
export function shareDialog(title: string, shared: string[], label: string) {
  return new Promise<boolean>((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "card dialog share-dialog";
    dialog.innerHTML = `<h2>${esc(title)}</h2><p class="muted">Joining shares this about you:</p><ul>${shared.map((line) => `<li>${line}</li>`).join("")}</ul><form method="dialog" class="row end"><button value="no" class="secondary">Cancel</button><button value="yes">${esc(label)}</button></form>`;
    document.body.append(dialog);
    dialog.addEventListener("close", () => {
      dialog.remove();
      resolve(dialog.returnValue === "yes");
    });
    dialog.showModal();
  });
}
// What a member's verified socials are, in a line of a share dialog.
function socialsLine(seen: string) {
  const user = state.session.user!,
    count = user.verified_socials.length;
  return !count
    ? ""
    : user.share_socials
      ? `Your ${count} verified social${count === 1 ? "" : "s"}, ${seen}: only that your identity provider verified them. Turn this off under <a href="#/settings/personal/profile">Profile</a>.`
      : "Not your verified socials: you chose not to share them.";
}
// What joining a channel hosted here shares, given what the channel shows its members.
export function channelShares(c: Channel) {
  const user = state.session.user!,
    readers = c.visibility === "members" ? "to its members" : "to everyone who can read it",
    few = "only to its owner, its moderators and the members they allow";
  return [
    ...(!c.hide_handles && c.show_members
      ? [
          `Your display name, <strong>${esc(user.display_name)}</strong>, your handle, <strong>@${esc(user.username)}</strong>, your profile picture and that you are a member, ${readers}.`,
        ]
      : [
          `Your display name, <strong>${esc(user.display_name)}</strong>, and profile picture, on what you write, ${readers}.`,
          `Your handle, <strong>@${esc(user.username)}</strong>, ${c.hide_handles ? few : readers}.`,
          `That you are a member, ${c.show_members ? readers : few}.`,
        ]),
    c.show_members ? socialsLine(readers) : socialsLine(few),
    c.federation_enabled
      ? `This channel is federated: what you write goes, with your name and your address <strong>@${esc(user.username)}@${esc(state.session.instance)}</strong>, to the instances and XMPP servers of the people following it.`
      : "",
    c.bridge_room
      ? `It is bridged with the XMPP room <strong>${esc(c.bridge_room)}</strong>: what you write is repeated there under your XMPP address.`
      : "",
  ].filter(Boolean);
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
// Someone else's emoji, found in a message: keep a copy as your own shortcode, or
// (as an administrator) for everyone on this instance.
export function adoptEmojiDialog(emoji: { id: string; name: string }) {
  const admin = !!state.session.user?.admin,
    taken = new Set(state.emojis.map((e) => e.name));
  let name = emoji.name;
  for (let n = 2; taken.has(name); n++) name = `${emoji.name}_${n}`;
  const dialog = document.createElement("dialog");
  dialog.className = "card dialog";
  dialog.innerHTML = `<h2>Keep this emoji</h2><p class="muted row"><img class="custom-emoji big" src="/api/emojis/${esc(emoji.id)}/image" alt=""><span>Shown in the message as <code>:${esc(emoji.name)}:</code>.</span></p>
    <form class="stack"><label>Shortcode<input name="name" value="${esc(name)}" required maxlength="64" pattern="[a-z0-9][a-z0-9_\-]*" autocomplete="off" autocapitalize="none" spellcheck="false"></label>
    ${admin ? `<fieldset class="stack"><legend>Keep it</legend><label class="check"><input type="radio" name="scope" value="personal" checked> For me only</label><label class="check"><input type="radio" name="scope" value="instance"> For everyone on this instance</label></fieldset>` : ""}
    <p class="form-error" role="alert"></p><div class="row end"><button type="button" class="secondary" data-cancel>Cancel</button><button>Keep emoji</button></div></form>`;
  document.body.append(dialog);
  const form = $<HTMLFormElement>("form", dialog);
  $("[data-cancel]", dialog).addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => dialog.remove());
  onSubmit(form, async (data) => {
    const scope = (data.get("scope") as string) || "personal";
    await api(`/emojis/${emoji.id}/adopt`, "POST", { name: data.get("name"), scope });
    state.emojis = await api<CustomEmoji[]>("/emojis");
    dialog.close();
    toast(scope === "instance" ? "Emoji added to the instance." : "Emoji saved to your set.");
  });
  dialog.showModal();
  $<HTMLInputElement>("input", dialog).select();
}
// A small panel floating by the thing that opened it; one at a time, gone on a click elsewhere or Escape.
let closePopup: (() => void) | null = null;
export const roleLabel = (role: string | null | undefined) =>
  role === "owner" ? "Owner" : role === "moderator" ? "Moderator" : role === "member" ? "Member" : "Not a member";
export function popup(anchor: HTMLElement, html: string, at?: { x: number; y: number }) {
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
  if (at) {
    // Opened by a right click: a corner of it under the pointer, the top left one unless the panel
    // would run off the right or the bottom of the screen.
    panel.style.left = `${Math.max(8, at.x + width + 8 > innerWidth ? at.x - width : at.x)}px`;
    panel.style.top = `${Math.max(8, at.y + height + 8 > innerHeight ? at.y - height : at.y)}px`;
  } else {
    panel.style.left = `${Math.max(8, Math.min(box.left, innerWidth - width - 8))}px`;
    panel.style.top = `${Math.max(8, Math.min(innerHeight - height - 8,
      box.bottom + height + 8 > innerHeight && box.top > height + 8 ? box.top - height - 4 : box.bottom + 4))}px`;
  }
  const away = (e: Event) => {
    const at = e.target as Node;
    if (
      e instanceof KeyboardEvent
        ? e.key === "Escape"
        : !panel.contains(at) && !anchor.contains(at)
    ) {
      close();
      if (e instanceof KeyboardEvent) {
        e.preventDefault();
        anchor.focus();
      }
    }
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
  panel.addEventListener("keydown", (e) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const choices = [...panel.querySelectorAll<HTMLElement>("button:not(:disabled), a[href]")];
    if (!choices.length) return;
    e.preventDefault();
    const index = choices.indexOf(document.activeElement as HTMLElement);
    const next = e.key === "Home" ? 0 : e.key === "End" ? choices.length - 1
      : (index + (e.key === "ArrowDown" ? 1 : -1) + choices.length) % choices.length;
    choices[next].focus();
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
