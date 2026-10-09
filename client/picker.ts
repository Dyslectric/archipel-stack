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

// Picks into a compose box, or hands the chosen name to a function (a reaction).
export function togglePicker(
  opener: HTMLElement,
  target: HTMLTextAreaElement | ((name: string) => void),
) {
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
    if (typeof target === "function") {
      remember(name);
      close();
      opener.focus();
      return target(name);
    }
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
      (typeof target === "function" ? opener : target).focus();
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
  // Beside an inline form the panel opens below; it opens above when the room below
  // is short, so the timeline does not have to scroll to make space.
  const below = host.matches(".inline-form");
  panel.classList.toggle("below", below);
  const box = host.getBoundingClientRect(),
    room = { above: box.top - 8, below: innerHeight - box.bottom - 8 },
    need = panel.offsetHeight,
    side = below ? "below" : "above",
    other = below ? "above" : "below";
  if (room[side] < need && room[other] > room[side])
    panel.classList.toggle("below", other === "below");
  if (room.above < need && room.below < need)
    panel.scrollIntoView({ block: "nearest" });
  search.focus({ preventScroll: true });
}

// Candidates above a compose box while a shortcode is being typed (":sm"): arrows to move,
// Enter or Tab to take one, Escape to dismiss. Clicking one works too.
export function suggestShortcodes(area: HTMLTextAreaElement) {
  const host = area.closest<HTMLElement>(".picker-host");
  if (!host) return;
  const list = document.createElement("div");
  list.className = "emoji-suggest";
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "Emoji suggestions");
  list.hidden = true;
  host.append(list);
  let names: string[] = [],
    at = 0,
    start = 0;
  const hide = () => {
    list.hidden = true;
    names = [];
  };
  const draw = () => {
    list.innerHTML = names
      .map(
        (n, i) =>
          `<button type="button" role="option" class="es-item${i === at ? " on" : ""}" aria-selected="${i === at}" data-name="${esc(n)}"><span class="es-glyph">${byName.has(n) ? esc(byName.get(n)!.char) : emojiHtml(`:${n}:`)}</span><span>:${esc(n)}:</span></button>`,
      )
      .join("");
    $(".on", list)?.scrollIntoView({ block: "nearest" });
  };
  const update = () => {
    const caret = area.selectionStart,
      match = /(^|[\s(])(:([a-z0-9_+-]{2,}))$/i.exec(area.value.slice(0, caret));
    if (!match || area.selectionEnd !== caret) return hide();
    const query = match[3].toLowerCase(),
      all = [...state.emojis.map((e) => e.name), ...standard.map((e) => e.name)],
      found = [
        ...all.filter((n) => n.startsWith(query)),
        ...all.filter((n) => !n.startsWith(query) && n.includes(query)),
      ];
    names = [...new Set(found)].slice(0, 8);
    if (!names.length) return hide();
    start = caret - match[2].length;
    at = 0;
    list.hidden = false;
    draw();
  };
  const take = (name: string) => {
    area.setRangeText(`:${name}: `, start, area.selectionStart, "end");
    hide();
    remember(name);
    area.dispatchEvent(new Event("input", { bubbles: true }));
    area.focus();
  };
  area.addEventListener("input", update);
  area.addEventListener("click", update);
  area.addEventListener("blur", () => setTimeout(hide, 120));
  area.addEventListener(
    "keydown",
    (e) => {
      if (list.hidden || e.isComposing) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        at = (at + (e.key === "ArrowDown" ? 1 : names.length - 1)) % names.length;
        draw();
      } else if (e.key === "Enter" || e.key === "Tab") take(names[at]);
      else if (e.key === "Escape") hide();
      else return;
      e.preventDefault();
      e.stopImmediatePropagation();
    },
    true,
  );
  list.addEventListener("mousedown", (e) => {
    const item = (e.target as Element).closest<HTMLElement>("[data-name]");
    if (!item) return;
    e.preventDefault();
    take(item.dataset.name!);
  });
}
