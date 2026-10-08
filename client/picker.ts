import { gemoji } from "gemoji";
import { $, $$, esc, emojiHtml, state } from "./shared.js";

// The emoji picker: a panel floating over the compose box it was opened from
// (its .picker-host). One at a time; Escape or a click elsewhere closes it.
interface Entry {
  name: string;
  char: string;
  words: string;
}
const categories = new Map<string, Entry[]>();
for (const g of gemoji) {
  if (!categories.has(g.category)) categories.set(g.category, []);
  categories.get(g.category)!.push({
    name: g.names[0],
    char: g.emoji,
    words: [...g.names, ...g.tags, g.description].join(" ").toLowerCase(),
  });
}
const standard = [...categories.values()].flat();
const byName = new Map(standard.map((e) => [e.name, e]));

const RECENT = "archipel-emoji-recent";
function recent(): string[] {
  try {
    const names = JSON.parse(localStorage.getItem(RECENT) || "[]");
    return Array.isArray(names)
      ? names.filter((n) => typeof n === "string")
      : [];
  } catch {
    return [];
  }
}
function remember(name: string) {
  try {
    localStorage.setItem(
      RECENT,
      JSON.stringify([name, ...recent().filter((n) => n !== name)].slice(0, 24)),
    );
  } catch {
    /* Recently used emoji are a convenience only. */
  }
}

let closeOpen: (() => void) | null = null;
export const closePicker = () => closeOpen?.();

const button = (name: string) => {
  const e = byName.get(name);
  return `<button type="button" class="ep-emoji" data-emoji="${esc(name)}" title=":${esc(name)}:" aria-label=":${esc(name)}:">${e ? esc(e.char) : emojiHtml(`:${name}:`)}</button>`;
};
const section = (id: string, title: string, names: string[]) =>
  names.length
    ? `<section data-section="${esc(id)}"><h3>${esc(title)}</h3><div class="ep-grid">${names.map(button).join("")}</div></section>`
    : "";

export function togglePicker(opener: HTMLElement, target: HTMLTextAreaElement) {
  const wasOpen = opener.getAttribute("aria-expanded") === "true";
  closePicker();
  if (wasOpen) return;
  const host = opener.closest<HTMLElement>(".picker-host")!;
  const custom = state.emojis.map((e) => e.name);
  const known = new Set([...custom, ...byName.keys()]);
  const used = recent().filter((n) => known.has(n));
  const tabs: [string, string, string][] = [
    ...(used.length ? [["recent", "Recently used", "🕘"] as [string, string, string]] : []),
    ...(custom.length
      ? [["custom", "Custom", "★"] as [string, string, string]]
      : []),
    ...[...categories].map(
      ([name, list]) => [name, name, list[0].char] as [string, string, string],
    ),
  ];
  const panel = document.createElement("div");
  panel.className = "emoji-picker";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Emoji");
  panel.innerHTML = `<input type="search" class="ep-search" placeholder="Search emoji" aria-label="Search emoji" autocomplete="off">
    <div class="ep-tabs">${tabs.map(([id, title, char]) => `<button type="button" data-tab="${esc(id)}" title="${esc(title)}" aria-label="${esc(title)}">${esc(char)}</button>`).join("")}</div>
    <div class="ep-scroll"></div><div class="ep-foot muted small">Pick an emoji</div>`;
  const search = $<HTMLInputElement>(".ep-search", panel),
    scroll = $(".ep-scroll", panel),
    foot = $(".ep-foot", panel);
  const all =
    section("recent", "Recently used", used) +
    section("custom", "Custom", custom) +
    [...categories]
      .map(([name, list]) =>
        section(
          name,
          name,
          list.map((e) => e.name),
        ),
      )
      .join("");
  function draw() {
    const query = search.value.trim().toLowerCase().replaceAll(":", "");
    $(".ep-tabs", panel).hidden = !!query;
    if (!query) {
      scroll.innerHTML = all;
      return;
    }
    const names = [
      ...custom.filter((n) => n.includes(query)),
      ...standard.filter((e) => e.words.includes(query)).map((e) => e.name),
    ].slice(0, 160);
    scroll.innerHTML = names.length
      ? `<div class="ep-grid">${names.map(button).join("")}</div>`
      : '<p class="muted small ep-none">No matching emoji.</p>';
    scroll.scrollTop = 0;
  }
  function close() {
    document.removeEventListener("pointerdown", outside, true);
    panel.remove();
    opener.setAttribute("aria-expanded", "false");
    closeOpen = null;
  }
  function outside(e: Event) {
    const at = e.target as Node;
    if (!panel.contains(at) && !opener.contains(at)) close();
  }
  function pick(name: string, keep: boolean) {
    target.setRangeText(
      `:${name}:`,
      target.selectionStart,
      target.selectionEnd,
      "end",
    );
    target.dispatchEvent(new Event("input", { bubbles: true }));
    remember(name);
    if (keep) return;
    close();
    target.focus();
  }
  search.addEventListener("input", draw);
  panel.addEventListener("click", (e) => {
    const at = e.target as Element;
    const emoji = at.closest<HTMLElement>("[data-emoji]");
    if (emoji) return pick(emoji.dataset.emoji!, (e as MouseEvent).shiftKey);
    const tab = at.closest<HTMLElement>("[data-tab]");
    if (tab)
      $$("[data-section]", scroll)
        .find((s) => s.dataset.section === tab.dataset.tab)
        ?.scrollIntoView({ block: "start" });
  });
  const preview = (e: Event) => {
    const emoji = (e.target as Element).closest<HTMLElement>("[data-emoji]");
    if (emoji)
      foot.innerHTML = `<span class="ep-big">${emoji.innerHTML}</span> :${esc(emoji.dataset.emoji)}:`;
  };
  panel.addEventListener("mouseover", preview);
  panel.addEventListener("focusin", preview);
  panel.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
      target.focus();
      return;
    }
    if (!e.key.startsWith("Arrow")) return;
    const cells = $$(".ep-emoji", scroll);
    if (!cells.length) return;
    const at = cells.indexOf(document.activeElement as HTMLElement);
    if (at < 0) {
      if (e.key !== "ArrowDown") return;
      e.preventDefault();
      cells[0].focus();
      return;
    }
    e.preventDefault();
    // The cell above or below is the nearest one in the next row at the same x.
    const here = cells[at].getBoundingClientRect();
    let next = at;
    if (e.key === "ArrowLeft") next = at - 1;
    else if (e.key === "ArrowRight") next = at + 1;
    else {
      const step = e.key === "ArrowDown" ? 1 : -1;
      let row: number | null = null;
      for (let i = at + step; i >= 0 && i < cells.length; i += step) {
        const r = cells[i].getBoundingClientRect();
        if (Math.abs(r.top - here.top) < 2) continue;
        if (row === null) row = r.top;
        if (Math.abs(r.top - row) > 2) break;
        next = i;
        if (step > 0 ? r.left >= here.left - 2 : r.left <= here.left + 2) break;
      }
      if (next === at && step < 0) return search.focus();
    }
    cells[Math.max(0, Math.min(cells.length - 1, next))].focus();
  });
  draw();
  host.append(panel);
  opener.setAttribute("aria-expanded", "true");
  closeOpen = close;
  document.addEventListener("pointerdown", outside, true);
  panel.scrollIntoView({ block: "nearest" });
  search.focus({ preventScroll: true });
}
