import { action, api, esc, icon, popup, state, type Pref } from "./shared.js";
import { pushOn } from "./notify.js";

// What the reader hid and what may notify them (state.prefs). Kept with the account, so the
// choices follow the reader to other browsers.
export type PrefKind = "channel" | "dm" | "topic" | "thread";
let saving = 0;
export const isHidden = (target: string) => !!state.prefs[target]?.hidden;
// Whether something new there notifies: its own choice, else its channel's, else it does.
export const notifies = (target: string, channelId?: string) =>
  state.prefs[target]?.notify ??
  (channelId ? state.prefs[channelId]?.notify : null) ??
  true;
// The server's copy, unless a change made here is still on its way there.
export function adoptPrefs(prefs: Record<string, Pref>) {
  if (!saving) state.prefs = prefs;
}
// Shown at once; the server's answer replaces it.
export async function setPref(target: string, change: Partial<Pref>) {
  const old = state.prefs[target] || { hidden: false, notify: null };
  state.prefs = { ...state.prefs, [target]: { ...old, ...change } };
  saving++;
  try {
    state.prefs = await api<Record<string, Pref>>("/prefs", "PUT", {
      target,
      ...change,
    });
  } catch (error) {
    state.prefs = { ...state.prefs, [target]: old };
    throw error;
  } finally {
    saving--;
  }
}

const item = (name: string, label: string, ico: string, on = false) =>
  `<button type="button" class="menu-item${on ? " on" : ""}" role="menuitem" data-pref="${name}">${icon(ico)}<span class="grow">${esc(label)}</span>${on ? icon("check") : ""}</button>`;
// The choices for one conversation or part of one, as sections of a menu.
export function prefItems(kind: PrefKind, target: string, channelId?: string) {
  const own = state.prefs[target]?.notify ?? null,
    part = kind === "topic" || kind === "thread";
  return `<div class="menu-section" role="menu"><div class="menu-label">Notify me</div>${
    part
      ? item("inherit", `As the channel does (${notifies(channelId!) ? "on" : "off"})`, "hash", own === null) +
        item("on", "Of everything new here", "bell", own === true) +
        item("off", "Never", "bell-off", own === false)
      : item("on", "Of everything new", "bell", own !== false) +
        item("off", "Never", "bell-off", own === false)
  }</div>${
    part
      ? `<div class="menu-section" role="menu">${isHidden(target) ? item("show", `Stop hiding this ${kind}`, "eye") : item("hide", `Hide this ${kind}`, "eye-off")}</div>`
      : ""
  }${
    pushOn()
      ? ""
      : `<div class="menu-section"><a class="menu-item" href="#/settings/personal/notifications">${icon("settings")}<span class="grow">Turn on notifications on this device…</span></a></div>`
  }`;
}
// Carries out a choice made in those sections. changed() redraws what shows it: at once, and
// again when the server has answered.
export function pickPref(e: Event, target: string, changed: () => void) {
  const name = (e.target as Element).closest<HTMLElement>("[data-pref]")
    ?.dataset.pref;
  const change: Partial<Pref> | null =
    name === "inherit"
      ? { notify: null }
      : name === "on"
        ? { notify: true }
        : name === "off"
          ? { notify: false }
          : name === "hide"
            ? { hidden: true }
            : name === "show"
              ? { hidden: false }
              : null;
  if (!change) return;
  action(async () => {
    const done = setPref(target, change);
    changed();
    try {
      await done;
    } finally {
      changed();
    }
  });
}
export function prefMenu(
  anchor: HTMLElement,
  kind: PrefKind,
  target: string,
  channelId: string | undefined,
  changed: () => void,
) {
  popup(anchor, prefItems(kind, target, channelId))?.addEventListener(
    "click",
    (e) => pickPref(e, target, changed),
  );
}
