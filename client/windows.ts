import { esc, icon } from "./shared.js";

// A Fusion window: a title bar to drag it by, a body, and a row of buttons, around one form.
export const windowHtml = (heading: string, title: string, body: string, actions: string, close = "Close") =>
  `<form><div class="dialog-heading"><h2 id="${heading}">${esc(title)}</h2><button type="button" class="icon-button" data-close-window aria-label="${esc(close)}">${icon("x")}</button></div><div class="window-body">${body}<p class="form-error" role="alert"></p></div><div class="window-actions">${actions}</div></form>`;
let opened = 0;
// One that is made when asked for and gone when closed.
export function openWindow(title: string, body: string, actions: string, cls = "") {
  const dialog = document.createElement("dialog"), heading = `window-${++opened}`;
  dialog.className = `fusion-window ${cls}`;
  dialog.setAttribute("aria-labelledby", heading);
  dialog.innerHTML = windowHtml(heading, title, body, actions);
  document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove());
  dialog.showModal();
  return dialog;
}
document.addEventListener("click", (event) => {
  (event.target as Element).closest("[data-close-window]")?.closest("dialog")?.close();
});

// Any modal dialog moves by its title: the bar of a window, or the heading a plain dialog starts with.
// It stays where it was put until it closes.
const handles = "dialog[open] > form > .dialog-heading, dialog[open] > .dialog-heading, dialog.dialog[open] > h2:first-child";
document.addEventListener("pointerdown", (event) => {
  const at = event.target as Element, bar = at.closest<HTMLElement>(handles);
  if (!bar || event.button !== 0 || at.closest("button, a, input, select, textarea")) return;
  const dialog = bar.closest("dialog")!, box = dialog.getBoundingClientRect();
  const dx = event.clientX - box.left, dy = event.clientY - box.top;
  event.preventDefault();
  bar.setPointerCapture(event.pointerId);
  const move = (e: PointerEvent) => {
    // Enough of the bar stays on screen to take hold of it again.
    const left = Math.min(Math.max(e.clientX - dx, 80 - box.width), innerWidth - 80),
      top = Math.min(Math.max(e.clientY - dy, 0), innerHeight - bar.offsetHeight);
    Object.assign(dialog.style, { margin: "0", left: `${left}px`, top: `${top}px`, right: "auto", bottom: "auto" });
  };
  const drop = () => {
    bar.removeEventListener("pointermove", move);
    bar.removeEventListener("pointerup", drop);
    bar.removeEventListener("pointercancel", drop);
  };
  bar.addEventListener("pointermove", move);
  bar.addEventListener("pointerup", drop);
  bar.addEventListener("pointercancel", drop);
  dialog.addEventListener("close", () => dialog.removeAttribute("style"), { once: true });
});
